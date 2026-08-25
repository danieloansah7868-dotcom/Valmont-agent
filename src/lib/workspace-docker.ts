import { spawn, type ChildProcess } from "node:child_process";
import { cp, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSensitivePath } from "@/lib/retrieval";
import { containsLikelySecret, redactSecrets } from "@/lib/security";
import {
  DEFAULT_ALLOWED_COMMANDS,
  type ChangedFile,
  type CommandResult,
  type WorkspaceHandle,
  type WorkspaceProvider,
} from "@/lib/workspace";

/**
 * Production `WorkspaceProvider` backed by one ephemeral Docker container per
 * coding task. Implements the boundary required by docs/PRODUCTION.md
 * ("Critical sandbox boundary") and docs/SECURITY.md:
 *
 * - one short-lived container per task (`valmont-sandbox-<taskId>`), destroyed
 *   with `destroy(taskId)`; a background reaper removes containers older than
 *   the configured TTL;
 * - the only writable storage is a per-task, size-limited tmpfs at
 *   `/workspace` (kernel-enforced `ENOSPC` cap; destroyed with the container)
 *   — no host filesystem, no application container, no Docker socket, no
 *   cloud credentials, and no persistent named volume to leak;
 * - read-only root filesystem; package-manager scratch (`$HOME`, `TMPDIR`)
 *   lives on the task tmpfs, not on the host;
 * - no added capabilities, no-new-privileges, and the default seccomp
 *   profile; every `docker exec` of task code runs as the unprivileged image
 *   user (the image's fixed bootstrap drops to that user before sleeping);
 * - controlled root setup operations only: `docker cp` is a root-privileged
 *   CLI operation that lands root-owned files (it has no `--chown` support),
 *   so after each copy one fixed-argv `chown` exec runs as root to restore
 *   the unprivileged owner; every file operation (read, write, delete)
 *   first verifies each path component with fixed-argv `stat` — a
 *   task-created symlink (ancestor or final target) or a non-directory
 *   ancestor is rejected before `cat`/`rm`/`docker cp` can follow it, and
 *   missing write parents are created with `mkdir -p` pointed only at the
 *   first missing ancestor, whose path above is already verified
 *   symlink-free — so setup can never follow a symlink or escape /workspace.
 *   Arbitrary task code never runs as root;
 * - CPU, memory (with no swap), PID, and per-task storage quotas, plus a
 *   per-command wall-clock timeout (`timeout --signal=KILL` inside the
 *   container) with a CLI-level fallback kill. Note: with no swap, tmpfs
 *   residency counts against the memory quota, so size
 *   `VALMONT_SANDBOX_MEMORY_BYTES` and `VALMONT_SANDBOX_STORAGE_BYTES`
 *   together for larger tasks;
 * - every provider operation for a task is serialized by an in-provider
 *   per-task queue, so no two operations — and no stat-then-use sequence
 *   within one of them — can ever overlap on the same container; operations
 *   record activity when they are enqueued, so work that is merely waiting
 *   in the queue still counts as task activity for the TTL reaper;
 * - validation cleanup: after every validation run, a fixed root exec of
 *   the provider-staged reaper script (`node
 *   /workspace/.valmont/validation-reap.mjs <start-time>`) SIGKILLs every
 *   process that started during the validation, so no validation process or
 *   background child can outlive the validation and later race the workspace
 *   paths. The cleanup is fail-closed: the script exits non-zero if it
 *   cannot compute start times, cannot inspect or signal a bounded process,
 *   or its confirmation scan still finds a live one, and the provider
 *   reports the validation as an error in that case. (PID namespaces are
 *   deliberately not used: seccomp=default allows `unshare` only with the
 *   bare `--user` flag, so no namespace-based teardown is possible under the
 *   default profile.);
 * - the reaper script is staged into a root-only `0700` directory
 *   (`0600` root-owned script) that is created fresh at creation — any
 *   `.valmont` entry supplied by the source repository is removed first —
 *   and its final ownership, mode, and type are verified with fixed-argv
 *   `stat` before the provider continues;
 * - default-deny network (`--network none`), which also blocks the cloud
 *   metadata endpoint;
 * - no environment variables are passed into the container, so GitHub, model,
 *   and session credentials never reach validation processes;
 * - the exact command allowlist shared with the development adapter
 *   (`DEFAULT_ALLOWED_COMMANDS`); deployments/migrations are rejected.
 *
 * Differences from the development adapter:
 * - file reads are captured through `docker exec cat`, so files larger than
 *   `outputLimitBytes` fail instead of being returned;
 * - the container is the containment boundary. Every exec is a direct argv
 *   (never a shell), and host-side paths are only ever fixed temp files.
 *
 * The sandbox image (sandbox/Dockerfile) is inert: it drops to the
 * unprivileged user and then runs `sleep infinity`. compose.sandbox.yaml
 * mirrors these flags exactly and is the runtime smoke-test target.
 * Selection in `createWorkspaceProvider()` is deliberately a follow-up
 * commit: enable it only after that smoke test has passed.
 */
export interface DockerWorkspaceOptions {
  image: string;
  user?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  cpuLimit?: number;
  memoryLimitBytes?: number;
  pidsLimit?: number;
  storageLimitBytes?: number;
  ttlMs?: number;
  reapIntervalMs?: number;
  allowedCommands?: Record<string, readonly [string, ...string[]]>;
  /** Test seam: replace the `docker` CLI invocation. */
  spawnOverride?: DockerSpawn;
}

export interface DockerSpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

export type DockerSpawn = (
  command: string,
  args: readonly string[],
  options: DockerSpawnOptions,
) => ChildProcess;

const nodeSpawn: DockerSpawn = (command, args, options) =>
  spawn(command, args, options);

interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  stdoutTruncated: boolean;
}

const TASK_ID = /^[a-zA-Z0-9_-]{3,80}$/;

const GIT_EXCLUDES = [
  ".env*",
  ".npm/",
  ".home/",
  ".tmp/",
  ".valmont/",
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
];

/**
 * Validation reaper, staged by the provider into the root-only
 * `/workspace/.valmont/` directory at creation and run as root (fixed argv,
 * no shell) after every validation run. It SIGKILLs every process in the
 * container that started at or after the given epoch-ms boundary — i.e.
 * everything the validation spawned, including background grandchildren —
 * so no validation process can outlive the validation and later race the
 * workspace paths. Kernel `/proc` start times are used, which are immutable
 * per process and immune to reparenting.
 *
 * Fail-closed contract (the provider treats any non-zero exit as a failed
 * cleanup): exit 2 = bad argument; exit 1 = the boot time is unreadable
 * (start times would be uncomputable), a pid could not be inspected or
 * signalled (anything but ESRCH), a start time was unparsable, or the
 * confirmation scan still finds a non-zombie process that started at or
 * after the boundary. A delivered signal is NOT treated as proof of
 * termination: kill rounds rescan until a round finds nothing new (a
 * killed process may have forked a child just before dying), and a final
 * confirmation scan requires every bounded process to be gone or a zombie
 * (dead — no execution, memory, or file descriptors; only a pid slot
 * remains until its parent reaps it). Exit 0 only when that holds.
 */
const VALIDATION_REAPER_SCRIPT = `import { readFileSync, readdirSync } from "node:fs";

const fail = (code, message) => {
  process.stderr.write("validation-reap: " + message + "\\n");
  process.exit(code);
};

const boundary = Number(process.argv[2]);
if (!Number.isInteger(boundary) || boundary <= 0) {
  fail(2, "expected a positive integer epoch-ms boundary");
}

// The boot time converts /proc start times (jiffies since boot) to epoch
// milliseconds. Without it no start time is computable — fail closed
// rather than silently skip the cleanup.
let statFile;
try {
  statFile = readFileSync("/proc/stat", "utf8");
} catch {
  fail(1, "cannot read /proc/stat; refusing to run cleanup");
}
let bootMs = 0;
for (const line of statFile.split("\\n")) {
  if (line.startsWith("btime ")) {
    bootMs = Number(line.slice(6).trim()) * 1000;
    break;
  }
}
if (!Number.isFinite(bootMs) || bootMs <= 0) {
  fail(1, "boot time unavailable; refusing to run cleanup");
}

const HZ = 100; // USER_HZ on Linux
const self = process.pid;

// Every process that started at or after the boundary, with its current
// state. A pid that vanishes between the listing and the read is gone
// (ENOENT only); any other read error means we cannot reason about it —
// fail closed.
const scan = () => {
  const targets = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === self || pid === 1) continue;
    let stat;
    try {
      stat = readFileSync("/proc/" + entry + "/stat", "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        fail(1, "cannot read /proc/" + entry + "/stat; not assuming it is safe");
      }
      continue;
    }
    // Field 2 (comm) is parenthesised and may contain spaces or parens,
    // so split after the last ')'. fields[0] is state (stat field 3);
    // fields[19] is starttime (stat field 22: jiffies since boot).
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const starttime = Number(fields[19]);
    if (!Number.isFinite(starttime)) {
      fail(1, "unparsable start time for pid " + pid);
    }
    if (bootMs + (starttime / HZ) * 1000 >= boundary) {
      targets.push({ pid, state: fields[0] });
    }
  }
  return targets;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Kill rounds: a process we kill may have forked a child just before
// dying, so rescan until a round finds nothing new. Bounded — if a
// survivor is still alive at the end, the confirmation below fails.
for (let round = 0; round < 10; round++) {
  const targets = scan();
  if (targets.length === 0) break;
  for (const { pid } of targets) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // ESRCH: gone between scan and signal. Anything else (EPERM, ...)
      // means a validation process survived and could not be killed —
      // fail closed so the provider aborts instead of leaving it in place.
      if (!error || error.code !== "ESRCH") {
        fail(
          1,
          "cannot signal pid " +
            pid +
            " (" +
            ((error && error.code) || String(error)) +
            ")",
        );
      }
    }
  }
  await sleep(150);
}

// Confirmation: a delivered signal is not proof of termination. Every
// process that started at or after the boundary must now be gone or a
// zombie (dead — holding no execution, memory, or file descriptors; only
// a pid slot until its parent reaps it). Anything still alive fails.
for (const { pid, state } of scan()) {
  if (state !== "Z") {
    fail(
      1,
      "survivor pid " + pid + " (state " + state + ") started during the validation",
    );
  }
}
process.exit(0);
`;

export class DockerWorkspaceProvider implements WorkspaceProvider {
  private readonly image: string;
  private readonly user: string;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly cpuLimit: number;
  private readonly memoryLimitBytes: number;
  private readonly pidsLimit: number;
  private readonly storageLimitBytes: number;
  private readonly ttlMs: number;
  private readonly allowedCommands: Record<
    string,
    readonly [string, ...string[]]
  >;
  private readonly spawnImpl: DockerSpawn;
  private reaperTimer?: NodeJS.Timeout;
  private reaperRunning = false;
  /**
   * Per-task operation queues: every provider operation for a task runs
   * strictly one at a time (FIFO), so one operation's stat-then-use
   * sequence can never interleave with another operation on the same task.
   */
  private readonly taskLocks = new Map<string, Promise<void>>();
  /**
   * Last provider-operation timestamp per task, recorded when the operation
   * is ENQUEUED (not when it starts executing): a task is "abandoned" (and
   * eligible for reaping) only when it has had neither an in-flight nor a
   * queued operation for longer than the TTL — a long-running or
   * backlog-heavy but still-active task is never reaped.
   */
  private readonly taskActivity = new Map<string, number>();

  constructor(options: DockerWorkspaceOptions) {
    this.image = options.image;
    this.user = options.user ?? "node";
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.outputLimitBytes = options.outputLimitBytes ?? 256_000;
    this.cpuLimit = options.cpuLimit ?? 2;
    this.memoryLimitBytes = options.memoryLimitBytes ?? 2_147_483_648;
    this.pidsLimit = options.pidsLimit ?? 256;
    this.storageLimitBytes = options.storageLimitBytes ?? 2_147_483_648;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.allowedCommands = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
    this.spawnImpl = options.spawnOverride ?? nodeSpawn;
    const reapIntervalMs = options.reapIntervalMs ?? 600_000;
    if (reapIntervalMs > 0 && this.ttlMs > 0) {
      this.reaperTimer = setInterval(() => {
        void this.reapExpired().catch(() => undefined);
      }, reapIntervalMs);
      this.reaperTimer.unref();
    }
  }

  /**
   * Build the provider from server environment variables. Environment is
   * read here (and only here) so tests can construct explicit options.
   * `DOCKER_HOST` is honoured by the docker CLI itself.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): DockerWorkspaceProvider {
    const positive = (value: string | undefined, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    return new DockerWorkspaceProvider({
      image: env.VALMONT_SANDBOX_IMAGE?.trim() || "valmont-sandbox:local",
      user: env.VALMONT_SANDBOX_USER?.trim() || "node",
      timeoutMs: Math.max(
        1_000,
        positive(env.VALMONT_COMMAND_TIMEOUT_MS, 180_000),
      ),
      cpuLimit: positive(env.VALMONT_SANDBOX_CPUS, 2),
      memoryLimitBytes: positive(
        env.VALMONT_SANDBOX_MEMORY_BYTES,
        2_147_483_648,
      ),
      pidsLimit: positive(env.VALMONT_SANDBOX_PIDS_LIMIT, 256),
      storageLimitBytes: positive(
        env.VALMONT_SANDBOX_STORAGE_BYTES,
        2_147_483_648,
      ),
      ttlMs: positive(env.VALMONT_SANDBOX_TTL_MS, 3_600_000),
      reapIntervalMs: positive(env.VALMONT_SANDBOX_REAP_INTERVAL_MS, 600_000),
    });
  }

  async create(taskId: string, sourceRoot: string): Promise<WorkspaceHandle> {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid task identifier");
    return this.withTaskLock(taskId, () => this.createCore(taskId, sourceRoot));
  }

  private async createCore(
    taskId: string,
    sourceRoot: string,
  ): Promise<WorkspaceHandle> {
    const name = this.containerName(taskId);
    await this.cleanup(taskId);
    const createArgs = [
      "create",
      "--name",
      name,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--security-opt",
      "seccomp=default",
      "--network",
      "none",
      "--cpus",
      String(this.cpuLimit),
      "--memory",
      String(this.memoryLimitBytes),
      "--memory-swap",
      String(this.memoryLimitBytes),
      "--pids-limit",
      String(this.pidsLimit),
      // Per-task storage limit: a size-capped tmpfs the kernel enforces
      // (ENOSPC) that is destroyed with the container. No `noexec`: task
      // commands execute repository tooling from /workspace.
      "--tmpfs",
      `/workspace:rw,nosuid,nodev,size=${this.storageLimitBytes}`,
      "--label",
      "valmont.managed=true",
      "--label",
      `valmont.task=${taskId}`,
      "--restart",
      "no",
      "--stop-timeout",
      "5",
      this.image,
    ];
    const created = await this.docker(
      createArgs,
      60_000,
      this.outputLimitBytes,
    );
    if (created.code !== 0) {
      throw new Error(
        `Could not create sandbox container: ${created.stderr.trim() || created.code}`,
      );
    }
    try {
      const started = await this.docker(
        ["start", name],
        30_000,
        this.outputLimitBytes,
      );
      if (started.code !== 0) {
        throw new Error(
          `Could not start sandbox container: ${started.stderr.trim() || started.code}`,
        );
      }
      await this.stageSource(taskId, sourceRoot);
      await this.installValidationReaper(taskId, name);
      await this.gitBaseline(taskId, name);
    } catch (error) {
      await this.cleanup(taskId);
      throw error;
    }
    return { id: taskId, root: "/workspace" };
  }

  async open(taskId: string): Promise<WorkspaceHandle> {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid task identifier");
    return this.withTaskLock(taskId, () => this.openCore(taskId));
  }

  private async openCore(taskId: string): Promise<WorkspaceHandle> {
    const inspected = await this.docker(
      ["inspect", "--format", "{{.State.Running}}", this.containerName(taskId)],
      15_000,
      20_000,
    );
    if (inspected.code !== 0 || inspected.stdout.trim() !== "true") {
      throw new Error("Task workspace is unavailable");
    }
    return { id: taskId, root: "/workspace" };
  }

  async readFile(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    return this.withTaskLock(workspace.id, () =>
      this.readFileCore(workspace, relativePath),
    );
  }

  private async readFileCore(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    const absolute = this.safeContainerPath(relativePath);
    const target = await this.verifyPathComponents(workspace, absolute);
    if (target === null) throw new Error("Could not read workspace file");
    const result = await this.execIn(
      workspace,
      ["cat", "--", absolute],
      15_000,
      this.outputLimitBytes,
    );
    if (result.code !== 0) throw new Error("Could not read workspace file");
    if (result.stdoutTruncated) {
      throw new Error("Workspace file exceeds the output limit");
    }
    return redactSecrets(result.stdout);
  }

  async readFileForCommit(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    return this.withTaskLock(workspace.id, () =>
      this.readFileForCommitCore(workspace, relativePath),
    );
  }

  private async readFileForCommitCore(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    const absolute = this.safeContainerPath(relativePath);
    const target = await this.verifyPathComponents(workspace, absolute);
    if (target === null) throw new Error("Could not read workspace file");
    const result = await this.execIn(
      workspace,
      ["cat", "--", absolute],
      15_000,
      this.outputLimitBytes,
    );
    if (result.code !== 0) throw new Error("Could not read workspace file");
    if (result.stdoutTruncated) {
      throw new Error("Workspace file exceeds the output limit");
    }
    const content = result.stdout;
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
    return this.withTaskLock(workspace.id, () =>
      this.writeFileCore(workspace, relativePath, content),
    );
  }

  private async writeFileCore(
    workspace: WorkspaceHandle,
    relativePath: string,
    content: string,
  ): Promise<void> {
    if (isSensitivePath(relativePath)) {
      throw new Error("Writing sensitive paths is blocked");
    }
    const absolute = this.safeContainerPath(relativePath);
    await this.prepareWriteParents(workspace, absolute);
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const temporary = path.join(scratch, "file");
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      const result = await this.docker(
        ["cp", temporary, `${this.containerName(workspace.id)}:${absolute}`],
        30_000,
        this.outputLimitBytes,
      );
      if (result.code !== 0) {
        throw new Error("Could not write workspace file");
      }
      // docker cp lands everything root-owned; fix the new file and its
      // ancestors with one controlled root chown (fixed argv, setup-only —
      // arbitrary task code never runs as root).
      const segments = absolute.split("/").filter(Boolean);
      const chownPaths: string[] = [];
      for (let i = 1; i < segments.length; i += 1) {
        chownPaths.push(`/${segments.slice(0, i).join("/")}`);
      }
      const chowned = await this.execIn(
        workspace,
        ["chown", `${this.user}:${this.user}`, ...chownPaths, absolute],
        30_000,
        20_000,
        "root",
      );
      if (chowned.code !== 0) {
        throw new Error("Could not fix workspace file ownership");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async deleteFile(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<void> {
    return this.withTaskLock(workspace.id, () =>
      this.deleteFileCore(workspace, relativePath),
    );
  }

  private async deleteFileCore(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<void> {
    const absolute = this.safeContainerPath(relativePath);
    const target = await this.verifyPathComponents(workspace, absolute);
    if (target === null) throw new Error("Could not delete workspace file");
    const result = await this.execIn(
      workspace,
      ["rm", "--", absolute],
      15_000,
      20_000,
    );
    if (result.code !== 0) throw new Error("Could not delete workspace file");
  }

  async listChangedFiles(workspace: WorkspaceHandle): Promise<ChangedFile[]> {
    return this.withTaskLock(workspace.id, () =>
      this.listChangedFilesCore(workspace),
    );
  }

  private async listChangedFilesCore(
    workspace: WorkspaceHandle,
  ): Promise<ChangedFile[]> {
    await this.markUntrackedForDiff(workspace);
    const result = await this.execIn(
      workspace,
      ["git", "diff", "--name-status", "HEAD", "--", "."],
      15_000,
      this.outputLimitBytes,
    );
    if (result.code !== 0 || result.stdoutTruncated) {
      throw new Error("Could not inspect changed files");
    }
    return result.stdout
      .trim()
      .split(/\r?\n/)
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
    return this.withTaskLock(workspace.id, () => this.gitDiffCore(workspace));
  }

  private async gitDiffCore(workspace: WorkspaceHandle): Promise<string> {
    await this.markUntrackedForDiff(workspace);
    const result = await this.execIn(
      workspace,
      ["git", "diff", "HEAD", "--no-ext-diff", "--no-color", "--", "."],
      15_000,
      this.outputLimitBytes,
    );
    if (result.code !== 0 || result.stdoutTruncated) {
      throw new Error("Could not inspect workspace diff");
    }
    return redactSecrets(result.stdout);
  }

  async gitStatus(workspace: WorkspaceHandle): Promise<string> {
    return this.withTaskLock(workspace.id, () => this.gitStatusCore(workspace));
  }

  private async gitStatusCore(workspace: WorkspaceHandle): Promise<string> {
    const result = await this.execIn(
      workspace,
      ["git", "status", "--short", "--untracked-files=all"],
      15_000,
      this.outputLimitBytes,
    );
    if (result.code !== 0 || result.stdoutTruncated) {
      throw new Error("Could not inspect workspace status");
    }
    return redactSecrets(result.stdout);
  }

  async runValidation(
    workspace: WorkspaceHandle,
    command: string,
  ): Promise<CommandResult> {
    return this.withTaskLock(workspace.id, () =>
      this.runValidationCore(workspace, command),
    );
  }

  private async runValidationCore(
    workspace: WorkspaceHandle,
    command: string,
  ): Promise<CommandResult> {
    const normalized = command.trim().replace(/\s+/g, " ");
    const executable = this.allowedCommands[normalized];
    if (!executable) {
      throw new Error(`Validation command is not allowlisted: ${normalized}`);
    }
    if (/\b(?:deploy|publish|migrat|prisma\s+db\s+push)\b/i.test(normalized)) {
      throw new Error(
        "Deployments and database migrations are never run automatically",
      );
    }
    const started = Date.now();
    const timeoutSeconds = Math.max(1, Math.floor(this.timeoutMs / 1000));
    const result = await this.execIn(
      workspace,
      ["timeout", "--signal=KILL", String(timeoutSeconds), ...executable],
      this.timeoutMs + 15_000,
      this.outputLimitBytes,
    );
    // Validation cleanup (kernel start-time based, see the script): kill
    // everything the validation started — direct children AND background
    // grandchildren — so no process it spawned can survive the validation
    // and later race the workspace paths between a stat and its use.
    // Runs under the per-task queue, so nothing else is in flight.
    const cleaned = await this.execIn(
      workspace,
      ["node", "/workspace/.valmont/validation-reap.mjs", String(started)],
      30_000,
      20_000,
      "root",
    );
    if (cleaned.code !== 0) {
      throw new Error("Could not complete validation cleanup");
    }
    if (result.timedOut) {
      // CLI-level fallback: the in-container timeout did not report in time.
      return {
        command: normalized,
        status: "timed_out",
        exitCode: null,
        output: redactSecrets(result.output),
        durationMs: Date.now() - started,
        truncated: result.truncated,
      };
    }
    return {
      command: normalized,
      status:
        result.code === 124
          ? "timed_out"
          : result.code === 0
            ? "passed"
            : "failed",
      exitCode: result.code,
      output: redactSecrets(result.output),
      durationMs: Date.now() - started,
      truncated: result.truncated,
    };
  }

  /**
   * Destroy the task container; its tmpfs workspace is removed with it. Call
   * when a task reaches a terminal state; the reaper is the backstop for
   * abandoned tasks.
   */
  async destroy(taskId: string): Promise<void> {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid task identifier");
    return this.withTaskLock(taskId, () => this.cleanup(taskId));
  }

  /** Stop the background TTL reaper (the timer is unref'd and never keeps the process alive). */
  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
  }

  /**
   * Run `fn` as the next queued operation for `taskId`. Operations are
   * strictly serialized per task (FIFO); a failed operation releases the
   * queue for the next one.
   *
   * Activity is recorded when the operation is ENQUEUED, not when it starts
   * executing: a queued-but-waiting operation already proves the task is in
   * use, so the TTL reaper can never claim the task as abandoned while work
   * is queued for it. (The reaper's own removal passes `recordActivity =
   * false` and records nothing.) `fn` receives this operation's queue-tail
   * token: the tail stored in `taskLocks` changes on every enqueue, so a
   * holder can detect — synchronously, at the moment of a destructive
   * call — that an operation enqueued after it took the lock.
   */
  private withTaskLock<T>(
    taskId: string,
    fn: (myTail: Promise<void>) => Promise<T>,
    recordActivity: boolean = true,
  ): Promise<T> {
    if (recordActivity) this.taskActivity.set(taskId, Date.now());
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    this.taskLocks.set(taskId, current);
    // Wait for the PREVIOUS operation (not `current`, whose gate only this
    // operation releases) to finish, then run; release when done.
    return previous
      .catch(() => undefined)
      .then(async () => {
        try {
          return await fn(current);
        } finally {
          release();
          if (this.taskLocks.get(taskId) === current) {
            this.taskLocks.delete(taskId);
          }
        }
      });
  }

  private containerName(taskId: string): string {
    return `valmont-sandbox-${taskId}`;
  }

  /**
   * Stage the validation reaper script into a root-only directory. Every
   * step is a fixed-argv root exec (no shell), and the result is verified
   * before the provider continues:
   *
   * 1. `rm -rf -- /workspace/.valmont` — a source repository may itself
   *    supply a `.valmont` entry (directory, file, or symlink; symlinks are
   *    already dropped host-side by staging, a plain directory is not). It
   *    is removed before anything is created, so `mkdir -m 0700` below
   *    always creates the directory fresh (its mode applies only to a
   *    directory it creates itself — it would not reset permissions on an
   *    existing one) and no task-owned or task-pointing entry can survive
   *    to redirect the root-only script to a task-writable location.
   * 2. `mkdir -m 0700` — task code can neither read nor delete the script.
   * 3. `docker cp` of the host temp file (mode 0600, preserved by the
   *    copy) — the script lands root-owned `0600`. Called after the staging
   *    `chown -R`, so nothing re-owns it.
   * 4. `stat` verification — the directory must be `0 0 700` and the script
   *    `0 0 600 regular file`; any other observation fails creation.
   *
   * Runs before the git baseline so `.valmont/` is git-excluded.
   */
  private async installValidationReaper(
    taskId: string,
    name: string,
  ): Promise<void> {
    const handle: WorkspaceHandle = { id: taskId, root: "/workspace" };
    // Remove anything the source repository supplied at this path (a plain
    // `rm -rf` on the fixed path removes a symlink itself, never follows
    // it, and cannot touch any other path).
    const cleared = await this.execIn(
      handle,
      ["rm", "-rf", "--", "/workspace/.valmont"],
      15_000,
      20_000,
      "root",
    );
    if (cleared.code !== 0) {
      throw new Error("Could not clear the validation reaper directory");
    }
    const made = await this.execIn(
      handle,
      ["mkdir", "-m", "0700", "/workspace/.valmont"],
      15_000,
      20_000,
      "root",
    );
    if (made.code !== 0) {
      throw new Error("Could not create the validation reaper directory");
    }
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const scriptPath = path.join(scratch, "validation-reap.mjs");
    try {
      await writeFile(scriptPath, VALIDATION_REAPER_SCRIPT, {
        encoding: "utf8",
        mode: 0o600,
      });
      const copied = await this.docker(
        ["cp", scriptPath, `${name}:/workspace/.valmont/validation-reap.mjs`],
        30_000,
        this.outputLimitBytes,
      );
      if (copied.code !== 0) {
        throw new Error("Could not stage the validation reaper");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    // Verify the staged result as root (fixed argv): the provider refuses
    // to continue if the reaper directory or script is not exactly what
    // the steps above produced.
    const checkedDir = await this.execIn(
      handle,
      ["stat", "-c", "%u %g %a", "/workspace/.valmont"],
      15_000,
      20_000,
      "root",
    );
    if (checkedDir.code !== 0 || checkedDir.stdout.trim() !== "0 0 700") {
      throw new Error("Could not verify the validation reaper directory");
    }
    const checkedScript = await this.execIn(
      handle,
      ["stat", "-c", "%u %g %a %F", "/workspace/.valmont/validation-reap.mjs"],
      15_000,
      20_000,
      "root",
    );
    if (
      checkedScript.code !== 0 ||
      checkedScript.stdout.trim() !== "0 0 600 regular file"
    ) {
      throw new Error("Could not verify the validation reaper script");
    }
  }

  private async stageSource(taskId: string, sourceRoot: string): Promise<void> {
    const name = this.containerName(taskId);
    const handle: WorkspaceHandle = { id: taskId, root: "/workspace" };
    const staging = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-src-"));
    try {
      const resolvedSource = path.resolve(sourceRoot);
      if (
        resolvedSource === staging ||
        resolvedSource.startsWith(`${staging}${path.sep}`)
      ) {
        throw new Error("Workspace source must be outside the task workspace");
      }
      await cp(resolvedSource, staging, {
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
      const copied = await this.docker(
        ["cp", `${staging}/.`, `${name}:/workspace/`],
        300_000,
        this.outputLimitBytes,
      );
      if (copied.code !== 0) {
        throw new Error(
          `Could not stage workspace source: ${copied.stderr.trim() || copied.code}`,
        );
      }
      // docker cp (root-privileged CLI, no --chown support) lands root-owned
      // files; one controlled root chown with a fixed argv restores the
      // unprivileged owner before any task code runs.
      const chowned = await this.execIn(
        handle,
        ["chown", "-R", `${this.user}:${this.user}`, "/workspace"],
        60_000,
        20_000,
        "root",
      );
      if (chowned.code !== 0) {
        throw new Error("Could not fix staged workspace ownership");
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async gitBaseline(taskId: string, name: string): Promise<void> {
    const handle: WorkspaceHandle = { id: taskId, root: "/workspace" };
    const initialized = await this.execIn(
      handle,
      ["git", "init", "-q"],
      15_000,
      20_000,
    );
    if (initialized.code !== 0) {
      throw new Error("Could not initialise workspace git");
    }
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const excludePath = path.join(scratch, "exclude");
    try {
      await writeFile(excludePath, GIT_EXCLUDES.join("\n"), {
        encoding: "utf8",
        mode: 0o600,
      });
      const copied = await this.docker(
        ["cp", excludePath, `${name}:/workspace/.git/info/exclude`],
        30_000,
        this.outputLimitBytes,
      );
      if (copied.code !== 0) {
        throw new Error("Could not configure workspace git exclusions");
      }
      const chowned = await this.execIn(
        handle,
        ["chown", `${this.user}:${this.user}`, "/workspace/.git/info/exclude"],
        30_000,
        20_000,
        "root",
      );
      if (chowned.code !== 0) {
        throw new Error("Could not fix git exclude ownership");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    const staged = await this.execIn(
      handle,
      ["git", "add", "-A"],
      15_000,
      20_000,
    );
    if (staged.code !== 0)
      throw new Error("Could not stage workspace baseline");
    const committed = await this.execIn(
      handle,
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
    if (committed.code !== 0) {
      throw new Error("Could not commit workspace baseline");
    }
  }

  private async markUntrackedForDiff(
    workspace: WorkspaceHandle,
  ): Promise<void> {
    const result = await this.execIn(
      workspace,
      ["git", "add", "--intent-to-add", "--", "."],
      15_000,
      20_000,
    );
    if (result.code !== 0) throw new Error("Could not prepare workspace diff");
  }

  /**
   * The type of a single in-container path component as seen by root. GNU
   * `stat` without `-L` reports the component itself, so a task-created
   * symlink comes back as `symbolic link` rather than its target's type.
   * Returns `null` when the component is missing (root cannot hit EACCES
   * inside the container, so a non-zero exit means ENOENT).
   */
  private async statComponentKind(
    workspace: WorkspaceHandle,
    componentPath: string,
  ): Promise<string | null> {
    const checked = await this.execIn(
      workspace,
      ["stat", "-c", "%F", componentPath],
      15_000,
      20_000,
      "root",
    );
    if (checked.code !== 0) return null;
    return checked.stdout.trim();
  }

  /**
   * Verify every component — ancestors AND the final target — of a
   * validated container path before `cat`/`rm` is allowed to touch it:
   * task-created symlinks (which would let a lexical path resolve outside
   * the intended directory, e.g. to /etc or another task file) are
   * rejected, as are non-directory ancestors and non-file targets. The
   * verification runs back-to-back with the operation under the per-task
   * operation queue (no other provider operation can interleave) and no
   * validation process survives its run (the post-validation reaper exec
   * SIGKILLs everything the validation started), so nothing can swap in a
   * symlink between the check and its use. Returns the final target's
   * kind, or `null` when the target does not exist, so callers keep their
   * not-found semantics.
   */
  private async verifyPathComponents(
    workspace: WorkspaceHandle,
    absolute: string,
  ): Promise<string | null> {
    const components = absolute.split("/").filter(Boolean);
    let targetKind: string | null = null;
    for (let i = 0; i < components.length; i += 1) {
      const component = `/${components.slice(0, i + 1).join("/")}`;
      const kind = await this.statComponentKind(workspace, component);
      const isTarget = i === components.length - 1;
      if (kind === "symbolic link") {
        throw new Error("Symlink path components are blocked");
      }
      if (isTarget) {
        targetKind = kind;
        if (kind !== null && kind !== "regular file") {
          throw new Error("Invalid workspace path");
        }
      } else if (kind !== "directory") {
        throw new Error("Invalid workspace path");
      }
    }
    return targetKind;
  }

  /**
   * Verify every write destination ancestor and create any that are
   * missing, so `docker cp` never fails on a non-existent parent directory.
   * Every check and creation is a fixed-argv root exec (no shell): each
   * existing ancestor must be a real directory — a task-created symlink or
   * a regular file is rejected — `mkdir -p` is only ever pointed at the
   * first missing ancestor, whose whole path is already verified
   * symlink-free, so setup can neither follow a symlink nor escape
   * /workspace. The final target is checked last: an existing symlink
   * would be followed by `docker cp` (overwriting whatever it points to),
   * so it is rejected before the copy.
   */
  private async prepareWriteParents(
    workspace: WorkspaceHandle,
    absolute: string,
  ): Promise<void> {
    const components = absolute.split("/").filter(Boolean);
    const directoryComponents = components.slice(0, -1);
    for (let i = 0; i < directoryComponents.length; i += 1) {
      const ancestor = `/${directoryComponents.slice(0, i + 1).join("/")}`;
      const kind = await this.statComponentKind(workspace, ancestor);
      if (kind === "symbolic link") {
        throw new Error("Symlink path components are blocked");
      }
      if (kind === null) {
        // Missing: nothing below it can exist, so create from here down in
        // one step; all ancestors above are verified real directories.
        const created = await this.execIn(
          workspace,
          ["mkdir", "-p", ancestor],
          15_000,
          20_000,
          "root",
        );
        if (created.code !== 0) {
          throw new Error("Could not create workspace parent directories");
        }
        return;
      }
      if (kind !== "directory") {
        throw new Error("Invalid workspace path");
      }
    }
    // All ancestors are verified real directories; reject an existing
    // symlink (or non-file) final target before docker cp follows it.
    const targetKind = await this.statComponentKind(workspace, absolute);
    if (targetKind === "symbolic link") {
      throw new Error("Symlink path components are blocked");
    }
    if (targetKind !== null && targetKind !== "regular file") {
      throw new Error("Invalid workspace path");
    }
  }

  private safeContainerPath(relativePath: string): string {
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      /[\0\r\n]/.test(relativePath)
    ) {
      throw new Error("Invalid workspace path");
    }
    const absolute = path.posix.resolve("/workspace", relativePath);
    if (absolute !== "/workspace" && !absolute.startsWith("/workspace/")) {
      throw new Error("Invalid workspace path");
    }
    if (isSensitivePath(relativePath)) {
      throw new Error("Sensitive paths are blocked");
    }
    return absolute;
  }

  private async execIn(
    workspace: WorkspaceHandle,
    argv: readonly string[],
    timeoutMs: number,
    limitBytes: number,
    user: string = this.user,
  ): Promise<DockerRunResult> {
    return this.docker(
      [
        "exec",
        "--user",
        user,
        "--workdir",
        "/workspace",
        this.containerName(workspace.id),
        ...argv,
      ],
      timeoutMs,
      limitBytes,
    );
  }

  private async cleanup(taskId: string): Promise<void> {
    await this.docker(["rm", "-f", this.containerName(taskId)], 30_000, 20_000);
  }

  private async reapExpired(): Promise<void> {
    if (this.reaperRunning) return;
    this.reaperRunning = true;
    try {
      const listed = await this.docker(
        [
          "ps",
          "-a",
          "--filter",
          "label=valmont.managed=true",
          "--format",
          '{{.ID}}\t{{.Label "valmont.task"}}',
        ],
        30_000,
        this.outputLimitBytes,
      );
      if (listed.code !== 0) return;
      for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        const [id, task] = line.split("\t");
        if (!id || !task) continue;
        if (!TASK_ID.test(task)) {
          // A managed container whose label is not a valid task identifier
          // has no queue to go through; remove it directly.
          await this.docker(["rm", "-f", id], 30_000, 20_000);
          continue;
        }
        const inspected = await this.docker(
          ["inspect", "--format", "{{.Created}}", id],
          15_000,
          20_000,
        );
        if (inspected.code !== 0) continue;
        const normalized = inspected.stdout
          .trim()
          .replace(/(\.\d{1,3})\d*Z$/, "$1Z");
        const created = Date.parse(normalized);
        if (!Number.isFinite(created)) continue;
        const lastActivity = this.taskActivity.get(task);
        // Abandoned = no provider operation for longer than the TTL. When
        // no activity is recorded (e.g. the provider process restarted),
        // fall back to the container's age — the only signal available.
        const reference = lastActivity ?? created;
        if (Date.now() - reference <= this.ttlMs) continue;
        // Removal goes through the per-task queue and re-checks activity
        // inside it, so it can never run while an operation is in flight
        // (and never sees its own removal as task activity).
        await this.withTaskLock(
          task,
          async (myTail) => {
            const fresh = this.taskActivity.get(task);
            if (fresh !== undefined && Date.now() - fresh <= this.ttlMs) {
              return;
            }
            const still = await this.docker(
              ["inspect", "--format", "{{.State.Running}}", id],
              15_000,
              20_000,
            );
            if (still.code !== 0) {
              this.taskActivity.delete(task);
              return;
            }
            // Final gate, checked synchronously immediately before the
            // destructive call. The existence check above awaited, so an
            // operation could have enqueued in that window — and it could
            // still enqueue at any earlier point before this check. The
            // queue tail changes on every enqueue, so an unchanged tail
            // proves no operation has queued since this removal took the
            // lock; and this check and the rm run back-to-back with no
            // await between them, so nothing can interleave. Deferring
            // costs at most one reaper interval; the operation that queued
            // is what the container now exists for.
            if (this.taskLocks.get(task) !== myTail) return;
            await this.docker(["rm", "-f", id], 30_000, 20_000);
            this.taskActivity.delete(task);
          },
          false,
        );
      }
    } finally {
      this.reaperRunning = false;
    }
  }

  private docker(
    args: readonly string[],
    timeoutMs: number,
    limitBytes: number,
  ): Promise<DockerRunResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const stdoutState = { value: "", bytes: 0 };
      const stderrState = { value: "", bytes: 0 };
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      const appendCapped = (
        target: { value: string; bytes: number },
        chunk: Buffer,
      ): boolean => {
        if (target.bytes >= limitBytes) return true;
        const remaining = limitBytes - target.bytes;
        const slice = chunk.subarray(0, remaining);
        target.value += slice.toString("utf8");
        target.bytes += slice.length;
        return slice.length < chunk.length;
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (appendCapped(stdoutState, chunk)) stdoutTruncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (appendCapped(stderrState, chunk)) stderrTruncated = true;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(
          new Error(`docker ${args[0] ?? "run"} failed: ${error.message}`),
        );
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const stdout = stdoutState.value;
        const stderr = stderrState.value;
        resolve({
          code: code ?? -1,
          stdout,
          stderr,
          output: [stdout, stderr].filter(Boolean).join("\n"),
          timedOut,
          truncated: stdoutTruncated || stderrTruncated,
          stdoutTruncated,
        });
      });
    });
  }
}
