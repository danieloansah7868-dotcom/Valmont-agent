import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { isSensitivePath } from "@/lib/retrieval";
import { containsLikelySecret, redactSecrets } from "@/lib/security";

export interface CommandResult {
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  output: string;
  durationMs: number;
  truncated: boolean;
}

export interface WorkspaceHandle {
  id: string;
  root: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface WorkspaceProvider {
  create(taskId: string, sourceRoot: string): Promise<WorkspaceHandle>;
  open(taskId: string): Promise<WorkspaceHandle>;
  readFile(workspace: WorkspaceHandle, relativePath: string): Promise<string>;
  readFileForCommit(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string>;
  writeFile(
    workspace: WorkspaceHandle,
    relativePath: string,
    content: string,
  ): Promise<void>;
  deleteFile(workspace: WorkspaceHandle, relativePath: string): Promise<void>;
  listChangedFiles(workspace: WorkspaceHandle): Promise<ChangedFile[]>;
  gitDiff(workspace: WorkspaceHandle): Promise<string>;
  gitStatus(workspace: WorkspaceHandle): Promise<string>;
  runValidation(
    workspace: WorkspaceHandle,
    command: string,
  ): Promise<CommandResult>;
}

interface LocalWorkspaceOptions {
  baseDirectory: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  allowedCommands?: Record<string, readonly [string, ...string[]]>;
}

const DEFAULT_ALLOWED_COMMANDS: Record<string, readonly [string, ...string[]]> =
  {
    "npm ci": ["npm", "ci", "--ignore-scripts", "--no-audit", "--fund=false"],
    "npm test": ["npm", "test"],
    "npm run lint": ["npm", "run", "lint"],
    "npm run typecheck": ["npm", "run", "typecheck"],
    "npm run build": ["npm", "run", "build"],
    "pnpm install --frozen-lockfile": [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    "pnpm test": ["pnpm", "test"],
    "pnpm lint": ["pnpm", "lint"],
    "pnpm typecheck": ["pnpm", "typecheck"],
    "cargo test": ["cargo", "test"],
    "go test ./...": ["go", "test", "./..."],
    pytest: ["pytest", "-q"],
  };

/**
 * Development-only adapter. Path and command controls reduce accidents, but host processes are not
 * a production security boundary. Production must supply an ephemeral container/sandbox adapter.
 */
export class RestrictedLocalWorkspaceProvider implements WorkspaceProvider {
  private readonly baseDirectory: string;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly allowedCommands: Record<
    string,
    readonly [string, ...string[]]
  >;

  constructor(options: LocalWorkspaceOptions) {
    this.baseDirectory = path.resolve(options.baseDirectory);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.outputLimitBytes = options.outputLimitBytes ?? 256_000;
    this.allowedCommands = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  }

  async create(taskId: string, sourceRoot: string): Promise<WorkspaceHandle> {
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(taskId))
      throw new Error("Invalid task identifier");
    await mkdir(this.baseDirectory, { recursive: true, mode: 0o700 });
    const root = path.join(this.baseDirectory, taskId);
    const resolvedSource = path.resolve(sourceRoot);
    if (
      resolvedSource === root ||
      resolvedSource.startsWith(`${root}${path.sep}`)
    ) {
      throw new Error("Workspace source must be outside the task workspace");
    }
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await cp(resolvedSource, root, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: async (source) => {
        const relative = path.relative(resolvedSource, source);
        if (relative && isSensitivePath(relative)) return false;
        const info = await lstat(source);
        return !info.isSymbolicLink();
      },
    });
    await this.runInternal(root, ["git", "init", "-q"], 15_000, 20_000);
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      [
        ".env*",
        ".npm/",
        ".next/",
        "node_modules/",
        "coverage/",
        "dist/",
        "build/",
        "target/",
        "__pycache__/",
        "*.log",
        "*.pem",
        "*.key",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await this.runInternal(root, ["git", "add", "-A"], 15_000, 20_000);
    await this.runInternal(
      root,
      [
        "git",
        "-c",
        "user.name=Valmont Agent",
        "-c",
        "user.email=agent@localhost",
        "commit",
        "-qm",
        "Workspace baseline",
        "--allow-empty",
      ],
      15_000,
      20_000,
    );
    return { id: taskId, root };
  }

  async open(taskId: string): Promise<WorkspaceHandle> {
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(taskId)) {
      throw new Error("Invalid task identifier");
    }
    const root = path.join(this.baseDirectory, taskId);
    const actual = await realpath(root);
    this.assertInside(this.baseDirectory, actual);
    const info = await lstat(actual);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Task workspace is unavailable");
    }
    return { id: taskId, root: actual };
  }

  async readFile(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    const absolute = await this.safePath(workspace, relativePath, true);
    return redactSecrets(await readFile(absolute, "utf8"));
  }

  async readFileForCommit(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    const absolute = await this.safePath(workspace, relativePath, true);
    const content = await readFile(absolute, "utf8");
    if (containsLikelySecret(content)) {
      throw new Error(
        `Potential secret detected in changed file: ${relativePath}`,
      );
    }
    return content;
  }

  async writeFile(
    workspace: WorkspaceHandle,
    relativePath: string,
    content: string,
  ): Promise<void> {
    if (isSensitivePath(relativePath))
      throw new Error("Writing sensitive paths is blocked");
    const absolute = await this.safePath(workspace, relativePath, false);
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    // Validate the created parent again to prevent symlink races/escapes.
    const parent = await realpath(path.dirname(absolute));
    this.assertInside(workspace.root, parent);
    await writeFile(absolute, content, { encoding: "utf8", mode: 0o600 });
  }

  async deleteFile(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<void> {
    const absolute = await this.safePath(workspace, relativePath, true);
    await unlink(absolute);
  }

  async listChangedFiles(workspace: WorkspaceHandle): Promise<ChangedFile[]> {
    await this.markUntrackedForDiff(workspace);
    const result = await this.runInternal(
      workspace.root,
      ["git", "diff", "--name-status", "HEAD", "--", "."],
      15_000,
      this.outputLimitBytes,
    );
    if (result.exitCode !== 0)
      throw new Error("Could not inspect changed files");
    return result.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [code, ...pathParts] = line.split("\t");
        const filePath = pathParts.at(-1);
        if (!code || !filePath || isSensitivePath(filePath)) {
          throw new Error("Git reported an unsafe changed path");
        }
        return {
          path: filePath,
          status:
            code[0] === "D"
              ? "deleted"
              : code[0] === "A"
                ? "added"
                : "modified",
        } as ChangedFile;
      });
  }

  async gitDiff(workspace: WorkspaceHandle): Promise<string> {
    await this.markUntrackedForDiff(workspace);
    const result = await this.runInternal(
      workspace.root,
      ["git", "diff", "HEAD", "--no-ext-diff", "--no-color", "--", "."],
      15_000,
      this.outputLimitBytes,
    );
    return redactSecrets(result.output);
  }

  async gitStatus(workspace: WorkspaceHandle): Promise<string> {
    const result = await this.runInternal(
      workspace.root,
      ["git", "status", "--short", "--untracked-files=all"],
      15_000,
      this.outputLimitBytes,
    );
    return redactSecrets(result.output);
  }

  async runValidation(
    workspace: WorkspaceHandle,
    command: string,
  ): Promise<CommandResult> {
    const normalized = command.trim().replace(/\s+/g, " ");
    const executable = this.allowedCommands[normalized];
    if (!executable)
      throw new Error(`Validation command is not allowlisted: ${normalized}`);
    if (/\b(?:deploy|publish|migrat|prisma\s+db\s+push)\b/i.test(normalized)) {
      throw new Error(
        "Deployments and database migrations are never run automatically",
      );
    }
    const started = Date.now();
    const runtimeHome = path.join(this.baseDirectory, ".runtime", workspace.id);
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
    const result = await this.runInternal(
      workspace.root,
      [...executable],
      this.timeoutMs,
      this.outputLimitBytes,
      runtimeHome,
    );
    return {
      command: normalized,
      status: result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "passed"
          : "failed",
      exitCode: result.exitCode,
      output: redactSecrets(result.output),
      durationMs: Date.now() - started,
      truncated: result.truncated,
    };
  }

  private async markUntrackedForDiff(
    workspace: WorkspaceHandle,
  ): Promise<void> {
    const result = await this.runInternal(
      workspace.root,
      ["git", "add", "--intent-to-add", "--", "."],
      15_000,
      20_000,
    );
    if (result.exitCode !== 0)
      throw new Error("Could not prepare workspace diff");
  }

  private async safePath(
    workspace: WorkspaceHandle,
    relativePath: string,
    mustExist: boolean,
  ): Promise<string> {
    const root = path.resolve(workspace.root);
    this.assertInside(this.baseDirectory, root);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      /[\0\r\n]/.test(relativePath)
    ) {
      throw new Error("Invalid workspace path");
    }
    const absolute = path.resolve(root, relativePath);
    this.assertInside(root, absolute);
    if (isSensitivePath(relativePath))
      throw new Error("Sensitive paths are blocked");

    if (mustExist) {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Symlinks and non-files are blocked");
      this.assertInside(root, await realpath(absolute));
    } else {
      let ancestor = path.dirname(absolute);
      while (ancestor !== root) {
        try {
          await access(ancestor, constants.F_OK);
          const info = await lstat(ancestor);
          if (info.isSymbolicLink())
            throw new Error("Symlink path components are blocked");
          this.assertInside(root, await realpath(ancestor));
          break;
        } catch (error) {
          if (error instanceof Error && error.message.includes("Symlink"))
            throw error;
          ancestor = path.dirname(ancestor);
        }
      }
    }
    return absolute;
  }

  private assertInside(rootValue: string, candidateValue: string): void {
    const root = path.resolve(rootValue);
    const candidate = path.resolve(candidateValue);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error("Path escapes isolated workspace");
    }
  }

  private runInternal(
    cwd: string,
    command: string[],
    timeoutMs: number,
    outputLimit: number,
    homeDirectory = cwd,
  ): Promise<{
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const [executable, ...args] = command;
      const child = spawn(executable!, args, {
        cwd,
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: homeDirectory,
          CI: "true",
          NODE_ENV: "test",
          npm_config_cache: path.join(homeDirectory, ".npm"),
          npm_config_ignore_scripts: "true",
          npm_config_update_notifier: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let output = "";
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const capture = (chunk: Buffer): void => {
        if (bytes >= outputLimit) {
          truncated = true;
          return;
        }
        const remaining = outputLimit - bytes;
        const slice = chunk.subarray(0, remaining);
        output += slice.toString("utf8");
        bytes += slice.length;
        if (slice.length < chunk.length) truncated = true;
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.on("error", reject);
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          output: `${output}${truncated ? "\n[output truncated by Valmont Agent]" : ""}`,
          exitCode,
          timedOut,
          truncated,
        });
      });
    });
  }
}
