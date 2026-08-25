import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, mkdtemp, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerWorkspaceProvider,
  type DockerSpawn,
  type DockerWorkspaceOptions,
} from "@/lib/workspace-docker";

const OLD_CREATED = "2020-01-01T00:00:00.000Z";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Stateful fake for the `docker`/`tar` CLIs. Container existence is tracked
 * in `containers` (create adds, a successful `rm -f` removes), so exec,
 * inspect, start, and cp on a removed container fail exactly like the real
 * daemon ("No such container" / "No such object") — the behaviour the
 * provider's lifecycle error handling relies on.
 *
 * The host-side `tar` handler enforces the provider's `--` contract:
 * without `--`, a member beginning with `-` is "parsed" as an option and
 * the archive fails (code 2), which is how GNU tar would treat an
 * injected `--add-file=...` name.
 */
interface FakeState {
  containers: Set<string>;
  createdAt: Map<string, string>;
  calls: { command: string; args: readonly string[]; stdinPath?: string }[];
  hostTarMembers: string[];
  stagedTopLevel: string[];
  statResults: Map<string, ExecResult>;
  fileContents: Map<string, ExecResult>;
  psLines: string[];
  rmErrors: Map<string, string>;
  cpDestinations: string[];
  cpFailures: number;
  onRm?: (name: string) => void;
  onInspect?: (name: string, format: string) => void;
  onExec?: (
    name: string,
    cmd: string[],
    user: string,
  ) => ExecResult | undefined;
}

function makeState(): FakeState {
  const state: FakeState = {
    containers: new Set(),
    createdAt: new Map(),
    calls: [],
    hostTarMembers: [],
    stagedTopLevel: [],
    statResults: new Map(),
    fileContents: new Map(),
    psLines: [],
    rmErrors: new Map(),
    cpDestinations: [],
    cpFailures: 0,
  };
  // Baseline: the two mounts exist with exactly the create-time flags'
  // result, and /workspace is a directory. Unregistered paths are missing.
  state.statResults.set("/workspace", {
    code: 0,
    stdout: "directory\n",
    stderr: "",
  });
  state.statResults.set("/reap", {
    code: 0,
    stdout: "0 0 701\n",
    stderr: "",
  });
  state.statResults.set("/reap/validation-reap.mjs", {
    code: 0,
    stdout: "0 0 644 regular file\n",
    stderr: "",
  });
  return state;
}

function defaultExec(state: FakeState, cmd: string[]): ExecResult {
  const last = cmd[cmd.length - 1];
  if (cmd[0] === "stat") {
    return (
      state.statResults.get(last) ?? {
        code: 1,
        stdout: "",
        stderr: `stat: cannot statx '${last}': No such file or directory\n`,
      }
    );
  }
  if (cmd[0] === "cat") {
    return (
      state.fileContents.get(last) ?? {
        code: 1,
        stdout: "",
        stderr: `cat: ${last}: No such file or directory\n`,
      }
    );
  }
  // git/tar/rm/node/timeout succeed by default; tests override per case.
  return { code: 0, stdout: "", stderr: "" };
}

function makeChild(stdout: string, stderr: string, code: number): ChildProcess {
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child = {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: new PassThrough(),
    kill: () => true,
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
      return child;
    },
  };
  setImmediate(() => {
    stdoutStream.end(stdout);
    stderrStream.end(stderr);
    for (const fn of listeners["close"] ?? []) fn(code, null);
  });
  return child as unknown as ChildProcess;
}

function makeSpawn(state: FakeState): DockerSpawn {
  return (command, args, options) => {
    state.calls.push({ command, args, stdinPath: options.stdinPath });
    let code = 0;
    let stdout = "";
    let stderr = "";
    if (command === "docker") {
      const sub = args[0];
      if (sub === "create") {
        const name = args[args.indexOf("--name") + 1];
        state.containers.add(name);
        state.createdAt.set(name, OLD_CREATED);
        stdout = "fakecontainerid\n";
      } else if (sub === "start") {
        const name = args[1];
        if (!state.containers.has(name)) {
          code = 1;
          stderr = `Error: No such container: ${name}\n`;
        } else {
          stdout = `${name}\n`;
        }
      } else if (sub === "rm") {
        const name = args[args.length - 1];
        // Synchronous hook, fired BEFORE the state change: tests use it to
        // enqueue an operation while the removal is in flight.
        state.onRm?.(name);
        const forced = state.rmErrors.get(name);
        if (forced !== undefined) {
          code = 1;
          stderr = forced;
        } else if (state.containers.has(name)) {
          state.containers.delete(name);
          state.createdAt.delete(name);
          stdout = `${name}\n`;
        } else {
          code = 1;
          stderr = `Error: No such container: ${name}\n`;
        }
      } else if (sub === "inspect") {
        const format = args[args.indexOf("--format") + 1];
        const name = args[args.length - 1];
        state.onInspect?.(name, format);
        if (format === "{{.State.Running}}") {
          if (state.containers.has(name)) stdout = "true\n";
          else {
            code = 1;
            stderr = `Error: No such object: ${name}\n`;
          }
        } else if (format === "{{.Created}}") {
          const created = state.createdAt.get(name);
          if (created) stdout = `${created}\n`;
          else {
            code = 1;
            stderr = `Error: No such object: ${name}\n`;
          }
        }
      } else if (sub === "ps") {
        stdout =
          state.psLines.length === 0 ? "" : `${state.psLines.join("\n")}\n`;
      } else if (sub === "cp") {
        const dest = args[2];
        const name = dest.split(":")[0];
        if (!state.containers.has(name)) {
          code = 1;
          stderr = `Error: No such container: ${name}\n`;
        } else if (state.cpFailures > 0) {
          state.cpFailures -= 1;
          code = 1;
          stderr = "Error: cp: daemon error\n";
        } else {
          state.cpDestinations.push(dest);
        }
      } else if (sub === "exec") {
        const name = args.find((a) => a.startsWith("valmont-sandbox-"));
        if (!name || !state.containers.has(name)) {
          code = 1;
          stderr = `Error: No such container: ${name ?? "unknown"}\n`;
        } else {
          const cmd = args.slice(args.indexOf(name) + 1);
          const user = args[args.indexOf("--user") + 1];
          const override = state.onExec?.(name, cmd, user);
          const result = override ?? defaultExec(state, cmd);
          code = result.code;
          stdout = result.stdout;
          stderr = result.stderr;
        }
      }
    } else if (command === "tar") {
      // ["-cf", archive, "-C", cwd, ("--",) member...]
      const dashIdx = args.indexOf("--");
      const cwd = args[args.indexOf("-C") + 1];
      const member =
        dashIdx === -1
          ? args.slice(args.indexOf("-C") + 2).join(" ")
          : args.slice(dashIdx + 1).join(" ");
      if (dashIdx === -1) {
        // Simulate GNU tar's option parsing: a member beginning with "-" is
        // consumed as an option — fail the way an injection attempt would.
        code = 2;
        stderr = `tar: ${member}: Invalid option\n`;
      } else {
        state.hostTarMembers.push(member);
        if (!existsSync(path.join(cwd, member))) {
          code = 2;
          stderr = `tar: ${member}: Cannot stat: No such file or directory\n`;
        } else if (member === ".") {
          state.stagedTopLevel = readdirSync(cwd);
        }
      }
    }
    return makeChild(stdout, stderr, code);
  };
}

function makeProvider(
  state: FakeState,
  extra: Partial<DockerWorkspaceOptions> = {},
): DockerWorkspaceProvider {
  return new DockerWorkspaceProvider({
    image: "test:latest",
    // Generous so activity recorded at enqueue time is still fresh after
    // the (multi-ms) create sequence; stale tests sleep past it.
    ttlMs: 400,
    spawnOverride: makeSpawn(state),
    ...extra,
  });
}

const sourceDirs: string[] = [];

async function makeSource(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "valmont-test-src-"));
  sourceDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await fsWriteFile(p, content);
  }
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Internals {
  user: string;
  reapExpired(): Promise<void>;
  taskActivity: Map<string, number>;
  taskLocks: Map<string, Promise<void>>;
}

const internals = (p: DockerWorkspaceProvider) => p as unknown as Internals;

const execCalls = (state: FakeState) =>
  state.calls.filter((c) => c.command === "docker" && c.args[0] === "exec");

const execUser = (c: { args: readonly string[] }) =>
  c.args[c.args.indexOf("--user") + 1];

const execCmd = (c: { args: readonly string[] }): string[] => {
  const idx = c.args.findIndex((a) => a.startsWith("valmont-sandbox-"));
  return c.args.slice(idx + 1);
};

const rootExecs = (state: FakeState) =>
  execCalls(state).filter((c) => execUser(c) === "root");

const taskExecs = (state: FakeState) =>
  execCalls(state).filter((c) => execUser(c) === "1000:1000");

afterEach(async () => {
  for (const dir of sourceDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("DockerWorkspaceProvider", () => {
  it("rejects root or zero uid/gid", () => {
    expect(() => new DockerWorkspaceProvider({ image: "x", uid: 0 })).toThrow(
      /uid must be a positive/,
    );
    expect(() => new DockerWorkspaceProvider({ image: "x", gid: 0 })).toThrow(
      /gid must be a positive/,
    );
    expect(() => new DockerWorkspaceProvider({ image: "x", uid: 1.5 })).toThrow(
      /uid must be a positive/,
    );
  });

  it("fromEnv never produces a root identity", () => {
    const fromEnv = (env: Record<string, string>) =>
      DockerWorkspaceProvider.fromEnv({
        VALMONT_SANDBOX_IMAGE: "test:latest",
        ...env,
      } as unknown as NodeJS.ProcessEnv);
    // uid "0" (and non-numeric values) must fall back to the non-root
    // default, never to root.
    expect(internals(fromEnv({ VALMONT_SANDBOX_UID: "0" })).user).toBe(
      "1000:1000",
    );
    expect(
      internals(fromEnv({ VALMONT_SANDBOX_UID: "0", VALMONT_SANDBOX_GID: "0" }))
        .user,
    ).toBe("1000:1000");
    expect(internals(fromEnv({ VALMONT_SANDBOX_UID: "garbage" })).user).toBe(
      "1000:1000",
    );
    // Positive values pass through unchanged.
    expect(
      internals(
        fromEnv({ VALMONT_SANDBOX_UID: "1234", VALMONT_SANDBOX_GID: "5678" }),
      ).user,
    ).toBe("1234:5678");
  });

  it("creates the container with the single numeric identity, hardening, and the /reap mount", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "app.js": "console.log(1)" });
    await provider.create("task1", src);
    const create = state.calls.find(
      (c) => c.command === "docker" && c.args[0] === "create",
    )!;
    const args = [...create.args];
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args).toContain("--init");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe(
      "no-new-privileges:true",
    );
    expect(args).toContain("seccomp=default");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    const tmpfs = args.filter((a, i) => args[i - 1] === "--tmpfs");
    expect(tmpfs).toEqual([
      "/workspace:rw,nosuid,nodev,size=2147483648,uid=1000,gid=1000",
      "/reap:rw,nosuid,nodev,mode=0701,size=1m",
    ]);
    expect(args).toContain("--label");
    expect(args).toContain("valmont.managed=true");
    expect(args).toContain("valmont.task=task1");
    expect(args[args.length - 1]).toBe("test:latest");
  });

  it("stages the source host-side with `--` and extracts it as the task user", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "app.js": "x", "lib/util.js": "y" });
    await provider.create("task1", src);
    const hostTar = state.calls.filter((c) => c.command === "tar");
    // source archive + git exclude archive
    expect(hostTar).toHaveLength(2);
    expect(hostTar[0].args[0]).toBe("-cf");
    expect(hostTar[0].args).toContain("--");
    expect(hostTar[0].args[hostTar[0].args.indexOf("--") + 1]).toBe(".");
    expect(hostTar[1].args[hostTar[1].args.indexOf("--") + 1]).toBe(
      ".git/info/exclude",
    );
    const extract = execCalls(state).find((c) => execCmd(c)[0] === "tar")!;
    expect(execUser(extract)).toBe("1000:1000");
    expect(execCmd(extract)).toEqual(["tar", "-xf", "-", "-C", "/workspace"]);
    expect(extract.stdinPath).toBeDefined();
  });

  it("drops a source-supplied .valmont before staging", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({
      "app.js": "x",
      ".valmont/rogue.js": "evil",
    });
    await provider.create("task1", src);
    expect(state.stagedTopLevel).toContain("app.js");
    expect(state.stagedTopLevel).toContain(".home");
    expect(state.stagedTopLevel).not.toContain(".valmont");
  });

  it("stages the reaper onto /reap and uses root stat as its only root exec", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "app.js": "x" });
    await provider.create("task1", src);
    const cpCall = state.calls.find(
      (c) => c.command === "docker" && c.args[0] === "cp",
    )!;
    expect(cpCall.args[2]).toBe(
      "valmont-sandbox-task1:/reap/validation-reap.mjs",
    );
    const root = rootExecs(state);
    expect(root).toHaveLength(2);
    for (const c of root) {
      const cmd = execCmd(c);
      expect(cmd[0]).toBe("stat");
      expect(cmd[cmd.length - 1]).toMatch(/^\/reap(\/|$)/);
    }
    // The reaper exec in runValidation must target the /reap path too.
    const handle = { id: "task1", root: "/workspace" };
    await provider.runValidation(handle, "npm test");
    const reaper = execCalls(state).find((c) => execCmd(c)[0] === "node")!;
    expect(reaper.args.join(" ")).toContain("/reap/validation-reap.mjs");
    expect(reaper.args.join(" ")).not.toContain(".valmont");
  });

  it("fails creation when the /reap mount or the staged script verify wrong", async () => {
    const src = await makeSource({ "a.txt": "x" });
    {
      const state = makeState();
      state.statResults.set("/reap", {
        code: 0,
        stdout: "0 0 755\n",
        stderr: "",
      });
      const provider = makeProvider(state);
      await expect(provider.create("task1", src)).rejects.toThrow(
        "Could not verify the validation reaper directory",
      );
      expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    }
    {
      const state = makeState();
      state.statResults.set("/reap/validation-reap.mjs", {
        code: 0,
        stdout: "0 0 600 regular file\n",
        stderr: "",
      });
      const provider = makeProvider(state);
      await expect(provider.create("task2", src)).rejects.toThrow(
        "Could not verify the validation reaper script",
      );
      expect(state.containers.has("valmont-sandbox-task2")).toBe(false);
    }
  });

  it("removes the container when reaper staging fails", async () => {
    const state = makeState();
    state.cpFailures = 1;
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
  });

  it("destroys a pre-existing container before re-creating", async () => {
    const state = makeState();
    state.containers.add("valmont-sandbox-task1");
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    const rmIdx = state.calls.findIndex(
      (c) => c.command === "docker" && c.args[0] === "rm",
    );
    const createIdx = state.calls.findIndex(
      (c) => c.command === "docker" && c.args[0] === "create",
    );
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeLessThan(createIdx);
  });

  it("rejects invalid task identifiers before touching docker", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("bad id", src)).rejects.toThrow(
      "Invalid task identifier",
    );
    expect(state.calls).toHaveLength(0);
  });

  it("opens a running container and reports unavailable otherwise", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    state.containers.add("valmont-sandbox-task1");
    const handle = await provider.open("task1");
    expect(handle).toEqual({ id: "task1", root: "/workspace" });
    await expect(provider.open("nope")).rejects.toThrow(
      "Task workspace is unavailable",
    );
  });

  it("reads a verified file as the task user", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "notes.md": "hello" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/notes.md", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/notes.md", {
      code: 0,
      stdout: "hello\n",
      stderr: "",
    });
    expect(await provider.readFile(ws, "notes.md")).toBe("hello\n");
    const cat = execCalls(state).find((c) => execCmd(c)[0] === "cat")!;
    expect(execUser(cat)).toBe("1000:1000");
    expect(execCmd(cat)).toEqual(["cat", "--", "/workspace/notes.md"]);
  });

  it("keeps not-found semantics for a genuinely missing file", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "notes.md": "hello" });
    const ws = await provider.create("task1", src);
    await expect(provider.readFile(ws, "missing.txt")).rejects.toThrow(
      "Could not read workspace file",
    );
  });

  it("classifies stat failures by the message's final clause, not a substring", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "notes.md": "hello" });
    const ws = await provider.create("task1", src);
    // The operand itself embeds the ENOENT phrase; the real errno is
    // EACCES. An unanchored substring match would misclassify this as
    // "missing" and proceed with the path.
    const weird = 'weird "No such file or directory"';
    state.statResults.set(`/workspace/${weird}`, {
      code: 1,
      stdout: "",
      stderr: `stat: cannot statx '/workspace/${weird}': Permission denied\n`,
    });
    await expect(provider.readFile(ws, weird)).rejects.toThrow(
      "Workspace path verification failed",
    );
    // A genuine ENOENT on a path embedding the phrase is still "missing".
    await expect(
      provider.readFile(ws, 'other "No such file or directory".txt'),
    ).rejects.toThrow("Could not read workspace file");
  });

  it("rejects symlink path components", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/link", {
      code: 0,
      stdout: "symbolic link\n",
      stderr: "",
    });
    await expect(provider.readFile(ws, "link/inner.txt")).rejects.toThrow(
      "Symlink path components are blocked",
    );
  });

  it("fails reads that exceed the output limit", async () => {
    const state = makeState();
    const provider = makeProvider(state, { outputLimitBytes: 64 });
    const src = await makeSource({ "big.txt": "x" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/big.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/big.txt", {
      code: 0,
      stdout: "x".repeat(1000),
      stderr: "",
    });
    await expect(provider.readFile(ws, "big.txt")).rejects.toThrow(
      "Workspace file exceeds the output limit",
    );
  });

  it("rejects changed files that look like secrets", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "creds.js": "x" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/creds.js", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/creds.js", {
      code: 0,
      stdout: 'export const k = "sk-proj-abcdef1234567890";\n',
      stderr: "",
    });
    await expect(provider.readFileForCommit(ws, "creds.js")).rejects.toThrow(
      "Potential secret detected in changed file",
    );
  });

  it("archives a dash-leading relative path with `--` (no option injection)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await provider.writeFile(ws, "-dash.txt", "content");
    const hostTar = state.calls.filter((c) => c.command === "tar").pop()!;
    expect(hostTar.args).toContain("--");
    expect(hostTar.args[hostTar.args.indexOf("--") + 1]).toBe("-dash.txt");
    const extract = execCalls(state)
      .filter((c) => execCmd(c)[0] === "tar")
      .pop()!;
    expect(execUser(extract)).toBe("1000:1000");
    expect(extract.stdinPath).toBeDefined();
  });

  it("refuses a write where an ancestor is a symlink", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/dir", {
      code: 0,
      stdout: "symbolic link\n",
      stderr: "",
    });
    await expect(provider.writeFile(ws, "dir/inner.txt", "x")).rejects.toThrow(
      "Symlink path components are blocked",
    );
  });

  it("refuses a write to an existing symlink target", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/target.txt", {
      code: 0,
      stdout: "symbolic link\n",
      stderr: "",
    });
    await expect(provider.writeFile(ws, "target.txt", "x")).rejects.toThrow(
      "Symlink path components are blocked",
    );
  });

  it("blocks sensitive, absolute, and escaping write paths", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await expect(provider.writeFile(ws, ".env", "x")).rejects.toThrow(
      "Writing sensitive paths is blocked",
    );
    await expect(provider.writeFile(ws, "/etc/passwd", "x")).rejects.toThrow(
      "Invalid workspace path",
    );
    await expect(provider.writeFile(ws, "../outside", "x")).rejects.toThrow(
      "Invalid workspace path",
    );
  });

  it("deletes a verified file as the task user", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "gone.txt": "x" });
    const ws = await provider.create("task1", src);
    state.statResults.set("/workspace/gone.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    await provider.deleteFile(ws, "gone.txt");
    const rmExec = execCalls(state)
      .filter((c) => execCmd(c)[0] === "rm")
      .pop()!;
    expect(execUser(rmExec)).toBe("1000:1000");
    expect(execCmd(rmExec)).toEqual(["rm", "--", "/workspace/gone.txt"]);
  });

  it("keeps not-found semantics for deleteFile", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await expect(provider.deleteFile(ws, "nope.txt")).rejects.toThrow(
      "Could not delete workspace file",
    );
  });

  it("maps git diff statuses and blocks unsafe changed paths", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.onExec = (_n, cmd) => {
      if (cmd[0] === "git" && cmd[1] === "diff" && cmd[2] === "--name-status") {
        return {
          code: 0,
          stdout: "M\tsrc/a.ts\nA\tnew.txt\nD\told.txt\n",
          stderr: "",
        };
      }
      return undefined;
    };
    const changed = await provider.listChangedFiles(ws);
    expect(changed).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "new.txt", status: "added" },
      { path: "old.txt", status: "deleted" },
    ]);
    state.onExec = () => ({
      code: 0,
      stdout: "M\tsrc/a.ts\nM\t.env\n",
      stderr: "",
    });
    await expect(provider.listChangedFiles(ws)).rejects.toThrow(
      "Git reported an unsafe changed path",
    );
  });

  it("redacts secrets in diffs and status output", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    const token = "ghp_xxxxxxxxxxxxxxxxxxxxxx";
    state.onExec = (_n, cmd) => {
      if (cmd[0] === "git" && cmd[1] === "diff") {
        return { code: 0, stdout: `+token ${token}\n`, stderr: "" };
      }
      if (cmd[0] === "git" && cmd[1] === "status") {
        return { code: 0, stdout: " M a.ts\n", stderr: "" };
      }
      return undefined;
    };
    const diff = await provider.gitDiff(ws);
    expect(diff).not.toContain(token);
    expect(await provider.gitStatus(ws)).toBe(" M a.ts\n");
  });

  it("rejects non-allowlisted validation commands and deploys", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await expect(
      provider.runValidation(ws, "curl http://example.com"),
    ).rejects.toThrow("Validation command is not allowlisted");
    const deploying = makeProvider(state, {
      allowedCommands: { "npm run deploy": ["npm", "run", "deploy"] },
    });
    await expect(deploying.runValidation(ws, "npm run deploy")).rejects.toThrow(
      "Deployments and database migrations are never run automatically",
    );
  });

  it("wraps the validation in timeout and reaps its process tree as the task user", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    const result = await provider.runValidation(ws, "npm test");
    expect(result.status).toBe("passed");
    const timeoutCall = execCalls(state).find(
      (c) => execCmd(c)[0] === "timeout",
    )!;
    expect(execUser(timeoutCall)).toBe("1000:1000");
    expect(execCmd(timeoutCall)).toEqual([
      "timeout",
      "--signal=KILL",
      "180",
      "npm",
      "test",
    ]);
    const reaper = execCalls(state).find((c) => execCmd(c)[0] === "node")!;
    expect(execUser(reaper)).toBe("1000:1000");
    expect(execCmd(reaper)).toEqual([
      "node",
      "/reap/validation-reap.mjs",
      expect.stringMatching(/^\d+$/),
    ]);
    expect(state.calls.indexOf(reaper)).toBeGreaterThan(
      state.calls.indexOf(timeoutCall),
    );
  });

  it("maps timeout wrapper exits 124 and 137 to timed_out", async () => {
    for (const code of [124, 137]) {
      const state = makeState();
      const provider = makeProvider(state);
      state.onExec = (_n, cmd) =>
        cmd[0] === "timeout"
          ? { code, stdout: "partial output", stderr: "" }
          : undefined;
      const src = await makeSource({ "a.txt": "x" });
      const ws = await provider.create("task1", src);
      const result = await provider.runValidation(ws, "npm test");
      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBe(code);
      expect(result.output).toContain("partial output");
    }
  });

  it("fails the validation when the reaper cannot complete", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    state.onExec = (_n, cmd) =>
      cmd[0] === "node"
        ? {
            code: 1,
            stdout: "",
            stderr:
              "validation-reap: survivor pid 42 (state R) started during the validation\n",
          }
        : undefined;
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
  });

  it("destroy removes the container; a missing container is a no-op", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    await provider.destroy("task1");
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    await provider.destroy("task1");
  });

  it("fails operations on a destroyed container with the lifecycle error", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "notes.md": "hello" });
    const ws = await provider.create("task1", src);
    await provider.destroy("task1");
    await expect(provider.readFile(ws, "notes.md")).rejects.toThrow(
      "Task workspace is unavailable",
    );
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is unavailable",
    );
  });

  it("uses the single numeric identity for every exec", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await provider.writeFile(ws, "b.txt", "y");
    state.statResults.set("/workspace/b.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/b.txt", {
      code: 0,
      stdout: "y\n",
      stderr: "",
    });
    await provider.readFile(ws, "b.txt");
    for (const c of execCalls(state)) {
      const user = execUser(c);
      // Only the two identities exist: the numeric task user and root
      // (root stat of /reap). No user NAME is ever passed.
      expect(user === "1000:1000" || user === "root").toBe(true);
    }
    expect(taskExecs(state).length).toBeGreaterThan(0);
  });

  it("reaps an abandoned container after the TTL", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    // A container from a previous provider process: no activity record
    // here, old creation time.
    state.containers.add("valmont-sandbox-old1");
    state.createdAt.set("valmont-sandbox-old1", OLD_CREATED);
    state.psLines = ["valmont-sandbox-old1\told1"];
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-old1")).toBe(false);
  });

  it("never reaps a task with a fresh activity record", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("busy1", src);
    state.psLines = ["valmont-sandbox-busy1\tbusy1"];
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-busy1")).toBe(true);
  });

  it("defers removal when activity lands between the checks", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500); // let the activity record go stale
    state.psLines = ["valmont-sandbox-task1\ttask1"];
    let openPromise: Promise<unknown> | undefined;
    let fired = false;
    state.onInspect = (name, format) => {
      if (
        !fired &&
        name === "valmont-sandbox-task1" &&
        format === "{{.State.Running}}"
      ) {
        fired = true;
        // Enqueue while the in-lock existence check is in flight: fresh
        // activity must abort the removal.
        openPromise = provider.open("task1");
      }
    };
    await internals(provider).reapExpired();
    expect(fired).toBe(true);
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    await expect(openPromise).resolves.toEqual({
      id: "task1",
      root: "/workspace",
    });
  });

  it("an operation enqueued during a successful removal fails cleanly and the record is dropped", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500); // stale activity → the gates will pass
    state.psLines = ["valmont-sandbox-task1\ttask1"];
    let openPromise: Promise<unknown> | undefined;
    state.onRm = (name) => {
      if (name === "valmont-sandbox-task1") {
        // Enqueue while the rm -f is in flight (the container is still
        // registered, so the enqueue succeeds and records fresh activity).
        openPromise = provider.open("task1");
      }
    };
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    if (!openPromise) throw new Error("rm hook did not fire");
    // Documented race outcome: the container is gone, so the late
    // operation fails with the lifecycle error instead of resurrecting
    // the container's bookkeeping.
    await expect(openPromise).rejects.toThrow("Task workspace is unavailable");
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("a failed removal keeps the container and its activity record for retry", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500);
    state.psLines = ["valmont-sandbox-task1\ttask1"];
    state.rmErrors.set(
      "valmont-sandbox-task1",
      "Error: rm: device or resource busy\n",
    );
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    state.rmErrors.delete("valmont-sandbox-task1");
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("checks the removal result for an invalid-label container and never falls through", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    state.containers.add("valmont-sandbox-old1");
    state.createdAt.set("valmont-sandbox-old1", OLD_CREATED);
    state.psLines = ["badid1\tbad*label", "valmont-sandbox-old1\told1"];
    state.rmErrors.set("badid1", "Error: rm: daemon error\n");
    await expect(internals(provider).reapExpired()).resolves.toBeUndefined();
    // The invalid container's failed removal was checked (not reported,
    // but not treated as success either) and it is left for the next
    // interval; the valid one after it was processed normally.
    expect(state.containers.has("valmont-sandbox-old1")).toBe(false);
    expect(state.rmErrors.has("badid1")).toBe(true);
    // No queue or activity bookkeeping was created under the invalid label.
    expect(internals(provider).taskActivity.has("bad*label")).toBe(false);
    expect(internals(provider).taskLocks.has("bad*label")).toBe(false);
  });
});
