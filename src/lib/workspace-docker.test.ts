import { PassThrough } from "node:stream";
import {
  execFile as execFileCb,
  execFileSync,
  spawn,
} from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, mkdtemp, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, afterAll, describe, expect, it } from "vitest";
import {
  DockerWorkspaceProvider,
  VALIDATION_REAPER_SCRIPT,
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
  /**
   * Per-container labels, parsed from the create `--label` args —
   * modelled with REAL Docker semantics: set at creation, immutable
   * afterwards (carried across rename, dropped on rm). `docker ps` and
   * the combined inspect render missing labels as "<no value>".
   */
  labels: Map<string, Record<string, string>>;
  /** Stopped containers (stop adds, start removes, rm drops). */
  stopped: Set<string>;
  calls: { command: string; args: readonly string[]; stdinPath?: string }[];
  hostTarMembers: string[];
  stagedTopLevel: string[];
  statResults: Map<string, ExecResult>;
  fileContents: Map<string, ExecResult>;
  psLines: string[];
  rmErrors: Map<string, string>;
  /**
   * Forced `docker rename <old> ...` failure (keyed by the OLD name).
   * The container keeps its original name — exactly what the real
   * daemon does on a rename error (other than "no such container").
   */
  renameErrors: Map<string, string>;
  /** Forced `docker stop <name>` failure. */
  stopErrors: Map<string, string>;
  /**
   * Forced `docker create --name <name>` failure (keyed by name) that
   * MODELS A CLI-LEVEL FAILURE AFTER THE DAEMON ACCEPTED THE CONTAINER
   * (a timeout/CLI error mid-create): the container IS registered (the
   * daemon holds it) but the call reports code 1 — the uncertain
   * side-effect the provider must treat as a possible leak.
   */
  createErrors: Map<string, string>;
  /**
   * Artificial latency (ms) for exec commands, keyed by cmd[0]: the
   * child's streams end after the delay instead of immediately, so a
   * provider operation genuinely OUTLIVES its enqueue timestamp.
   */
  execDelays: Map<string, number>;
  cpDestinations: string[];
  cpFailures: number;
  /** Forced inspect failure (code 1) for a container's Running check. */
  inspectErrors: Map<string, string>;
  /** Simulate the host CLI failing to spawn an exec command (keyed by cmd). */
  spawnFail: Map<string, string>;
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
    labels: new Map(),
    stopped: new Set(),
    calls: [],
    hostTarMembers: [],
    stagedTopLevel: [],
    statResults: new Map(),
    fileContents: new Map(),
    psLines: [],
    rmErrors: new Map(),
    renameErrors: new Map(),
    stopErrors: new Map(),
    createErrors: new Map(),
    execDelays: new Map(),
    cpDestinations: [],
    cpFailures: 0,
    inspectErrors: new Map(),
    spawnFail: new Map(),
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

function makeChild(
  stdout: string,
  stderr: string,
  code: number,
  delayMs?: number,
): ChildProcess {
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
  const finish = () => {
    stdoutStream.end(stdout);
    stderrStream.end(stderr);
    for (const fn of listeners["close"] ?? []) fn(code, null);
  };
  // An optional delay models a command that genuinely takes time
  // (the provider's operation outlives its enqueue timestamp); without
  // it the child finishes on the next immediate, as before.
  if (delayMs !== undefined && delayMs > 0) {
    setTimeout(finish, delayMs);
  } else {
    setImmediate(finish);
  }
  return child as unknown as ChildProcess;
}

/** A child whose spawn fails: the provider's docker() REJECTS for these. */
function makeErrorChild(message: string): ChildProcess {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => true,
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
      return child;
    },
  };
  setImmediate(() => {
    for (const fn of listeners["error"] ?? []) fn(new Error(message));
  });
  return child as unknown as ChildProcess;
}

function makeSpawn(state: FakeState): DockerSpawn {
  return (command, args, options) => {
    state.calls.push({ command, args, stdinPath: options.stdinPath });
    let code = 0;
    let stdout = "";
    let stderr = "";
    let delay: number | undefined;
    if (command === "docker") {
      const sub = args[0];
      if (sub === "create") {
        const name = args[args.indexOf("--name") + 1];
        // Labels are SET AT CREATION (real Docker: immutable after) and
        // are the source for every later ps/inspect label render.
        const labelMap: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--label" && i + 1 < args.length) {
            const eq = args[i + 1].indexOf("=");
            if (eq > 0) {
              labelMap[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
            }
          }
        }
        // createErrors models a CLI-level failure AFTER the daemon
        // accepted the container (timeout mid-create): the container is
        // registered (the daemon holds it, half-initialized) but the
        // call reports an error — the uncertain side effect the
        // provider must treat as a possible leak.
        state.containers.add(name);
        state.createdAt.set(name, OLD_CREATED);
        state.labels.set(name, labelMap);
        const forcedCreate = state.createErrors.get(name);
        if (forcedCreate !== undefined) {
          code = 1;
          stderr = forcedCreate;
        } else {
          stdout = "fakecontainerid\n";
        }
      } else if (sub === "start") {
        const name = args[1];
        if (!state.containers.has(name)) {
          code = 1;
          stderr = `Error: No such container: ${name}\n`;
        } else {
          state.stopped.delete(name);
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
          state.labels.delete(name);
          state.stopped.delete(name);
          stdout = `${name}\n`;
        } else {
          code = 1;
          stderr = `Error: No such container: ${name}\n`;
        }
      } else if (sub === "rename") {
        // `docker rename <old> <new>`: a metadata operation that works
        // on a running OR stopped container (real Docker semantics —
        // it is the provider's durable quarantine marker). The
        // container's other state (creation time, labels) moves with
        // the new name; a failure other than "no such container" leaves
        // the original name in place (the provider's stop fallback
        // then makes the quarantine fail closed).
        const [oldName, newName] = args.slice(1);
        const forcedRename = state.renameErrors.get(oldName);
        if (forcedRename !== undefined) {
          code = 1;
          stderr = forcedRename;
        } else if (!state.containers.has(oldName)) {
          code = 1;
          stderr = `Error: No such container: ${oldName}\n`;
        } else if (state.containers.has(newName)) {
          code = 1;
          stderr = `Error: renaming container: ${newName} already in use\n`;
        } else {
          state.containers.delete(oldName);
          state.containers.add(newName);
          const created = state.createdAt.get(oldName);
          if (created !== undefined) {
            state.createdAt.delete(oldName);
            state.createdAt.set(newName, created);
          }
          const carriedLabels = state.labels.get(oldName);
          if (carriedLabels !== undefined) {
            state.labels.delete(oldName);
            state.labels.set(newName, carriedLabels);
          }
        }
      } else if (sub === "stop") {
        // `docker stop <name>`: a real, supported operation; a stopped
        // container reports Running=false (the provider's fail-closed
        // quarantine fallback) and still accepts `rm -f`.
        const name = args[1];
        const forcedStop = state.stopErrors.get(name);
        if (forcedStop !== undefined) {
          code = 1;
          stderr = forcedStop;
        } else if (!state.containers.has(name)) {
          code = 1;
          stderr = `Error: No such container: ${name}\n`;
        } else {
          state.stopped.add(name);
          stdout = `${name}\n`;
        }
      } else if (sub === "inspect") {
        const format = args[args.indexOf("--format") + 1];
        const name = args[args.length - 1];
        state.onInspect?.(name, format);
        if (format === "{{.State.Running}}") {
          const forced = state.inspectErrors.get(name);
          if (forced !== undefined) {
            // Transient daemon-side failure (the container may be alive).
            code = 1;
            stderr = forced;
          } else if (state.containers.has(name)) {
            // A STOPPED container exists but is not running — exactly
            // what `docker inspect --format '{{.State.Running}}'`
            // reports, and what makes the quarantine stop fallback
            // fail closed for every instance.
            stdout = state.stopped.has(name) ? "false\n" : "true\n";
          } else {
            code = 1;
            stderr = `Error: No such object: ${name}\n`;
          }
        } else if (
          format ===
          '{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}'
        ) {
          // The combined open/create/destroy probe. Missing labels
          // render as "<no value>" (Go template behavior, mirrored
          // exactly — the provider treats that as "no label").
          const forced = state.inspectErrors.get(name);
          if (forced !== undefined) {
            code = 1;
            stderr = forced;
          } else if (!state.containers.has(name)) {
            code = 1;
            stderr = `Error: No such object: ${name}\n`;
          } else {
            const labels = state.labels.get(name) ?? {};
            const running = state.stopped.has(name) ? "false" : "true";
            stdout = `${running}|${labels["valmont.task"] ?? "<no value>"}|${
              labels["valmont.instance"] ?? "<no value>"
            }\n`;
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
        // With no injected lines, DERIVE the listing from container
        // state (id, task label, instance label, name with the leading
        // "/" that `docker ps` renders) — so a container that was
        // created, renamed, or stopped shows up exactly as the real
        // daemon would list it. Injected lines override (tests that
        // pin a specific listing).
        const lines =
          state.psLines.length > 0
            ? state.psLines
            : [...state.containers].map((n) => {
                const labels = state.labels.get(n) ?? {};
                return `${n}\t${labels["valmont.task"] ?? "<no value>"}\t${
                  labels["valmont.instance"] ?? "<no value>"
                }\t/${n}`;
              });
        stdout = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
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
        } else if (state.stopped.has(name)) {
          // Real Docker refuses exec into a stopped container: no
          // operation can race a quarantined (stopped) container.
          code = 1;
          stderr = `Error: container ${name} is not running\n`;
        } else {
          const cmd = args.slice(args.indexOf(name) + 1);
          const user = args[args.indexOf("--user") + 1];
          const failedSpawn = state.spawnFail.get(cmd[0]);
          if (failedSpawn !== undefined) {
            // The host-side CLI could not spawn: the provider rejects.
            return makeErrorChild(failedSpawn);
          }
          delay = state.execDelays.get(cmd[0]);
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
    return makeChild(stdout, stderr, code, delay);
  };
}

/**
 * Every provider gets its OWN lease directory (tracked for cleanup), so
 * two provider instances in the same test never share lease files unless
 * a test EXPLICITLY points them at a shared dir (the cross-instance
 * tests do, via `extra.leaseDir`).
 */
const leaseDirs: string[] = [];

function makeProvider(
  state: FakeState,
  extra: Partial<DockerWorkspaceOptions> = {},
): DockerWorkspaceProvider {
  const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
  leaseDirs.push(leaseDir);
  return new DockerWorkspaceProvider({
    image: "test:latest",
    // Generous so activity recorded at enqueue time is still fresh after
    // the (multi-ms) create sequence; stale tests sleep past it.
    ttlMs: 400,
    spawnOverride: makeSpawn(state),
    leaseDir,
    ...extra,
  });
}

/**
 * Seed a container the way a REAL daemon would hold one: registered
 * (created at OLD_CREATED) with the given creation-time labels.
 * Unlabeled (no argument) = the legacy case (created before the
 * instance-label mechanism).
 */
function seedContainer(
  state: FakeState,
  name: string,
  labels: Record<string, string> = {},
): void {
  state.containers.add(name);
  state.createdAt.set(name, OLD_CREATED);
  state.labels.set(name, { ...labels });
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

interface HeldFenceLike {
  active: boolean;
  release(): Promise<void>;
}

interface Internals {
  user: string;
  reapExpired(): Promise<void>;
  taskActivity: Map<string, number>;
  taskLocks: Map<string, Promise<void>>;
  quarantinedTasks: Set<string>;
  acquireTaskFence(
    taskId: string,
    role: "owner" | "reaper",
  ): Promise<HeldFenceLike | null>;
}

const internals = (p: DockerWorkspaceProvider) => p as unknown as Internals;

/** lstat mtime ms (a cheap change-detection token for lease files). */
const lstatSyncSafe = (file: string): number => lstatSync(file).mtimeMs;

/** Best-effort chmod (no-op when the process cannot chmod the path). */
const chmodForce = (file: string, mode: number): void => {
  try {
    chmodSync(file, mode);
  } catch {
    // Some CI/root configurations ignore permission bits; the tests
    // that depend on the unreadable case assert only on the provider's
    // behavior, which is identical for an EACCES and an unreadable
    // directory error.
  }
};

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
  // Lease writes are best-effort fire-and-forget: one may still be in
  // flight when the test ends, so retry the cleanup (ENOTEMPTY).
  for (const dir of leaseDirs.splice(0)) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
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

  it("rejects an operation timeout at or above the fence TTL (an op cannot outlive the fence that serializes it)", () => {
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
          timeoutMs: 10_000,
        }),
    ).toThrow(/must be below the fence TTL/);
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
          timeoutMs: 30_000,
        }),
    ).toThrow(/must be below the fence TTL/);
    // A comfortably bounded timeout is accepted.
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
          timeoutMs: 4_000,
        }),
    ).not.toThrow();
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
      // Docker's default /dev/shm, declared explicitly and bounded.
      "/dev/shm:rw,nosuid,nodev,mode=777,size=64m",
    ]);
    expect(args).toContain("--label");
    expect(args).toContain("valmont.managed=true");
    expect(args).toContain("valmont.task=task1");
    // The instance-ownership stamp: present at creation, immutable
    // after, and readable by every instance (including this one after a
    // restart) when resolving who owns the container.
    expect(args).toContain(`valmont.instance=${provider.instanceId}`);
    expect(
      state.labels.get("valmont-sandbox-task1")?.["valmont.instance"],
    ).toBe(provider.instanceId);
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
    // Same owning instance (the foreign-provider ownership gate is
    // covered separately): only the command allowlist differs.
    const deploying = makeProvider(state, {
      instanceId: provider.instanceId,
      leaseDir: provider.leaseDir,
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

  it("quarantines the task and destroys the container when validation cleanup fails", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.onExec = (_n, cmd) =>
      cmd[0] === "node"
        ? {
            code: 1,
            stdout: "",
            stderr:
              "validation-reap: survivor pid 42 (state R) started during the validation\n",
          }
        : undefined;
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The untrusted container is destroyed and its activity dropped (it
    // pins nothing now).
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    // Every later operation rejects with the quarantine error — a
    // survivor must never race later path verification.
    await expect(provider.readFile(ws, "a.txt")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // Explicit teardown clears the quarantine; the id is then simply
    // "unavailable" (no container).
    await provider.destroy("task1");
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(false);
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is unavailable",
    );
  });

  it("a quarantine persists while the destroy itself is failing", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.onExec = (_n, cmd) =>
      cmd[0] === "node"
        ? { code: 1, stdout: "", stderr: "survivor\n" }
        : undefined;
    // The quarantine's immediate destroy also fails: the container stays.
    state.rmErrors.set(
      "valmont-sandbox-task1",
      "Error: rm: device or resource busy\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The container survived the failed rm — and was renamed: the
    // durable quarantine marker.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      true,
    );
    // The live-but-untrusted container must NOT be usable — the
    // quarantine is stricter than "unavailable".
    await expect(provider.readFile(ws, "a.txt")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // The transient removal failure clears: destroy() removes the
    // renamed container and the quarantine.
    state.rmErrors.clear();
    await provider.destroy("task1");
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      false,
    );
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(false);
  });

  it("create() replaces a quarantined task", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    state.onExec = (_n, cmd) =>
      cmd[0] === "node"
        ? { code: 1, stdout: "", stderr: "survivor\n" }
        : undefined;
    state.rmErrors.set("valmont-sandbox-task1", "Error: rm: busy\n");
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    // The surviving container was renamed — the durable marker.
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      true,
    );
    // Replacement: the create-time cleanup now succeeds (the removal
    // error is cleared, and cleanupAll removes the renamed container),
    // the quarantine no longer applies, and the new workspace works.
    state.rmErrors.delete("valmont-sandbox-task1");
    state.onExec = undefined;
    const ws2 = await provider.create("task1", src);
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(false);
    state.statResults.set("/workspace/a.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/a.txt", {
      code: 0,
      stdout: "x\n",
      stderr: "",
    });
    expect(await provider.readFile(ws2, "a.txt")).toBe("x\n");
  });

  it("a validation exec on a gone container is a lifecycle error, not a quarantine", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await provider.destroy("task1");
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Task workspace is unavailable",
    );
    // No quarantine: nothing survived — the container was simply gone.
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(false);
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is unavailable",
    );
  });

  it("quarantines when the reaper exec cannot even start", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    // The host CLI fails to spawn the reaper (e.g. client killed, daemon
    // exec possibly still running): cleanup did not complete.
    state.spawnFail.set("node", "spawn docker ENOENT");
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
  });

  it("rejects dot-dot relative paths (host-side scratch escape)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    const callsBefore = state.calls.length;
    // "workspace/../a.txt" canonicalizes to /workspace/a.txt (a legal
    // container path) but would stage OUTSIDE the operation scratch at
    // <scratch-parent>/workspace/a.txt — the host-side escape.
    await expect(
      provider.writeFile(ws, "workspace/../a.txt", "y"),
    ).rejects.toThrow("Invalid workspace path");
    await expect(provider.writeFile(ws, "../escape.txt", "y")).rejects.toThrow(
      "Invalid workspace path",
    );
    await expect(provider.writeFile(ws, "a/../../b.txt", "y")).rejects.toThrow(
      "Invalid workspace path",
    );
    // Nothing was staged for the rejected attempts: no host tar, no
    // docker call, no file anywhere outside the (never created) scratch.
    expect(state.calls.length).toBe(callsBefore);
    // Plain nested paths still work (the fix is not over-broad).
    await provider.writeFile(ws, "sub/deep.txt", "y");
    const hostTar = state.calls.filter((c) => c.command === "tar").pop()!;
    expect(hostTar.args[hostTar.args.indexOf("--") + 1]).toBe("sub/deep.txt");
  });

  it("a transient in-lock inspect failure preserves the activity record", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500);
    state.psLines = ["valmont-sandbox-task1\ttask1"];
    state.inspectErrors.set(
      "valmont-sandbox-task1",
      "Error: daemon: request timeout\n",
    );
    await internals(provider).reapExpired();
    // The inspect failure was transient (not "no such object"): the
    // container is still here and the activity record is PRESERVED — an
    // operation may have enqueued while the inspect awaited, and the next
    // interval must not reap a live container on its old creation time.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    state.inspectErrors.delete("valmont-sandbox-task1");
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("drops the record when the container is truly gone (no such object)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500);
    // Removed outside this provider (operator or another process).
    state.containers.delete("valmont-sandbox-task1");
    state.psLines = ["valmont-sandbox-task1\ttask1"];
    await internals(provider).reapExpired();
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("skips a truncated ps listing instead of partially reaping", async () => {
    const state = makeState();
    // A 40-byte cap truncates the two-line (59-byte) listing.
    const provider = makeProvider(state, { psListLimitBytes: 40 });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500);
    state.psLines = [
      "valmont-sandbox-task1\ttask1",
      "valmont-sandbox-task2\ttask2",
    ];
    await internals(provider).reapExpired();
    // The listing was truncated: the suffix (the OLDEST containers, per
    // `docker ps -a` ordering) would be skipped — so the ENTIRE listing
    // is skipped. Nothing may be touched, not even the fully-present
    // first line.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    const createdInspects = state.calls.filter(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "inspect" &&
        c.args.includes("{{.Created}}"),
    );
    expect(createdInspects.length).toBe(0);
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    // A provider with the full cap reaps on the next interval — the
    // skip is a deferral, not a waiver.
    const full = makeProvider(state);
    await internals(full).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
  });

  it("quarantine is durable: a fresh instance cannot open a surviving quarantined container", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    // The reaper cannot start AND the container cannot be removed:
    // cleanup failed, so the task is quarantined — and the container
    // SURVIVES, requiring the durable marker.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      "valmont-sandbox-task1",
      "Error: removing container: device or resource busy\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The container survived — and was RENAMED: the durable quarantine
    // marker. (Real Docker labels are immutable after creation, so a
    // rename is the only supported persistent marker; the fake daemon
    // implements rename with real semantics.)
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      true,
    );
    // A FRESH provider instance (restart or second instance) has no
    // in-memory flag — the daemon-side rename must do the work.
    const fresh = makeProvider(state);
    expect(internals(fresh).quarantinedTasks.has("task1")).toBe(false);
    await expect(fresh.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // ...and open() adopts the flag so this instance rejects afterwards
    // without another inspect.
    expect(internals(fresh).quarantinedTasks.has("task1")).toBe(true);
    // An explicit destroy() removes the renamed container and clears
    // the quarantine (the transient removal failure has cleared).
    state.rmErrors.clear();
    await fresh.destroy("task1");
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      false,
    );
    expect(internals(fresh).quarantinedTasks.has("task1")).toBe(false);
  });

  it("a failed create() quarantines its unremovable half-initialized container; a successful replacement clears it", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    // Reaper staging fails AND removal fails: create() leaves a
    // half-initialized container (no reaper, no git baseline) that
    // CANNOT be removed. Only the SECOND removal of the ORIGINAL name
    // (the catch-path cleanup) is forced to fail — the first one
    // (pre-cleanup, where the container does not exist yet) must
    // succeed with "no such container", as in production. The
    // quarantined-name removals (part of every cleanupAll) must never
    // be forced.
    state.cpFailures = 1;
    const ORIGINAL = "valmont-sandbox-task1";
    let originalRmCount = 0;
    state.onRm = (name) => {
      if (name !== ORIGINAL) return;
      originalRmCount += 1;
      if (originalRmCount >= 2) {
        state.rmErrors.set(
          name,
          "Error: removing container: device or resource busy\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    // The half-initialized container survived — and was renamed: the
    // durable quarantine marker.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      true,
    );
    // The quarantine is in effect on this instance...
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // ...and (via the daemon-side rename) on any fresh instance.
    await expect(makeProvider(state).open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // A replacement whose setup completes fully clears the quarantine:
    // its pre-cleanup removes the renamed container (a replacement must
    // not orphan it), and the flag is dropped only after the new setup
    // succeeds.
    state.onRm = undefined; // the removals work now
    state.rmErrors.clear();
    const ws = await provider.create("task1", src);
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      false,
    );
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(false);
    expect(await provider.open("task1")).toEqual({
      id: "task1",
      root: "/workspace",
    });
    state.statResults.set("/workspace/a.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/a.txt", {
      code: 0,
      stdout: "x",
      stderr: "",
    });
    expect(await provider.readFile(ws, "a.txt")).toBe("x");
  });

  it("rejects task ids ending in the reserved quarantine suffix at every entry point", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    // `foo-quarantined` passes TASK_ID alone, but it must be rejected:
    // task `foo`'s QUARANTINED container name
    // (valmont-sandbox-foo-quarantined) would be byte-identical to task
    // `foo-quarantined`'s NORMAL container name — without the
    // reservation, open("foo-quarantined") could be handed `foo`'s
    // quarantined container.
    await expect(provider.create("foo-quarantined", src)).rejects.toThrow(
      "Invalid task identifier",
    );
    await expect(provider.open("foo-quarantined")).rejects.toThrow(
      "Invalid task identifier",
    );
    await expect(provider.destroy("foo-quarantined")).rejects.toThrow(
      "Invalid task identifier",
    );
    // All before touching docker...
    expect(state.calls).toHaveLength(0);
    // ...and task `foo`'s surviving quarantined container (renamed to
    // exactly this name) is unreachable as task `foo-quarantined`.
    seedContainer(state, "valmont-sandbox-foo-quarantined", {
      "valmont.task": "foo",
      "valmont.instance": provider.instanceId,
    });
    await expect(provider.open("foo-quarantined")).rejects.toThrow(
      "Invalid task identifier",
    );
    expect(state.calls).toHaveLength(0);
  });

  it("open/create/destroy verify the task label: a foreign container under the task name is never used", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    // A container that exists under task1's normal name but was created
    // for ANOTHER task (the rename "name already in use" scenario, or a
    // pre-fix name collision): the name matches, the label does not.
    seedContainer(state, "valmont-sandbox-task1", {
      "valmont.task": "other-task",
      "valmont.instance": provider.instanceId,
    });
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is unavailable",
    );
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Task workspace is unavailable",
    );
    await expect(provider.destroy("task1")).rejects.toThrow(
      "Task workspace is unavailable",
    );
    // The foreign container was never touched: no rm, still present.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    expect(
      state.calls.filter((c) => c.command === "docker" && c.args[0] === "rm"),
    ).toHaveLength(0);
  });

  it("a docker create that leaked a container (CLI failure after daemon accept) is quarantined", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    // The daemon ACCEPTED the container but the CLI reports failure (a
    // timeout mid-create): the container exists, half-initialized, under
    // the normal name — and it cannot be removed. The rm failure is
    // forced only while the (leaked) container EXISTS: the pre-cleanup
    // rm (before create, where nothing exists yet) must succeed with
    // "no such container", as in production.
    state.createErrors.set(
      "valmont-sandbox-task1",
      "Error: creating container: request timeout\n",
    );
    state.onRm = (name) => {
      if (name === "valmont-sandbox-task1" && state.containers.has(name)) {
        state.rmErrors.set(
          name,
          "Error: removing container: device or resource busy\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not create sandbox container",
    );
    // The leaked container was renamed: the durable quarantine marker.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      true,
    );
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    // No instance — this one or a fresh one — can open the leaked
    // half-initialized container.
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    await expect(makeProvider(state).open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
  });

  it("a non-not-found rename failure falls back to a checked stop (fail closed across instances)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    // The reaper cannot start, the container cannot be removed, and the
    // quarantine RENAME fails for a non-not-found reason: the container
    // keeps its normal name — an in-memory flag alone would fail open.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      "valmont-sandbox-task1",
      "Error: removing container: device or resource busy\n",
    );
    state.renameErrors.set(
      "valmont-sandbox-task1",
      "Error: renaming container: daemon error\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The fallback stop ran and was checked: the container is STOPPED —
    // a durable, daemon-side "do not use" state (labels are immutable,
    // so stop is the second supported marker).
    expect(state.stopped.has("valmont-sandbox-task1")).toBe(true);
    const stopCall = state.calls.find(
      (c) => c.command === "docker" && c.args[0] === "stop",
    );
    expect(stopCall?.args).toEqual(["stop", "valmont-sandbox-task1"]);
    // A fresh instance (no in-memory flag) gets no handle: the
    // container is owned by the other instance and is not running —
    // fail closed.
    const fresh = makeProvider(state);
    await expect(fresh.open("task1")).rejects.toThrow(
      "Task workspace is owned by another provider instance",
    );
    // ...but a stopped container has no possible live user (no
    // operation can run in it), so the fresh instance may still
    // destroy it — that is how this state gets cleaned up
    // cross-instance.
    state.rmErrors.clear();
    await fresh.destroy("task1");
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
  });

  it("two instances sharing a daemon: operations are owner-only and the reaper honors fresh leases", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 300,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 300,
    });
    const src = await makeSource({ "a.txt": "x" });
    await a.create("task1", src);
    // Instance B cannot operate on A's RUNNING container: open,
    // create-replace, and destroy are all rejected, and the container
    // survives all three attempts.
    await expect(b.open("task1")).rejects.toThrow(
      "Task workspace is owned by another provider instance",
    );
    await expect(b.create("task1", src)).rejects.toThrow(
      "Task workspace is owned by another provider instance",
    );
    await expect(b.destroy("task1")).rejects.toThrow(
      "Task workspace is owned by another provider instance",
    );
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    // B's reaper sees the container (OLD_CREATED — older than any TTL)
    // but A's lease is FRESH: reaping it would destroy A's live
    // workspace, so B skips it.
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    // A dies: its lease stops being refreshed and goes stale. B's
    // reaper may now remove the container by age (the owner is
    // provably gone). The lease deletion is GENERATION-AWARE: B never
    // unlinks a lease naming another instance (a replacement owner's
    // fresh lease must survive a racing teardown), so the dead owner's
    // stale lease is left to its own cleanup — the container is the
    // object that matters for isolation, and it IS gone.
    await sleep(400);
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
    // B must not have overwritten or deleted A's lease: its instanceId
    // is still the dead A's, not B's.
    const leftOver = existsSync(path.join(leaseDir, "task1.lease"));
    if (leftOver) {
      const body = JSON.parse(
        readFileSync(path.join(leaseDir, "task1.lease"), "utf8"),
      );
      expect(body.instanceId).toBe("instance-a");
    }
  });

  it("a quarantined container is reaped by age by ANY instance, even a live owner", async () => {
    const state = makeState();
    const a = makeProvider(state, { instanceId: "instance-a" });
    const b = makeProvider(state, { instanceId: "instance-b" });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await a.create("task1", src);
    // A quarantines: the reaper cannot start AND the container cannot
    // be removed, so it survives, renamed to the durable marker.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      "valmont-sandbox-task1",
      "Error: removing container: device or resource busy\n",
    );
    await expect(a.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      true,
    );
    // A's lease is FRESH (A is alive and just operated on the task) —
    // yet B's reaper removes the QUARANTINED container anyway: it is
    // unusable by definition (every operation rejects it), so no live
    // user can be racing its removal.
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1-quarantined")).toBe(
      false,
    );
    // B never touched A's lease file.
    expect(existsSync(path.join(a.leaseDir, "task1.lease"))).toBe(true);
  });

  it("adopts an unlabeled (legacy) container, claims it via the lease, and peer reapers respect the claim", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 300,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 300,
    });
    // A legacy container: managed, but no instance label (created
    // before the mechanism). No live instance can own it, so A adopts
    // it on open and claims it via the lease...
    seedContainer(state, "valmont-sandbox-task1", {
      "valmont.task": "task1",
    });
    const handle = await a.open("task1");
    expect(handle).toEqual({ id: "task1", root: "/workspace" });
    expect(existsSync(path.join(leaseDir, "task1.lease"))).toBe(true);
    // ...and while the claim is fresh, B's reaper skips it (by age it
    // is long overdue: OLD_CREATED).
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    // A dies: the claim goes stale, and B reaps the orphan by age.
    await sleep(400);
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
  });

  it("a corrupt (torn) foreign lease fails closed: the container is left alone until the lease is resolved", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 300,
    });
    // A foreign instance's container (OLD_CREATED — older than any
    // TTL)...
    seedContainer(state, "valmont-sandbox-task2", {
      "valmont.task": "task2",
      "valmont.instance": "instance-b",
    });
    // ...with a TORN lease file (a write that crashed mid-way): the
    // owner may still be alive, and "cannot prove death" fails closed.
    writeFileSync(
      path.join(leaseDir, "task2.lease"),
      '{"instanceId": "instance-b", "update',
    );
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-task2")).toBe(true);
    // Once the lease is a VALID STALE one, the owner is provably gone:
    // the container is reaped by age.
    writeFileSync(
      path.join(leaseDir, "task2.lease"),
      JSON.stringify({
        instanceId: "instance-b",
        updatedAt: Date.now() - 10_000,
        containerName: "valmont-sandbox-task2",
      }),
    );
    await internals(provider).reapExpired();
    expect(state.containers.has("valmont-sandbox-task2")).toBe(false);
  });

  it("a long operation's completion refreshes activity: the reaper behind it defers, not removes", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    await sleep(500); // let the create's activity go stale (ttl 400)
    state.psLines = ["valmont-sandbox-task1\ttask1"];
    state.statResults.set("/workspace/a.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/a.txt", {
      code: 0,
      stdout: "x\n",
      stderr: "",
    });
    // The read genuinely takes 3000 ms — far past the 400 ms TTL — so
    // its ENQUEUE timestamp is stale for most of the operation.
    state.execDelays.set("cat", 3000);
    const readPromise = provider.readFile(ws, "a.txt");
    await sleep(800); // enqueue activity is now stale; the op is running
    // The reaper's ps-time check sees the STALE enqueue timestamp and
    // proceeds to the per-task lock, where it waits behind the
    // in-flight read. When the read COMPLETES it refreshes the
    // activity — the reaper's in-lock check must now see the task as
    // freshly used and defer. (Without the completion refresh it would
    // remove the container the moment the read finished.)
    await internals(provider).reapExpired();
    await readPromise;
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
  });

  it("unknown inspect failures during create() fail closed: no rm, no setup, undetermined error", async () => {
    const state = makeState();
    // A pre-existing container the create would need to replace — with
    // the probe failing for an UNKNOWN reason (daemon timeout), NOT
    // "no such object".
    seedContainer(state, "valmont-sandbox-task1", {
      "valmont.task": "task1",
      "valmont.instance": "other-live-instance",
    });
    state.inspectErrors.set(
      "valmont-sandbox-task1",
      "Error: response from daemon: request timed out\n",
    );
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Task workspace state could not be determined",
    );
    // Fail CLOSED: no destructive or setup call of any kind.
    const calls = state.calls.map((c) => c.args[0]);
    expect(calls.filter((a) => a === "rm")).toHaveLength(0);
    expect(calls.filter((a) => a === "create")).toHaveLength(0);
    expect(calls.filter((a) => a === "start")).toHaveLength(0);
    // The pre-existing container is untouched.
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
  });

  it("unknown inspect failures during destroy() fail closed: the container is never rm'd", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    state.inspectErrors.set(
      "valmont-sandbox-task1",
      "Error: response from daemon: i/o timeout\n",
    );
    const callsBefore = state.calls.length;
    await expect(provider.destroy("task1")).rejects.toThrow(
      "Task workspace state could not be determined",
    );
    // Only the FAILED inspect ran after the gate; no removal happened
    // (create's own pre-cleanup rm calls are the no-op not-found ones
    // recorded before this snapshot).
    const rmsAfter = state.calls
      .slice(callsBefore)
      .filter((c) => c.command === "docker" && c.args[0] === "rm");
    expect(rmsAfter).toHaveLength(0);
    expect(state.containers.has("valmont-sandbox-task1")).toBe(true);
    // destroy must not have recorded activity while failing.
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    state.inspectErrors.delete("valmont-sandbox-task1");
    // Once the daemon is reachable again, the teardown completes.
    await provider.destroy("task1");
    expect(state.containers.has("valmont-sandbox-task1")).toBe(false);
  });

  it("a create whose follow-up inspect is unknown still quarantines (the failed-create catch never skips quarantine)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    // Setup fails (reaper staging) and the removal fails too (busy):
    // the half-initialized container survives. The OLD code then
    // inspected the container and skipped quarantine unless the
    // inspect clearly showed existence — an UNKNOWN inspect (daemon
    // timeout) skipped it, leaving a half-initialized container
    // openable. The new code quarantines UNCONDITIONALLY in the
    // failure catch (its own durable host marker blocks every open
    // even when every docker call is ambiguous).
    state.cpFailures = 1;
    const ORIGINAL = "valmont-sandbox-task1";
    state.onRm = (name) => {
      if (name === ORIGINAL && state.containers.has(name)) {
        state.rmErrors.set(
          name,
          "Error: removing container: device or resource busy\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    // Quarantine was NOT skipped: the half-initialized container is
    // either removed, durably renamed (the daemon marker), or marked
    // host-side — every later open() rejects. Here the container was
    // renamed by the daemon, so this instance, a FRESH instance, and a
    // same-identity restart are all blocked.
    const renamed = state.containers.has("valmont-sandbox-task1-quarantined");
    const hostMarked = existsSync(path.join(leaseDir, "task1.quarantined"));
    expect(renamed || hostMarked).toBe(true);
    await expect(provider.open("task1")).rejects.toThrow(
      /quarantined|Task workspace is unavailable/,
    );
    await expect(
      makeProvider(state, { leaseDir }).open("task1"),
    ).rejects.toThrow("Task workspace is quarantined");
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
  });

  it("a failed create quarantines even when the follow-up existence inspect is UNKNOWN (catch never skips quarantine)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    state.cpFailures = 1;
    // Removal succeeds immediately (no busy) — but force every
    // combined inspect after the first gate to an UNKNOWN result: the
    // old catch consulted the follow-up inspect and skipped quarantine
    // whenever it did not clearly show an existing container, which
    // an UNKNOWN result masqueraded as. The new catch quarantines
    // unconditionally.
    let combined = 0;
    state.onInspect = (_name, format) => {
      if (format.startsWith("{{.State.Running}}|")) {
        combined += 1;
        if (combined >= 2) {
          state.inspectErrors.set(
            "valmont-sandbox-task1",
            "Error: response from daemon: request timed out\n",
          );
          state.inspectErrors.set(
            "valmont-sandbox-task1-quarantined",
            "Error: response from daemon: request timed out\n",
          );
        }
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    // The in-memory flag is set regardless of the ambiguous inspect.
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    // The host marker was written before the docker calls and is only
    // retired when a container state is confirmed gone/durable: UNKNOWN
    // inspect results never retire it, so it stays and blocks every
    // open() on every instance even when the daemon answers
    // ambiguously.
    expect(existsSync(path.join(leaseDir, "task1.quarantined"))).toBe(true);
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    await expect(
      makeProvider(state, { leaseDir }).open("task1"),
    ).rejects.toThrow("Task workspace is quarantined");
  });

  it("concurrent adoption of an unlabeled container: exactly one instance gets a handle", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 5_000,
      fenceReapWaitMs: 2_000,
      fenceOwnerWaitMs: 8_000,
      timeoutMs: 2_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 5_000,
      fenceReapWaitMs: 2_000,
      fenceOwnerWaitMs: 8_000,
      timeoutMs: 2_000,
    });
    seedContainer(state, "valmont-sandbox-task9", {
      "valmont.task": "task9",
    });
    // Both instances open the SAME unlabeled container concurrently:
    // the fence serializes the adoption claim, so exactly one
    // succeeds with a handle and the other rejects (the winner
    // immediately stamps liveness; the loser sees a claimed
    // unlabeled container whose claim names the winner).
    const results = await Promise.allSettled([
      a.open("task9"),
      b.open("task9"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as Error;
    // The loser of the atomic adoption sees the winner's fresh claim
    // (the in-fence lease read) and rejects with the ownership error.
    expect(error.message).toMatch(
      /owned by another|state could not be determined/,
    );
    // The lease names exactly the winning instance.
    const lease = JSON.parse(
      readFileSync(path.join(leaseDir, "task9.lease"), "utf8"),
    );
    expect(["instance-a", "instance-b"]).toContain(lease.instanceId);
    // The container still exists (no rm raced the adoption).
    expect(state.containers.has("valmont-sandbox-task9")).toBe(true);
  });

  it("an owner lease refresh during the reaper's post-check await makes the removal defer (TOCTOU closed by the fence)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 3_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 3_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    await a.create("task7", src);
    // Rewind A's lease to STALE so B's routing chooses "age" (the
    // owner presumed dead) — the exact premise of the old TOCTOU: the
    // reaper checked a stale lease, awaited another inspect, and rm'd
    // without re-checking. A live owner refreshing its claim during
    // that await would lose its live workspace.
    writeFileSync(
      path.join(leaseDir, "task7.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-task7",
        taskId: "task7",
      }),
    );
    state.psLines = [
      "valmont-sandbox-task7\ttask7\tinstance-a\t/valmont-sandbox-task7",
    ];
    // THE TOCTOU WINDOW: a live owner holds the cross-instance fence
    // (as any in-flight owner operation does — see
    // withOwnerTaskOperation) while B's sweep is past its stale-lease
    // routing and enters the destructive path. The old code checked
    // the lease, awaited a Docker inspect, then rm'd without ever
    // re-checking — a lease refresh (or an in-flight owner op, as
    // here) during that await lost its workspace. The fence closes
    // the window: B's destructive body cannot acquire the fence and
    // skips this interval.
    const held = await internals(a).acquireTaskFence("task7", "owner");
    expect(held?.active).toBe(true);
    try {
      await internals(b).reapExpired();
      // The live workspace is untouched despite the stale routing
      // premise.
      expect(state.containers.has("valmont-sandbox-task7")).toBe(true);
    } finally {
      await held!.release();
    }
    // And with the owner now genuinely gone (no refresh), the very
    // next sweep does reap by age — the control in the companion
    // test: fencing defers live owners, never dead ones.
  });

  it("the reaper removes a truly dead foreign container only when no fresh claim exists (control for the TOCTOU test)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 2_000,
    });
    // Old, foreign, genuinely abandoned.
    state.containers.add("valmont-sandbox-taskX");
    state.createdAt.set("valmont-sandbox-taskX", OLD_CREATED);
    state.labels.set("valmont-sandbox-taskX", {
      "valmont.task": "taskX",
      "valmont.instance": "instance-dead",
    });
    await (
      b as unknown as { __testClearFences(): Promise<void> }
    ).__testClearFences();
    writeFileSync(
      path.join(leaseDir, "taskX.lease"),
      JSON.stringify({
        instanceId: "instance-dead",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-taskX",
        taskId: "taskX",
      }),
    );
    // Derived listing (no psLines override): name from container state.
    await internals(b).reapExpired();
    // No refreshing owner and no held fence: the stale-lease, old-age
    // container IS reaped.
    expect(state.containers.has("valmont-sandbox-taskX")).toBe(false);
  });

  it("the reaper's destructive removal waits for the cross-instance fence (TOCTOU closed)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 3_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 3_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    await a.create("task8", src);
    await sleep(450);
    // A holds the fence for a slow read; B's age-routed removal must
    // NOT remove while the fence is held (and with a 3 s reap wait,
    // it must skip this interval rather than race).
    state.statResults.set("/workspace/a.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/a.txt", {
      code: 0,
      stdout: "x\n",
      stderr: "",
    });
    state.execDelays.set("cat", 4_500);
    // A's lease reads fresh but the container is OLD by routing — use
    // a 2-column listing (routing "mine")? No: B must age-route, but
    // the FENCE must protect A. Achieve age routing with an
    // instance-column line and a stale lease, while A's slow read
    // holds the fence and keeps REFRESHING nothing (operations do not
    // heartbeat — but A holds the fence). B skips because it cannot
    // acquire the fence within reap wait.
    writeFileSync(
      path.join(leaseDir, "task8.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-task8",
        taskId: "task8",
      }),
    );
    state.psLines = [
      "valmont-sandbox-task8\ttask8\tinstance-a\t/valmont-sandbox-task8",
    ];
    const read = a.readFile({ id: "task8", root: "/workspace" }, "a.txt");
    await sleep(300); // let the read acquire the fence
    await internals(b).reapExpired(); // must NOT rm (fence held)
    await read;
    expect(state.containers.has("valmont-sandbox-task8")).toBe(true);
  });

  it("replacement creation racing a reaper's lease deletion never loses the new owner's lease", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // B reaps an A container; B's generation-aware delete may only
    // remove a lease naming the removed container. When A replaces the
    // task immediately after the removal (a new container, a new lease
    // generation), the new lease survives.
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
    });
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
    });
    seedContainer(state, "valmont-sandbox-taskP", {
      "valmont.task": "taskP",
      "valmont.instance": "instance-a",
    });
    // Start each cross-instance scenario with a clean fence namespace:
    // a leftover lock from an earlier test must not turn the reaper
    // fail-closed in this sweep.
    await (
      b as unknown as { __testClearFences(): Promise<void> }
    ).__testClearFences();
    state.psLines = [
      "valmont-sandbox-taskP\ttaskP\tinstance-a\t/valmont-sandbox-taskP",
    ];
    // Stale A lease (dead owner).
    writeFileSync(
      path.join(leaseDir, "taskP.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-taskP",
        taskId: "taskP",
      }),
    );
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-taskP")).toBe(false);
    // Now A creates a replacement: a fresh lease for the new
    // generation lands under the same task file name.
    const src = await makeSource({ "a.txt": "x" });
    await a.create("taskP", src);
    expect(state.containers.has("valmont-sandbox-taskP")).toBe(true);
    const lease = JSON.parse(
      readFileSync(path.join(leaseDir, "taskP.lease"), "utf8"),
    );
    expect(lease.instanceId).toBe("instance-a");
    expect(lease.containerName).toBe("valmont-sandbox-taskP");
    // B's earlier (stale-generation) delete must not have left state
    // that later removes the new lease: a follow-up B sweep with the
    // fresh foreign lease SKIPS — the container and its new lease
    // survive.
    state.psLines = [
      "valmont-sandbox-taskP\ttaskP\tinstance-a\t/valmont-sandbox-taskP",
    ];
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-taskP")).toBe(true);
    expect(existsSync(path.join(leaseDir, "taskP.lease"))).toBe(true);
    const afterLease = JSON.parse(
      readFileSync(path.join(leaseDir, "taskP.lease"), "utf8"),
    );
    expect(afterLease.instanceId).toBe("instance-a");
  });

  it("rejected foreign operations never write or refresh the owner lease", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    await a.create("task3", src);
    const leasePath = path.join(leaseDir, "task3.lease");
    const before = readFileSync(leasePath, "utf8");
    const mtimeBefore = lstatSyncSafe(leasePath);
    await sleep(20);
    // B's rejected foreign attempts must not touch A's lease.
    await expect(b.open("task3")).rejects.toThrow("owned by another");
    await expect(b.create("task3", src)).rejects.toThrow("owned by another");
    await expect(b.destroy("task3")).rejects.toThrow("owned by another");
    await expect(
      b.readFile({ id: "task3", root: "/workspace" }, "a.txt"),
    ).rejects.toThrow("owned by another");
    const after = readFileSync(leasePath, "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after).instanceId).toBe("instance-a");
    expect(lstatSyncSafe(leasePath)).toBe(mtimeBefore);
    // The container is intact.
    expect(state.containers.has("valmont-sandbox-task3")).toBe(true);
  });

  it("an unreadable lease (EACCES/EIO) fails closed to skip, never to age reap", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 300_000,
    });
    seedContainer(state, "valmont-sandbox-taskU", {
      "valmont.task": "taskU",
      "valmont.instance": "instance-b",
    });
    await (
      provider as unknown as { __testClearFences(): Promise<void> }
    ).__testClearFences();
    // A lease FILE exists but is unreadable (EACCES): an unknown
    // ownership state, not absence.
    const leasePath = path.join(leaseDir, "taskU.lease");
    writeFileSync(leasePath, JSON.stringify({ instanceId: "instance-b" }));
    chmodForce(leasePath, 0o000);
    try {
      state.psLines = [
        "valmont-sandbox-taskU\ttaskU\tinstance-b\t/valmont-sandbox-taskU",
      ];
      await internals(provider).reapExpired();
      // The container must be LEFT ALONE: unreadable ≠ owner dead.
      expect(state.containers.has("valmont-sandbox-taskU")).toBe(true);
    } finally {
      chmodForce(leasePath, 0o600);
    }
  });

  it("lease contents are validated semantically (empty id, NaN, insane/future timestamps, wrong identity => corrupt => skip)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 300_000,
    });
    seedContainer(state, "valmont-sandbox-task6", {
      "valmont.task": "task6",
      "valmont.instance": "instance-b",
    });
    await (
      provider as unknown as { __testClearFences(): Promise<void> }
    ).__testClearFences();
    const leasePath = path.join(leaseDir, "task6.lease");
    const corruptions: Array<[string, unknown]> = [
      ["empty instance id", { instanceId: "  ", updatedAt: Date.now() }],
      ["NaN timestamp", { instanceId: "instance-b", updatedAt: Number.NaN }],
      ["negative timestamp", { instanceId: "instance-b", updatedAt: -5 }],
      ["year-1970 timestamp", { instanceId: "instance-b", updatedAt: 1 }],
      [
        "far-future timestamp",
        { instanceId: "instance-b", updatedAt: Date.now() + 10_000_000_000 },
      ],
      [
        "wrong container identity",
        {
          instanceId: "instance-b",
          updatedAt: Date.now(),
          containerName: "valmont-sandbox-OTHER",
        },
      ],
      [
        "wrong task identity",
        {
          instanceId: "instance-b",
          updatedAt: Date.now(),
          containerName: "valmont-sandbox-task6",
          taskId: "other-task",
        },
      ],
    ];
    for (const [label, body] of corruptions) {
      seedContainer(state, "valmont-sandbox-task6", {
        "valmont.task": "task6",
        "valmont.instance": "instance-b",
      });
      writeFileSync(leasePath, JSON.stringify(body));
      state.psLines = [
        "valmont-sandbox-task6\ttask6\tinstance-b\t/valmont-sandbox-task6",
      ];
      await internals(provider).reapExpired();
      expect(
        state.containers.has("valmont-sandbox-task6"),
        `corrupt lease (${label}) must skip, never reap`,
      ).toBe(true);
    }
  });

  it("a lease write failure degrades safely (owner proceeds; the reaper never removes)", async () => {
    const state = makeState();
    // A lease directory that is created but then made unwritable: the
    // owner's heartbeat/claim cannot land; an operation still proceeds
    // (best-effort liveness), but the reaper can no longer acquire its
    // fence and therefore fails closed — no removal.
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const src = await makeSource({ "a.txt": "x" });
    // Create itself also writes a lease post-setup; point the provider
    // at a read-only lease directory BEFORE construction.
    chmodForce(path.join(leaseDir), 0o500);
    try {
      const p2 = makeProvider(state, {
        leaseDir,
        fenceReapWaitMs: 100,
      });
      // Owner operations still function (liveness writes are best
      // effort).
      const handle = await p2.create("taskW", src);
      expect(handle.id).toBe("taskW");
      // Old by age...
      state.containers.add("valmont-sandbox-old1");
      state.createdAt.set("valmont-sandbox-old1", OLD_CREATED);
      state.psLines = ["valmont-sandbox-old1\told1"];
      await internals(p2).reapExpired();
      // The reaper cannot fence: no destructive rm must occur.
      expect(state.containers.has("valmont-sandbox-old1")).toBe(true);
    } finally {
      chmodForce(leaseDir, 0o700);
    }
  });

  it("a successful destroy() leaves no lease, no activity, no marker", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskD", src);
    expect(existsSync(path.join(leaseDir, "taskD.lease"))).toBe(true);
    await provider.destroy("taskD");
    expect(existsSync(path.join(leaseDir, "taskD.lease"))).toBe(false);
    expect(existsSync(path.join(leaseDir, "taskD.quarantined"))).toBe(false);
    expect(internals(provider).taskActivity.has("taskD")).toBe(false);
    expect(state.containers.has("valmont-sandbox-taskD")).toBe(false);
    // A completion refresh after destroy must not RESURRECT the lease
    // (the old bug: withTaskLock's finally re-wrote it).
    await sleep(20);
    expect(existsSync(path.join(leaseDir, "taskD.lease"))).toBe(false);
  });

  it("inspect/cleanup race: another instance creating after the initial probe can never be removed", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 2_000,
    });
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceReapWaitMs: 2_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    // B creates the task first; then the container vanishes (modeling
    // the scenario in which B's destroy probe misses it), and — while
    // B's destroy is between its ownership probe and its rm — A
    // creates a replacement. The old code rm'd by name without an
    // ownership decision, so the rm could remove A's freshly created
    // container. With the cross-instance fence, B's destroy
    // (probe + rm) and A's create (probe + create + setup) are
    // MUTUALLY EXCLUSIVE: either B runs first (nothing exists; A's
    // create afterwards succeeds and survives) or A's create runs
    // first (B's gate sees the RUNNING foreign container and refuses
    // to remove it).
    await b.create("taskR", src);
    // The old-container drops out (simulate an operator removal).
    state.containers.delete("valmont-sandbox-taskR");
    state.createdAt.delete("valmont-sandbox-taskR");
    state.labels.delete("valmont-sandbox-taskR");
    state.stopped.delete("valmont-sandbox-taskR");
    // Interleave A's create with B's destroy: whichever order the
    // fence admits, the assertion below must hold.
    const destroy = b.destroy("taskR");
    const create = a.create("taskR", src);
    await Promise.allSettled([destroy, create]);
    expect(state.containers.has("valmont-sandbox-taskR")).toBe(true);
    // A's container is the one present (its create stamped the label),
    // and a subsequent B destroy on that RUNNING foreign container
    // must refuse to remove it.
    expect(
      state.labels.get("valmont-sandbox-taskR")?.["valmont.instance"],
    ).toBe("instance-a");
    await expect(b.destroy("taskR")).rejects.toThrow(
      "owned by another provider instance",
    );
    expect(state.containers.has("valmont-sandbox-taskR")).toBe(true);
  });

  it("stop-fallback with an ambiguous/timeout result leaves a marker that blocks a same-identity restart from reopening", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // A stable identity (the documented restart case): same
    // instanceId, fresh provider object.
    const mk = () =>
      makeProvider(state, {
        instanceId: "stable-id",
        leaseDir,
        fenceReapWaitMs: 3_000,
      });
    const provider = mk();
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("taskS", src);
    // Cleanup fails, rename fails, AND the stop call times out (the
    // CLI reports failure ambiguously) — the container is still
    // RUNNING. The host-side durable marker must be retained and a
    // same-identity restart must NOT reopen the live container.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      "valmont-sandbox-taskS",
      "Error: removing container: device or resource busy\n",
    );
    state.renameErrors.set(
      "valmont-sandbox-taskS",
      "Error: renaming container: daemon error\n",
    );
    state.stopErrors.set(
      "valmont-sandbox-taskS",
      "Error: response from daemon: request timed out\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The container survived and is STILL RUNNING (stop was
    // ambiguous).
    expect(state.containers.has("valmont-sandbox-taskS")).toBe(true);
    expect(state.stopped.has("valmont-sandbox-taskS")).toBe(false);
    // This instance rejects.
    await expect(provider.open("taskS")).rejects.toThrow("quarantined");
    // A RESTARTED provider with the SAME stable identity — which would
    // otherwise see its OWN RUNNING container and reopen it — is
    // blocked by the durable host marker.
    const restarted = mk();
    await expect(restarted.open("taskS")).rejects.toThrow("quarantined");
    // ...and a different identity too.
    const other = makeProvider(state, { leaseDir });
    await expect(other.open("taskS")).rejects.toThrow("quarantined");
    // Explicit destroy clears it.
    state.rmErrors.clear();
    state.stopErrors.clear();
    state.renameErrors.clear();
    await restarted.destroy("taskS");
    expect(state.containers.has("valmont-sandbox-taskS")).toBe(false);
    expect(existsSync(path.join(leaseDir, "taskS.quarantined"))).toBe(false);
  });

  it("a long-running owner operation renews its fence: the stale-breaker never takes over a live holder", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // fenceLockTtlMs shorter than the long operation; a holder that
    // did not renew would look stale mid-operation.
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 300,
      fenceOwnerWaitMs: 8_000,
      fenceReapWaitMs: 1_200,
      timeoutMs: 100,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 300,
      fenceOwnerWaitMs: 8_000,
      fenceReapWaitMs: 1_200,
      timeoutMs: 100,
    });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await a.create("taskRenew", src);
    state.statResults.set("/workspace/a.txt", {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set("/workspace/a.txt", {
      code: 0,
      stdout: "x\n",
      stderr: "",
    });
    // A read that lasts ~3 lock TTLs — A's fence must renew.
    state.execDelays.set("cat", 1_000);
    state.psLines = [
      "valmont-sandbox-taskRenew\ttaskRenew\tinstance-a\t/valmont-sandbox-taskRenew",
    ];
    // Rewind the lease to stale so B routes "age" (would remove if it
    // ever got the fence) — the renewal, not the lease, protects it.
    writeFileSync(
      path.join(leaseDir, "taskRenew.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-taskRenew",
        taskId: "taskRenew",
      }),
    );
    const read = a.readFile(ws, "a.txt");
    await sleep(150); // let the read acquire the fence
    await internals(b).reapExpired(); // must NOT remove: fence held + renewed
    const contents = await read;
    expect(contents).toBe("x\n");
    expect(state.containers.has("valmont-sandbox-taskRenew")).toBe(true);
  });

  it("an owner operation FAILS CLOSED (undetermined) when a peer holds the fence past the owner wait — it never runs with an inactive contended fence", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 5_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 5_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    seedContainer(state, "valmont-sandbox-taskLock", {
      "valmont.task": "taskLock",
      "valmont.instance": "instance-a",
    });
    const held = await internals(a).acquireTaskFence("taskLock", "owner");
    expect(held?.active).toBe(true);
    try {
      // B's create waits the full owner window; the live holder never
      // goes stale and the lock cannot be broken — proceeding would
      // mean two fence holders, so B must fail closed.
      const src = await makeSource({ "a.txt": "x" });
      await expect(b.create("taskLock", src)).rejects.toThrow(
        /could not be determined|not be determined/i,
      );
      // The container is untouched (no create/rm leaked past the gate).
      expect(state.containers.has("valmont-sandbox-taskLock")).toBe(true);
      expect(
        state.calls.some(
          (c) => c.command === "docker" && c.args[0] === "create",
        ),
      ).toBe(false);
    } finally {
      await held!.release();
    }
    // After the holder releases, B proceeds (gate sees the foreign
    // running container and rejects with the ownership error — proving
    // the failure above was the contention path, not a dead provider).
    const src = await makeSource({ "a.txt": "x" });
    await expect(b.create("taskLock", src)).rejects.toThrow(
      /owned by another|determined/i,
    );
  });

  it("create() and destroy() honor a completed unlabeled adoption (the claim is persistent, not just fence-timed)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
    });
    seedContainer(state, "valmont-sandbox-taskAdopt", {
      "valmont.task": "taskAdopt",
    });
    // A adopts the legacy container; the adoption's lease claim lands.
    const handle = await a.open("taskAdopt");
    expect(handle.id).toBe("taskAdopt");
    const lease = JSON.parse(
      readFileSync(path.join(leaseDir, "taskAdopt.lease"), "utf8"),
    );
    expect(lease.instanceId).toBe("instance-a");
    expect(typeof lease.generation).toBe("string");
    expect(lease.generation.length).toBeGreaterThan(0);
    // B's create/destroy land at a LATER time (A's fence is long
    // released): the persistent lease claim blocks them.
    const src = await makeSource({ "a.txt": "x" });
    await expect(b.create("taskAdopt", src)).rejects.toThrow(
      /owned by another provider instance/,
    );
    await expect(b.destroy("taskAdopt")).rejects.toThrow(
      /owned by another provider instance/,
    );
    // A handle given to B (cross-instance handle passing) is rejected at
    // the gate too — the claim names A.
    await expect(
      b.readFile({ id: "taskAdopt", root: "/workspace" }, "a.txt"),
    ).rejects.toThrow(/owned by another|could not be determined/i);
    // The container survived every B attempt.
    expect(state.containers.has("valmont-sandbox-taskAdopt")).toBe(true);
  });

  it("an unreadable claim on an unlabeled container fails closed (never adopted over uncertainty)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir, leaseTtlMs: 600_000 });
    seedContainer(state, "valmont-sandbox-taskTorn", {
      "valmont.task": "taskTorn",
    });
    // A torn lease: an adoption claim that cannot be parsed.
    writeFileSync(path.join(leaseDir, "taskTorn.lease"), '{"instanceId": "');
    await expect(provider.open("taskTorn")).rejects.toThrow(
      /could not be determined/,
    );
    // create/destroy fail closed on the same unreadable claim.
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("taskTorn", src)).rejects.toThrow(
      /could not be determined/,
    );
    await expect(provider.destroy("taskTorn")).rejects.toThrow(
      /could not be determined/,
    );
    // No destructive action happened.
    expect(state.containers.has("valmont-sandbox-taskTorn")).toBe(true);
    expect(
      state.calls.filter((c) => c.command === "docker" && c.args[0] === "rm"),
    ).toHaveLength(0);
  });

  it("a lease write failure WITH a functioning fence fails the owner op closed (no silent live-owner age reap)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      fenceReapWaitMs: 200,
      fenceOwnerWaitMs: 2_000,
    });
    // The .locks fencing dir works, but the LEASE FILE path is
    // blocked (a directory where the file must be): writeLease's
    // tmp+rename cannot publish, readback fails. The fence itself is
    // acquired normally (it lives under .locks), so this is the
    // functioning-fence/write-failed case the reaper's "absent ⇒
    // owner gone" routing would otherwise turn into a live reap.
    mkdirSync(path.join(leaseDir, "taskW.lease"), { recursive: true });
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("taskW", src)).rejects.toThrow(
      /could not be determined/,
    );
    // Create reports FAILURE (nothing is handed out), even though the
    // full setup succeeded — a live container with no durable claim
    // must never be reported as ready. The container is then treated
    // exactly like a half-initialized one: the task is quarantined in
    // memory, so every later operation on THIS instance rejects.
    expect(internals(provider).quarantinedTasks.has("taskW")).toBe(true);
    await expect(provider.open("taskW")).rejects.toThrow(/quarantined/);
    await expect(
      makeProvider(state, { leaseDir }).open("taskW"),
    ).rejects.toThrow(/unavailable|quarantined|determined/);
    // No handle was returned: rm the blocking dir, then an explicit
    // destroy clears the leftover container and the task is usable
    // again on replacement.
    await rm(path.join(leaseDir, "taskW.lease"), {
      recursive: true,
      force: true,
    });
    await provider.destroy("taskW");
    expect(state.containers.has("valmont-sandbox-taskW")).toBe(false);
  });

  it("quarantine surfaces undetermined when NO durable channel survives (marker write, rename, and stop all fail)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      fenceOwnerWaitMs: 500,
      fenceReapWaitMs: 300,
    });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("taskQ", src);
    // Every daemon marker fails ambiguously...
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      "valmont-sandbox-taskQ",
      "Error: removing container: device or resource busy\n",
    );
    state.renameErrors.set(
      "valmont-sandbox-taskQ",
      "Error: renaming container: daemon error\n",
    );
    state.stopErrors.set(
      "valmont-sandbox-taskQ",
      "Error: response from daemon: request timed out\n",
    );
    // ...and the lease VOLUME is unreachable for the duration of the
    // op (0o000): the fence cannot be acquired (degraded — owner ops
    // proceed best-effort since no reaper can fence either), the host
    // marker write fails, and every lease read is unreadable. The
    // validation exec itself fails at spawn (spawnFail above). The
    // quarantine catch must still: set the in-memory flag FIRST (no I/O
    // required), attempt every durable channel — marker write EACCES,
    // rename failure, stop timeout/ambiguous, container confirmed still
    // running — and report UNDETERMINED to the caller.
    chmodForce(path.join(leaseDir), 0o000);
    try {
      await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
        /could not be determined|quarantined|validation/i,
      );
    } finally {
      chmodForce(path.join(leaseDir), 0o700);
    }
    // The in-memory flag still protects THIS process regardless of the
    // durable failure.
    expect(internals(provider).quarantinedTasks.has("taskQ")).toBe(true);
    await expect(provider.open("taskQ")).rejects.toThrow(/quarantined/);
    // The container was never removed/renamed/stopped (all channels
    // failed) and no durable marker could be written; the only remaining
    // protection after a process restart is operator/TTL backstop.
    expect(state.containers.has("valmont-sandbox-taskQ")).toBe(true);
    // Once the daemon cooperates again, explicit destroy clears the
    // container (the flag is removed by a successful teardown) and the
    // task is recoverable.
    state.spawnFail.delete("node");
    state.rmErrors.delete("valmont-sandbox-taskQ");
    state.renameErrors.delete("valmont-sandbox-taskQ");
    state.stopErrors.delete("valmont-sandbox-taskQ");
    await provider.destroy("taskQ");
    expect(state.containers.has("valmont-sandbox-taskQ")).toBe(false);
  });

  it("an empty stale lock directory (crashed mid-acquire) is recovered and the reaper proceeds", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      fenceLockTtlMs: 250,
      fenceReapWaitMs: 200,
      fenceOwnerWaitMs: 2_000,
      timeoutMs: 100,
    });
    state.containers.add("valmont-sandbox-taskEmpty");
    state.createdAt.set("valmont-sandbox-taskEmpty", OLD_CREATED);
    state.labels.set("valmont-sandbox-taskEmpty", {
      "valmont.task": "taskEmpty",
    });
    // A lock directory with NO token (an acquire interrupted after
    // mkdir but before its token write), aged past the TTL.
    const lockDir = path.join(leaseDir, ".locks", "taskEmpty.lock");
    mkdirSync(lockDir, { recursive: true });
    await sleep(450); // mtime older than the 250ms fence TTL
    state.psLines = [
      "valmont-sandbox-taskEmpty\ttaskEmpty\t<no value>\t/valmont-sandbox-taskEmpty",
    ];
    await internals(provider).reapExpired();
    // The stale EMPTY lock was broken (rmdir of an empty dir) and the
    // sweep proceeded to remove the abandoned container.
    expect(state.containers.has("valmont-sandbox-taskEmpty")).toBe(false);
  });

  it("lease generation: a teardown never unlinks a lease whose generation differs from the container it removed", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskGen", src);
    const leasePath = path.join(leaseDir, "taskGen.lease");
    const first = JSON.parse(readFileSync(leasePath, "utf8"));
    expect(typeof first.generation).toBe("string");
    expect(first.generation.length).toBeGreaterThan(0);
    // Direct generation-aware delete: an UNEXPECTED generation leaves
    // the lease in place (defense in depth for the fenced teardown —
    // a replacement owner's fresh lease can never be unlinked).
    const intern = internals(provider) as unknown as {
      deleteLease(
        taskId: string,
        expectedContainerName?: string,
        fence?: unknown,
        expectedGeneration?: string,
      ): Promise<void>;
    };
    await intern.deleteLease(
      "taskGen",
      "valmont-sandbox-taskGen",
      undefined,
      "a-different-generation",
    );
    expect(existsSync(leasePath)).toBe(true);
    // The teardown that DID remove this generation removes its lease.
    await intern.deleteLease(
      "taskGen",
      "valmont-sandbox-taskGen",
      undefined,
      first.generation,
    );
    expect(existsSync(leasePath)).toBe(false);
  });

  it("handle methods reject reserved/invalid task ids from a forged handle", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    await expect(
      provider.readFile({ id: "foo-quarantined", root: "/workspace" }, "a.txt"),
    ).rejects.toThrow("Invalid task identifier");
    await expect(
      provider.writeFile({ id: "../escape", root: "/workspace" }, "a.txt", "x"),
    ).rejects.toThrow("Invalid task identifier");
    await expect(
      provider.deleteFile({ id: "bad id", root: "/workspace" }, "a.txt"),
    ).rejects.toThrow("Invalid task identifier");
    expect(state.calls.filter((c) => c.command === "docker")).toHaveLength(0);
  });
});

describe("validation reaper script (run directly against a synthetic /proc)", () => {
  // The script derives a SUB-SECOND boot epoch (wall clock −
  // /proc/uptime, using the real USER_HZ from `getconf CLK_TCK`) and
  // compares each process's reconstructed start time against the
  // boundary minus a 100 ms error budget. The synthetic /proc below
  // mimics the real kernel domain: its `uptime` and per-pid jiffy
  // counts are consistent with the REAL wall clock at test-run time,
  // so the reconstruction math runs against real values (this machine's
  // HZ — the same one the script will read).
  const HZ = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));

  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  let scriptDir: string | undefined;
  let scriptPromise: Promise<string> | undefined;

  // The script file must outlive every test (it is re-executed in each
  // one), so its directory is NOT part of the per-test cleanup —
  // afterAll removes it.
  function scriptPath(): Promise<string> {
    scriptPromise ??= (async () => {
      scriptDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-script-"));
      const file = path.join(scriptDir, "validation-reap.mjs");
      await fsWriteFile(file, VALIDATION_REAPER_SCRIPT);
      return file;
    })();
    return scriptPromise;
  }

  /**
   * A synthetic `uptime` + `btime` consistent with the real wall clock.
   * The uptime is chosen so the test's boot estimate (Date.now() −
   * uptime) sits ~500 ms into its second: the script's own estimate is
   * the test's plus its startup delay (typically well under 300 ms),
   * and the script's btime consistency window is
   * [btimeMs − 100, btimeMs + 1100) — centered on the second, that
   * passes with headroom.
   */
  function makeTiming(): {
    bootMs: number;
    btimeSec: number;
    uptimeText: string;
  } {
    const nowMs = Date.now();
    const nominalUptimeCsec = 100_000; // 1000 s
    let bootMs = nowMs - nominalUptimeCsec * 10;
    const frac = ((bootMs % 1000) + 1000) % 1000;
    const deltaUptimeCsec = Math.round((frac - 500) / 10);
    const uptimeCsec = nominalUptimeCsec - deltaUptimeCsec;
    bootMs = nowMs - uptimeCsec * 10; // integer ms
    const btimeSec = Math.floor(bootMs / 1000);
    return {
      bootMs,
      btimeSec,
      uptimeText: `${uptimeCsec / 100} 0.00\n`,
    };
  }

  /** Jiffies the kernel would record for a process started at startMs. */
  function jiffiesFor(bootMs: number, startMs: number): number {
    return Math.round(((startMs - bootMs) / 1000) * HZ);
  }

  /**
   * Write a synthetic /proc: /proc/stat (with btime), /proc/uptime, and
   * per-pid stats. `ppid` is stat field 4 — the script uses it to find
   * the container's main process (pid 1's oldest child).
   */
  function writeProc(
    dir: string,
    timing: ReturnType<typeof makeTiming>,
    procs: Array<{
      pid: number;
      state: string;
      ppid: number;
      startJiffies: number;
    }>,
  ): void {
    writeFileSync(
      path.join(dir, "stat"),
      `cpu  0 0 0 0 0 0 0 0 0 0\nbtime ${timing.btimeSec}\n`,
    );
    writeFileSync(path.join(dir, "uptime"), timing.uptimeText);
    for (const p of procs) {
      mkdirSync(path.join(dir, String(p.pid)), { recursive: true });
      // Fields after the parenthesised comm: state(0) ppid(1) pgrp(2)
      // session(3) tty(4) tpgid(5) flags(6) minflt(7) cminflt(8)
      // majflt(9) cmajflt(10) utime(11) stime(12) cutime(13)
      // cstime(14) priority(15) nice(16) num_threads(17)
      // itrealvalue(18) starttime(19).
      const rest = [
        p.state,
        p.ppid,
        0,
        0,
        -1,
        0,
        4194304,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        20,
        0,
        1,
        0,
        p.startJiffies,
      ].join(" ");
      writeFileSync(
        path.join(dir, String(p.pid), "stat"),
        `${p.pid} (fake) ${rest}\n`,
      );
    }
  }

  function runScript(boundary: number, procDir: string, file: string) {
    return new Promise<{ code: number; stderr: string }>((resolve) => {
      execFileCb(
        "node",
        [file, String(boundary)],
        { env: { ...process.env, VALMONT_REAPER_PROC_DIR: procDir } },
        (error, _stdout, stderr) => {
          const code = error
            ? Number(
                (error as NodeJS.ErrnoException & { code?: unknown }).code ?? 1,
              )
            : 0;
          resolve({ code, stderr: stderr ?? "" });
        },
      );
    });
  }

  function spawnLongLivedChild(): ChildProcess {
    const child = spawn("node", ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: "ignore",
    });
    children.push(child);
    return child;
  }

  function waitExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
  }

  /** A pid guaranteed absent on the test host (high range, pid_max-bound). */
  function freePid(): number {
    const real = new Set(
      readdirSync("/proc")
        .filter((e) => /^\d+$/.test(e))
        .map(Number),
    );
    for (let pid = 4194000; pid > 4190000; pid--) {
      if (!real.has(pid)) return pid;
    }
    throw new Error("no free pid found in 4190001..4194000");
  }

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitExit(child);
      }
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (scriptDir) {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("kills a survivor started just after the boundary", async () => {
    const child = spawnLongLivedChild();
    const pid = child.pid!;
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    const boundary = Date.now() - 5000; // the validation started 5 s ago
    const timing = makeTiming();
    // The survivor started 50 ms AFTER the boundary — inside any sane
    // error budget, so it must be killed. (Under the old
    // second-truncated btime reconstruction a survivor like this could
    // appear up to ~1 s early and be missed; the uptime-derived boot
    // time removes that whole error class.)
    const startJiffies = jiffiesFor(timing.bootMs, boundary + 50);
    writeProc(procDir, timing, [{ pid, state: "S", ppid: 7, startJiffies }]);
    const file = await scriptPath();
    const { code, stderr } = await runScript(boundary, procDir, file);
    // The real child is dead: the signal was delivered (same uid). The
    // exit is 1 because the SYNTHETIC stat file is static — the
    // confirmation scan still "sees" state S — which independently
    // proves the process was treated as a bounded survivor (a missed
    // survivor would exit 0 with the child still alive).
    expect(code).toBe(1);
    expect(stderr).toContain(`survivor pid ${pid}`);
    await waitExit(child);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("does not kill a process that started well before the boundary", async () => {
    const child = spawnLongLivedChild();
    const pid = child.pid!;
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    const boundary = Date.now() - 5000;
    const timing = makeTiming();
    // Reconstructed start: boundary − 10 s — far outside the 100 ms
    // error budget.
    const startJiffies = jiffiesFor(timing.bootMs, boundary - 10_000);
    writeProc(procDir, timing, [{ pid, state: "S", ppid: 7, startJiffies }]);
    const file = await scriptPath();
    const { code, stderr } = await runScript(boundary, procDir, file);
    expect(code).toBe(0);
    expect(stderr).not.toContain("survivor");
    // The kill rounds (if any had targeted it) are long past.
    await sleep(400);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
  });

  it("does not kill the container's main process inside the old 2 s margin (the entrypoint regression)", async () => {
    const child = spawnLongLivedChild();
    const pid = child.pid!;
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    const boundary = Date.now() - 5000;
    const timing = makeTiming();
    // Reconstructed start: boundary − 1.5 s — INSIDE the old 2 s
    // margin. Under the old code this process (a container's main
    // process when a validation starts soon after container start) was
    // killed — and killing it stops the container (tini exits when its
    // child does), turning a valid validation into a cleanup failure.
    // Under the new code it is both outside the 100 ms error budget and
    // explicitly excluded as pid 1's oldest child.
    const startJiffies = jiffiesFor(timing.bootMs, boundary - 1500);
    writeProc(procDir, timing, [{ pid, state: "S", ppid: 1, startJiffies }]);
    const file = await scriptPath();
    const { code, stderr } = await runScript(boundary, procDir, file);
    expect(code).toBe(0);
    expect(stderr).not.toContain("survivor");
    await sleep(400);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
  });

  it("excludes the main process even INSIDE the error budget", async () => {
    const child = spawnLongLivedChild();
    const pid = child.pid!;
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    const boundary = Date.now() - 5000;
    const timing = makeTiming();
    // Reconstructed start: boundary − 50 ms — INSIDE the 100 ms error
    // budget, so pure timing would kill it. The explicit exclusion of
    // pid 1's oldest child (the container's main process, which is by
    // definition pre-validation) is what protects it: this is the
    // validation-starts-~100-ms-after-container-start case.
    const startJiffies = jiffiesFor(timing.bootMs, boundary - 50);
    writeProc(procDir, timing, [{ pid, state: "S", ppid: 1, startJiffies }]);
    const file = await scriptPath();
    const { code, stderr } = await runScript(boundary, procDir, file);
    expect(code).toBe(0);
    expect(stderr).not.toContain("survivor");
    await sleep(400);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
  });

  it("still kills a non-main process inside the error budget (the exclusion is specific)", async () => {
    const child = spawnLongLivedChild();
    const pid = child.pid!;
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    const boundary = Date.now() - 5000;
    const timing = makeTiming();
    // The same young start as the previous test, but NOT a child of pid
    // 1: a process this young that is not the container's main process
    // is by definition part of the validation — it must be killed.
    // (The exclusion never widens to "young processes in general".)
    const startJiffies = jiffiesFor(timing.bootMs, boundary - 50);
    writeProc(procDir, timing, [{ pid, state: "S", ppid: 7, startJiffies }]);
    const file = await scriptPath();
    const { code, stderr } = await runScript(boundary, procDir, file);
    expect(code).toBe(1);
    expect(stderr).toContain(`survivor pid ${pid}`);
    await waitExit(child);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("accepts a zombie survivor (dead: no execution, memory, or descriptors)", async () => {
    const pid = freePid();
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    const boundary = Date.now() - 5000;
    const timing = makeTiming();
    // Started after the boundary, but already a zombie: the PID slot
    // persists until its parent reaps it, so the confirmation must
    // accept state Z.
    const startJiffies = jiffiesFor(timing.bootMs, boundary + 100);
    writeProc(procDir, timing, [{ pid, state: "Z", ppid: 7, startJiffies }]);
    const file = await scriptPath();
    const { code, stderr } = await runScript(boundary, procDir, file);
    expect(code).toBe(0);
    expect(stderr).not.toContain("survivor");
  });

  it("fails closed (exit 2) on a non-integer boundary", async () => {
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    writeProc(procDir, makeTiming(), []);
    const file = await scriptPath();
    const { code } = await runScript(Number.NaN, procDir, file);
    expect(code).toBe(2);
  });

  it("fails closed (exit 1) when /proc/uptime is unreadable", async () => {
    const procDir = await mkdtemp(path.join(tmpdir(), "valmont-reaper-proc-"));
    dirs.push(procDir);
    // /proc/stat (with btime) is present, /proc/uptime is not: start
    // times would be uncomputable.
    writeFileSync(
      path.join(procDir, "stat"),
      `cpu  0 0 0 0 0 0 0 0 0 0\nbtime 1700000000\n`,
    );
    const file = await scriptPath();
    const { code } = await runScript(Date.now() - 5000, procDir, file);
    expect(code).toBe(1);
  });
});
