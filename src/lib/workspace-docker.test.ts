import { randomUUID } from "node:crypto";
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
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  rm,
  mkdtemp,
  link as fsLink,
  readFile as fsReadFile,
  rename as fsRename,
  utimes as fsUtimes,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, afterAll, describe, expect, it } from "vitest";
import {
  DockerWorkspaceProvider,
  VALIDATION_REAPER_SCRIPT,
  type DockerSpawn,
  type DockerWorkspaceOptions,
  type FenceFsSeam,
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
  /**
   * Fired at `docker create` time with the generation-scoped provisional
   * name, BEFORE the create error/late-visibility injections are applied —
   * lets tests arm name-keyed injections (createErrors/lateCreates) whose
   * exact name is only known once the generation is minted.
   */
  onCreate?: (name: string) => void;
  onExec?: (
    name: string,
    cmd: string[],
    user: string,
  ) => ExecResult | undefined;
  /**
   * Immutable container IDs (real Docker semantics: every create mints a
   * unique 64-hex id; the id is stable for the container's whole life,
   * never re-used by a replacement, and accepted by every subcommand in
   * place of a name). `idOf`/`nameOfId` are maintained by create/rename/
   * rm/seed.
   */
  idOf: Map<string, string>;
  nameOfId: Map<string, string>;
  /** Monotonic sequence for minted fake container ids. */
  idSeq: number;
  /**
   * Artificial latency (ms) for non-exec docker subcommands, keyed by the
   * subcommand ("stop", "inspect", "rm", "rename", "create", ...): the
   * child's streams end after the delay. Tests use it to hold a docker
   * operation in flight across a fence-loss or takeover window.
   */
  dockerDelays: Map<string, number>;
  /**
   * LATE CREATE VISIBILITY: a `docker create` request that reports an
   * error (a CLI-level timeout/transport failure) WITHOUT the container
   * being visible yet — the daemon is still processing the request and
   * may register the half-initialized container LATER. The labels and
   * the deferred registration are captured at create time; the test
   * calls `flushLateCreate` to make the container appear at the exact
   * moment the scenario demands (e.g. after the provider's cleanup
   * probes concluded "missing").
   */
  lateCreates: Map<
    string,
    { labels: Record<string, string>; pending: boolean }
  >;
  /**
   * Replacement-acquisition hook: fired when a `docker create` under a
   * RESERVED name would conflict... (not needed — rename/create already
   * model conflicts).
   */
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
    idOf: new Map(),
    nameOfId: new Map(),
    idSeq: 0,
    dockerDelays: new Map(),
    lateCreates: new Map(),
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

/**
 * Resolve a docker CLI reference (a container NAME or its immutable ID)
 * to the tracked container name, mirroring the real daemon's lookup.
 * Injected 2-column ps lines use the name where the id column belongs,
 * so name lookup is the fallback.
 */
function resolveRef(state: FakeState, ref: string): string | undefined {
  const byId = state.nameOfId.get(ref);
  if (byId !== undefined) return byId;
  return state.containers.has(ref) ? ref : undefined;
}

/** Mint a fresh unique immutable container id. */
function newContainerId(state: FakeState): string {
  state.idSeq += 1;
  return `fakeid-${state.idSeq}`;
}

/**
 * Register a container the way the daemon does, with a unique immutable
 * id, creation time, and creation-time labels (immutable afterwards).
 */
function registerContainer(
  state: FakeState,
  name: string,
  labels: Record<string, string>,
): string {
  const id = newContainerId(state);
  state.containers.add(name);
  state.createdAt.set(name, OLD_CREATED);
  state.labels.set(name, labels);
  state.idOf.set(name, id);
  state.nameOfId.set(id, name);
  return id;
}

/** Drop a container's registration (rm), including its id mappings. */
function unregisterContainer(state: FakeState, name: string): void {
  const id = state.idOf.get(name);
  if (id !== undefined) {
    state.nameOfId.delete(id);
  }
  state.idOf.delete(name);
  state.containers.delete(name);
  state.createdAt.delete(name);
  state.labels.delete(name);
  state.stopped.delete(name);
}

/**
 * Flush a LATE create: the daemon finally registers the half-initialized
 * container whose create request failed/timed out earlier. Returns
 * whether a pending create was flushed.
 */
function flushLateCreate(state: FakeState, name: string): boolean {
  const pending = state.lateCreates.get(name);
  if (!pending || !pending.pending) return false;
  pending.pending = false;
  if (!state.containers.has(name)) {
    registerContainer(state, name, pending.labels);
  }
  return true;
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
      delay = state.dockerDelays.get(sub);
      if (sub === "create") {
        const name = args[args.indexOf("--name") + 1];
        state.onCreate?.(name);
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
        const forcedCreate = state.createErrors.get(name);
        const lateCreate = state.lateCreates.get(name);
        if (forcedCreate !== undefined) {
          registerContainer(state, name, labelMap);
          code = 1;
          stderr = forcedCreate;
        } else if (lateCreate !== undefined) {
          // The REQUEST reports a timeout/transport error and the
          // container is NOT visible yet: registration is deferred
          // until the test flushes it (the daemon "finishes" the
          // create later).
          lateCreate.labels = labelMap;
          lateCreate.pending = true;
          code = 1;
          stderr = "Error: create request timed out\n";
        } else {
          const id = registerContainer(state, name, labelMap);
          stdout = `${id}\n`;
        }
      } else if (sub === "start") {
        const ref = args[1];
        const name = resolveRef(state, ref);
        if (name === undefined) {
          code = 1;
          stderr = `Error: No such container: ${ref}\n`;
        } else {
          state.stopped.delete(name);
          stdout = `${ref}\n`;
        }
      } else if (sub === "rm") {
        const ref = args[args.length - 1];
        const name = resolveRef(state, ref);
        // Synchronous hook, fired BEFORE the state change: tests use it to
        // enqueue an operation while the removal is in flight. The hook
        // sees the resolved NAME (hooks are written against names).
        if (name !== undefined) state.onRm?.(name);
        const forced =
          name !== undefined ? state.rmErrors.get(name) : undefined;
        if (name === undefined) {
          // The reference matches nothing: a by-ID rm of an already-gone
          // container reports the reference it was given.
          code = 1;
          stderr = `Error: No such container: ${ref}\n`;
        } else if (forced !== undefined) {
          code = 1;
          stderr = forced;
        } else if (state.containers.has(name)) {
          unregisterContainer(state, name);
          stdout = `${ref}\n`;
        } else {
          code = 1;
          stderr = `Error: No such container: ${ref}\n`;
        }
      } else if (sub === "rename") {
        // `docker rename <old> <new>`: a metadata operation that works
        // on a running OR stopped container (real Docker semantics —
        // it is the provider's durable quarantine marker). The
        // container's other state (creation time, labels) moves with
        // the new name; a failure other than "no such container" leaves
        // the original name in place (the provider's stop fallback
        // then makes the quarantine fail closed).
        const [oldRef, newName] = args.slice(1);
        const oldName = resolveRef(state, oldRef);
        const forcedRename =
          oldName !== undefined ? state.renameErrors.get(oldName) : undefined;
        if (oldName === undefined) {
          code = 1;
          stderr = `Error: No such container: ${oldRef}\n`;
        } else if (forcedRename !== undefined) {
          code = 1;
          stderr = forcedRename;
        } else if (state.containers.has(newName)) {
          code = 1;
          stderr = `Error: renaming container: ${newName} already in use\n`;
        } else {
          const created = state.createdAt.get(oldName);
          const carriedLabels = state.labels.get(oldName);
          const id = state.idOf.get(oldName);
          unregisterContainer(state, oldName);
          state.containers.add(newName);
          if (created !== undefined) {
            state.createdAt.set(newName, created);
          }
          if (carriedLabels !== undefined) {
            state.labels.set(newName, carriedLabels);
          }
          // The immutable ID travels with the renamed container.
          if (id !== undefined) {
            state.idOf.set(newName, id);
            state.nameOfId.set(id, newName);
          }
        }
      } else if (sub === "stop") {
        // `docker stop <ref>`: a real, supported operation; a stopped
        // container reports Running=false (the provider's fail-closed
        // quarantine fallback) and still accepts `rm -f`.
        const ref = args[1];
        const name = resolveRef(state, ref);
        const forcedStop =
          name !== undefined ? state.stopErrors.get(name) : undefined;
        if (name === undefined) {
          code = 1;
          stderr = `Error: No such container: ${ref}\n`;
        } else if (forcedStop !== undefined) {
          code = 1;
          stderr = forcedStop;
        } else {
          state.stopped.add(name);
          stdout = `${ref}\n`;
        }
      } else if (sub === "inspect") {
        const format = args[args.indexOf("--format") + 1];
        const ref = args[args.length - 1];
        const name = resolveRef(state, ref) ?? ref;
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
          '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}|{{index .Config.Labels "valmont.generation"}}|{{index .Config.Labels "valmont.epoch"}}|{{.Name}}'
        ) {
          // The combined open/create/destroy/gate probe (generation +
          // epoch scoped). Missing labels render as "<no value>" (Go
          // template behavior, mirrored exactly — the provider treats
          // that as "no label"). The ID column is the container's
          // immutable identity, which the provider binds its
          // rm/rename/stop/exec references to. `.Name` carries the
          // leading "/" the real daemon renders.
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
            stdout = `${state.idOf.get(name) ?? name}|${running}|${
              labels["valmont.task"] ?? "<no value>"
            }|${labels["valmont.instance"] ?? "<no value>"}|${
              labels["valmont.generation"] ?? "<no value>"
            }|${labels["valmont.epoch"] ?? "<no value>"}|/${name}\n`;
          }
        } else if (
          format ===
          '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}'
        ) {
          // The LEGACY combined probe (pre-generation protocol): kept
          // so migration tests can seed old-protocol fixtures.
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
            stdout = `${state.idOf.get(name) ?? name}|${running}|${
              labels["valmont.task"] ?? "<no value>"
            }|${labels["valmont.instance"] ?? "<no value>"}\n`;
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
        // daemon would list it, with the container's immutable ID in
        // the first column. Injected lines override (tests that pin a
        // specific listing; a 2-column injected line's "id" is the
        // name, which resolveRef falls back to).
        const lines =
          state.psLines.length > 0
            ? state.psLines
            : [...state.containers].map((n) => {
                const labels = state.labels.get(n) ?? {};
                return `${state.idOf.get(n) ?? n}\t${
                  labels["valmont.task"] ?? "<no value>"
                }\t${labels["valmont.instance"] ?? "<no value>"}\t${
                  labels["valmont.generation"] ?? "<no value>"
                }\t${labels["valmont.epoch"] ?? "<no value>"}\t/${n}`;
              });
        stdout = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
      } else if (sub === "cp") {
        const dest = args[2];
        const ref = dest.split(":")[0];
        const name = resolveRef(state, ref);
        if (name === undefined) {
          code = 1;
          stderr = `Error: No such container: ${ref}\n`;
        } else if (state.cpFailures > 0) {
          state.cpFailures -= 1;
          code = 1;
          stderr = "Error: cp: daemon error\n";
        } else {
          state.cpDestinations.push(dest);
        }
      } else if (sub === "exec") {
        // The exec reference follows "--workdir /workspace": it is the
        // immutable container ID for every gated/setup exec.
        const ref = args[args.indexOf("--workdir") + 2];
        const name = resolveRef(state, ref);
        if (name === undefined) {
          code = 1;
          stderr = `Error: No such container: ${ref}\n`;
        } else if (state.stopped.has(name)) {
          // Real Docker refuses exec into a stopped container: no
          // operation can race a quarantined (stopped) container.
          code = 1;
          stderr = `Error: container ${name} is not running\n`;
        } else {
          const cmd = args.slice(args.indexOf(ref) + 1);
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
): string {
  // Re-seeding an existing name keeps its identity (the daemon never
  // re-uses an id while the container lives).
  if (state.containers.has(name)) return state.idOf.get(name) ?? name;
  return registerContainer(state, name, { ...labels });
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

/**
 * A held fence as the race tests need to see it: the public active/
 * release shape plus the token path and the sticky loss flag.
 */
interface FenceHandle extends HeldFenceLike {
  lost?: boolean;
  tokenFile?: string;
}

/** All entries in a fence lock directory (normally exactly one token). */
const lockEntries = (lockDir: string): string[] =>
  existsSync(lockDir) ? readdirSync(lockDir) : [];

/** The single token file inside a lock directory, when there is exactly one. */
const tokenPathOf = (lockDir: string): string | null => {
  const entries = lockEntries(lockDir);
  return entries.length === 1 ? path.join(lockDir, entries[0]!) : null;
};

/**
 * Simulate a COMPLETED stale-break of a holder's fence: the token is
 * removed, the lock directory is reclaimed, and a replacement holder's
 * token is installed. Everything after this point must fail closed for
 * the old holder and never touch the replacement's state.
 */
const breakFenceAndReplace = (lockDir: string): string => {
  const token = tokenPathOf(lockDir);
  if (token) rmSync(token, { force: true });
  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  const replacement = path.join(lockDir, "replacement-token");
  writeFileSync(replacement, "peer\n");
  return replacement;
};

/** Poll until predicate() holds (bounded) — used to catch mid-flight states. */
const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(25);
  }
};

/** An fs error carrying a specific errno code (for the FenceFsSeam overrides). */
const errnoFailure = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`injected ${code} failure`), {
    code,
  }) as NodeJS.ErrnoException;

/**
 * Build an fsOverride whose mkdir rejects with the given errno for every
 * path under the coordination `.locks` namespace (the fence itself), while
 * every other operation hits the real filesystem.
 */
const failingLocksMkdir = (code: string): Partial<FenceFsSeam> => ({
  mkdir: (p, options) =>
    p.includes(`${path.sep}.locks`)
      ? Promise.reject(errnoFailure(code))
      : mkdir(p, options),
});

/** lstat mtime ms (a cheap change-detection token for lease files). */
const lstatSyncSafe = (file: string): number => lstatSync(file).mtimeMs;

/**
 * Read every published `.json` record under a coordination subdirectory
 * (`mappings`, `leases`, or `quarantines`) for a task. Retained captures
 * (`*.captured.*.tmp`) and publication temps (`*.json.tmp`) are deliberately
 * NOT returned — they are recovery artifacts the provider treats as
 * fail-closed state, asserted separately.
 */
const readRecords = (
  leaseDir: string,
  kind: "mappings" | "leases" | "quarantines",
  taskId: string,
): Array<Record<string, unknown>> => {
  const dir = path.join(leaseDir, kind, taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) =>
      JSON.parse(readFileSync(path.join(dir, entry), "utf8")),
    ) as Array<Record<string, unknown>>;
};

/** The authoritative (unique highest-epoch) mapping record, if any. */
const readAuthoritativeMapping = (
  leaseDir: string,
  taskId: string,
): Record<string, unknown> | undefined => {
  const records = readRecords(leaseDir, "mappings", taskId);
  if (records.length === 0) return undefined;
  const epochs = records.map((r) => r.epoch as number);
  const max = Math.max(...epochs);
  const top = records.filter((r) => (r.epoch as number) === max);
  return top.length === 1 ? top[0] : undefined;
};

/** The durable fencing epochs allocated for a task, ascending. */
const readEpochs = (leaseDir: string, taskId: string): number[] => {
  const dir = path.join(leaseDir, "epochs", taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => a - b);
};

/** The list of entry names (any kind) in a coordination subdirectory. */
const recordEntries = (
  leaseDir: string,
  kind: "mappings" | "leases" | "quarantines",
  taskId: string,
): string[] => {
  const dir = path.join(leaseDir, kind, taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
};

/**
 * The generation-scoped provisional name currently registered for a task
 * (any generation), or undefined. The provider never creates the canonical
 * name, so this is the ONLY name a created container can have.
 */
const containerForTask = (
  state: FakeState,
  taskId: string,
): string | undefined =>
  [...state.containers].find((n) =>
    n.startsWith(`valmont-sandbox-${taskId}--g-`),
  );

/** Write a coordination record (`mappings`/`leases`/`quarantines`) for a task. */
function writeCoordRecord(
  leaseDir: string,
  kind: "mappings" | "leases" | "quarantines",
  taskId: string,
  body: Record<string, unknown>,
): string {
  const dir = path.join(leaseDir, kind, taskId);
  mkdirSync(dir, { recursive: true });
  const entry = `${randomUUID()}.json`;
  writeFileSync(
    path.join(dir, entry),
    JSON.stringify({ schemaVersion: 1, ...body }),
  );
  return entry;
}

/** Seed durable fencing epochs (1..n) for a task, as prior acquisitions would. */
function writeEpochs(leaseDir: string, taskId: string, n: number): void {
  const dir = path.join(leaseDir, "epochs", taskId);
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i += 1) {
    writeFileSync(
      path.join(dir, String(i)),
      JSON.stringify({ epoch: i, allocatedAt: Date.now() }),
    );
  }
}

/**
 * Seed a GENERATION-SCOPED container exactly as the new protocol creates
 * one: provisional name + the five ownership labels, minting a fresh
 * immutable id (or re-using an existing registration). Returns the binding
 * needed to write a matching mapping/lease/quarantine record.
 */
function seedGeneration(
  state: FakeState,
  taskId: string,
  opts: {
    generation?: string;
    epoch?: number;
    instanceId?: string;
    stopped?: boolean;
    containerId?: string;
  } = {},
): { name: string; id: string; generation: string; epoch: number } {
  const generation = opts.generation ?? randomUUID();
  const epoch = opts.epoch ?? 1;
  const name = `valmont-sandbox-${taskId}--g-${generation}`;
  const labels = {
    "valmont.managed": "true",
    "valmont.task": taskId,
    "valmont.instance": opts.instanceId ?? "seed-instance",
    "valmont.generation": generation,
    "valmont.epoch": String(epoch),
  };
  let id: string;
  if (state.containers.has(name)) {
    id = state.idOf.get(name)!;
  } else if (opts.containerId !== undefined) {
    id = opts.containerId;
    registerContainer(state, name, labels);
    state.nameOfId.set(id, name);
    state.idOf.set(name, id);
  } else {
    id = registerContainer(state, name, labels);
  }
  if (opts.stopped) state.stopped.add(name);
  return { name, id, generation, epoch };
}

/** The latest published lease record for a task (any epoch/generation). */
const currentLease = (
  leaseDir: string,
  taskId: string,
): Record<string, unknown> | undefined => {
  const records = readRecords(leaseDir, "leases", taskId);
  if (records.length === 0) return undefined;
  return records.reduce((a, b) =>
    (a.updatedAt as number) >= (b.updatedAt as number) ? a : b,
  );
};

/** The highest-epoch published quarantine record for a task. */
const currentQuarantine = (
  leaseDir: string,
  taskId: string,
): Record<string, unknown> | undefined => {
  const records = readRecords(leaseDir, "quarantines", taskId);
  if (records.length === 0) return undefined;
  return records.reduce((a, b) =>
    (a.epoch as number) >= (b.epoch as number) ? a : b,
  );
};

/**
 * Rewrite a task's lease records so the current lease reads STALE: retire
 * the published records and publish a single stale record matching the
 * authoritative mapping. This is the "owner presumed dead" premise of the
 * reaper TOCTOU tests (the lease is immutable in production, but a crash
 * or long-idle window makes it read stale naturally).
 */
function makeLeaseStale(leaseDir: string, taskId: string): void {
  const dir = path.join(leaseDir, "leases", taskId);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      rmSync(path.join(dir, entry), { force: true });
    }
  }
  const mapping = readAuthoritativeMapping(leaseDir, taskId);
  if (!mapping) return;
  writeCoordRecord(leaseDir, "leases", taskId, {
    taskId,
    epoch: mapping.epoch,
    generation: mapping.generation,
    instanceId: mapping.instanceId,
    provisionalName: mapping.provisionalName,
    containerId: mapping.containerId,
    updatedAt: Date.now() - 30 * 60_000,
  });
}

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
  // The exec reference (container id or name) follows "--workdir
  // /workspace"; the command argv starts right after the reference.
  const idx = c.args.indexOf("--workdir");
  return c.args.slice(idx + 3);
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

  it("rejects operation timeouts that break the documented fence bound (half the TTL, host overhead and fixed Docker timeouts included)", () => {
    // The DOCUMENTED bound is now enforced: a fenced Docker command may
    // run at most floor(TTL/2) - host overhead, and the FIXED Docker
    // operation timeouts (15-60 s) count against that budget too, so a
    // small fence TTL is rejected outright.
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
          timeoutMs: 10_000,
        }),
    ).toThrow(/fenced operation bound|too small/);
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
          timeoutMs: 30_000,
        }),
    ).toThrow(/fenced operation bound|too small/);
    // A long fixed-timeout operation (the default 180 s command timeout)
    // against a small fence TTL is rejected as well.
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
        }),
    ).toThrow(/fenced operation bound|too small/);
    // TTLs too small for ANY fenced command budget (the fixed 15-60 s
    // Docker operation timeouts could not fit in half the TTL).
    expect(
      () => new DockerWorkspaceProvider({ image: "x", fenceLockTtlMs: 300 }),
    ).toThrow(/too small/);
    expect(
      () => new DockerWorkspaceProvider({ image: "x", fenceLockTtlMs: 5_000 }),
    ).toThrow(/too small/);
    // A comfortably bounded timeout inside a valid TTL is accepted:
    // budget = floor(10s/2) - 2s = 3s.
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: 10_000,
          timeoutMs: 2_000,
        }),
    ).not.toThrow();
    // Non-finite/non-positive timing values are rejected.
    expect(
      () => new DockerWorkspaceProvider({ image: "x", timeoutMs: Number.NaN }),
    ).toThrow(/positive finite/);
    expect(
      () => new DockerWorkspaceProvider({ image: "x", timeoutMs: 0 }),
    ).toThrow(/positive finite/);
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          leaseTtlMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/positive finite/);
    expect(
      () => new DockerWorkspaceProvider({ image: "x", ttlMs: -1 }),
    ).toThrow(/positive finite/);
    expect(
      () =>
        new DockerWorkspaceProvider({
          image: "x",
          fenceLockTtlMs: Number.NaN,
        }),
    ).toThrow(/positive finite/);
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
    // The container is created under a GENERATION-SCOPED provisional
    // name — never the canonical `valmont-sandbox-task1` — and stamped
    // with generation + epoch labels bound to this fence acquisition.
    const name = args[args.indexOf("--name") + 1];
    expect(name).toMatch(/^valmont-sandbox-task1--g-[0-9a-f-]{36}$/);
    expect(name).not.toBe("valmont-sandbox-task1");
    const generation = name.slice("valmont-sandbox-task1--g-".length);
    expect(args).toContain(`valmont.generation=${generation}`);
    expect(args).toContain("valmont.epoch=1");
    expect(state.labels.get(name)?.["valmont.instance"]).toBe(
      provider.instanceId,
    );
    expect(state.labels.get(name)?.["valmont.generation"]).toBe(generation);
    expect(state.labels.get(name)?.["valmont.epoch"]).toBe("1");
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
    // The cp destination is bound to the IMMUTABLE container ID.
    expect(cpCall.args[2]).toBe(
      `${state.idOf.get(containerForTask(state, "task1")!)}:/reap/validation-reap.mjs`,
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
      expect(containerForTask(state, "task1")).toBeUndefined();
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
      expect(containerForTask(state, "task2")).toBeUndefined();
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
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    // A container a prior process created and mapped (survives a restart):
    // seed it with the provider's own instance id and the matching
    // coordination records, then open resolves it via the immutable-id
    // resolver.
    const { name, id, generation, epoch } = seedGeneration(state, "task1", {
      instanceId: provider.instanceId,
    });
    writeCoordRecord(provider.leaseDir, "mappings", "task1", {
      taskId: "task1",
      epoch,
      generation,
      instanceId: provider.instanceId,
      provisionalName: name,
      containerId: id,
      publishedAt: Date.now(),
    });
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
    expect(containerForTask(state, "task1")).toBeDefined();
    await provider.destroy("task1");
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    // An orphaned generation container from a previous provider process:
    // managed + generation-scoped, but no mapping references it (the
    // process died before publication). Old creation time.
    seedGeneration(state, "old1", { epoch: 1 });
    await internals(provider).reapExpired();
    expect(containerForTask(state, "old1")).toBeUndefined();
  });

  it("never reaps a task with a fresh activity record", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("busy1", src);
    await internals(provider).reapExpired();
    expect(containerForTask(state, "busy1")).toBeDefined();
  });

  it("defers removal when activity lands between the checks", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500); // let the activity record go stale
    const provisional = containerForTask(state, "task1")!;
    let openPromise: Promise<unknown> | undefined;
    let fired = false;
    state.onInspect = (name, format) => {
      if (
        !fired &&
        name === provisional &&
        format ===
          '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}|{{index .Config.Labels "valmont.generation"}}|{{index .Config.Labels "valmont.epoch"}}|{{.Name}}'
      ) {
        fired = true;
        // Enqueue while the in-fence identity re-check is in flight:
        // fresh activity must abort the removal.
        openPromise = provider.open("task1");
      }
    };
    await internals(provider).reapExpired();
    expect(fired).toBe(true);
    expect(containerForTask(state, "task1")).toBeDefined();
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
    const provisional = containerForTask(state, "task1")!;
    let openPromise: Promise<unknown> | undefined;
    state.onRm = (name) => {
      if (name === provisional) {
        // Enqueue while the rm -f is in flight (the container is still
        // registered, so the enqueue succeeds and records fresh activity).
        openPromise = provider.open("task1");
      }
    };
    await internals(provider).reapExpired();
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    const provisional = containerForTask(state, "task1")!;
    state.rmErrors.set(provisional, "Error: rm: device or resource busy\n");
    await internals(provider).reapExpired();
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    state.rmErrors.delete(provisional);
    await internals(provider).reapExpired();
    expect(containerForTask(state, "task1")).toBeUndefined();
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("skips ps rows with an invalid task label without touching docker", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    seedContainer(state, "valmont-sandbox-old1", { "valmont.task": "old1" });
    state.createdAt.set("valmont-sandbox-old1", OLD_CREATED);
    state.psLines = [
      "badid1\tbad*label\t<no value>\t<no value>\t<no value>\t/badid1",
      "valmont-sandbox-old1\told1\t<no value>\t<no value>\t<no value>\t/valmont-sandbox-old1",
    ];
    state.rmErrors.set("badid1", "Error: rm: daemon error\n");
    await expect(internals(provider).reapExpired()).resolves.toBeUndefined();
    // The invalid-label row was skipped (never rm'd); the valid legacy
    // row after it was processed normally.
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
    expect(containerForTask(state, "task1")).toBeUndefined();
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
      containerForTask(state, "task1")!,
      "Error: rm: device or resource busy\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The container survived the failed rm under its provisional name; the
    // durable marker is the epoch-aware quarantine RECORD (no task-derived
    // rename).
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(currentQuarantine(provider.leaseDir, "task1")).toBeDefined();
    // The live-but-untrusted container must NOT be usable — the
    // quarantine is stricter than "unavailable".
    await expect(provider.readFile(ws, "a.txt")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // The transient removal failure clears: destroy() removes the
    // surviving container and the quarantine record.
    state.rmErrors.clear();
    await provider.destroy("task1");
    expect(containerForTask(state, "task1")).toBeUndefined();
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(false);
  });

  it("create() replaces a quarantined task", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    const provisional = containerForTask(state, "task1")!;
    state.onExec = (_n, cmd) =>
      cmd[0] === "node"
        ? { code: 1, stdout: "", stderr: "survivor\n" }
        : undefined;
    state.rmErrors.set(provisional, "Error: rm: busy\n");
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    // The surviving container kept its provisional name; the durable
    // marker is the epoch-aware quarantine record.
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(currentQuarantine(provider.leaseDir, "task1")).toBeDefined();
    // Replacement: the create-time cleanup now succeeds (the removal
    // error is cleared, and the pre-cleanup removes the surviving
    // container), the quarantine no longer applies, and the new
    // workspace works.
    state.rmErrors.delete(provisional);
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
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    const provisional = containerForTask(state, "task1")!;
    state.inspectErrors.set(provisional, "Error: daemon: request timeout\n");
    await internals(provider).reapExpired();
    // The inspect failure was transient (not "no such object"): the
    // container is still here and the activity record is PRESERVED — an
    // operation may have enqueued while the inspect awaited, and the next
    // interval must not reap a live container on its old creation time.
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    state.inspectErrors.delete(provisional);
    await internals(provider).reapExpired();
    expect(containerForTask(state, "task1")).toBeUndefined();
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("drops the record when the container is truly gone (no such object)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await sleep(500);
    // Removed outside this provider (operator or another process): the
    // removal lands between the reaper's age probe and its in-fence
    // identity re-check, so the re-check observes "no such object" and
    // drops the activity record.
    const provisional = containerForTask(state, "task1")!;
    let removed = false;
    state.onInspect = (name, format) => {
      if (!removed && name === provisional && format === "{{.Created}}") {
        removed = true;
        state.containers.delete(provisional);
      }
    };
    await internals(provider).reapExpired();
    expect(internals(provider).taskActivity.has("task1")).toBe(false);
  });

  it("skips a truncated ps listing instead of partially reaping", async () => {
    const state = makeState();
    // A 40-byte cap truncates the multi-line listing.
    const provider = makeProvider(state, { psListLimitBytes: 40 });
    const g1 = seedGeneration(state, "task1", { epoch: 1 });
    const g2 = seedGeneration(state, "task2", { epoch: 1 });
    state.psLines = [
      `${g1.id}\ttask1\tseed-instance\t${g1.generation}\t1\t/${g1.name}`,
      `${g2.id}\ttask2\tseed-instance\t${g2.generation}\t1\t/${g2.name}`,
    ];
    await internals(provider).reapExpired();
    // The listing was truncated: the suffix (the OLDEST containers, per
    // `docker ps -a` ordering) would be skipped — so the ENTIRE listing
    // is skipped. Nothing may be touched, not even the fully-present
    // first line.
    expect(state.containers.has(g1.name)).toBe(true);
    expect(state.containers.has(g2.name)).toBe(true);
    const createdInspects = state.calls.filter(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "inspect" &&
        c.args.includes("{{.Created}}"),
    );
    expect(createdInspects.length).toBe(0);
    // A provider with the full cap reaps on the next interval — the
    // skip is a deferral, not a waiver.
    state.psLines = [];
    const full = makeProvider(state);
    await internals(full).reapExpired();
    expect(state.containers.has(g1.name)).toBe(false);
    expect(state.containers.has(g2.name)).toBe(false);
  });

  it("quarantine is durable: a fresh instance cannot open a surviving quarantined container", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    const provisional = containerForTask(state, "task1")!;
    // The reaper cannot start AND the container cannot be removed:
    // cleanup failed, so the task is quarantined — and the container
    // SURVIVES, requiring the durable marker.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      provisional,
      "Error: removing container: device or resource busy\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The container survived under its provisional name; the durable
    // marker is the epoch-aware quarantine RECORD in the shared
    // coordination directory.
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(currentQuarantine(provider.leaseDir, "task1")).toBeDefined();
    // A FRESH provider instance (a restart with the same stable id) has
    // no in-memory flag — the shared durable record must do the work.
    const fresh = makeProvider(state, {
      leaseDir: provider.leaseDir,
      instanceId: provider.instanceId,
    });
    expect(internals(fresh).quarantinedTasks.has("task1")).toBe(false);
    await expect(fresh.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // ...and open() adopts the flag so this instance rejects afterwards
    // without another inspect.
    expect(internals(fresh).quarantinedTasks.has("task1")).toBe(true);
    // An explicit destroy() removes the surviving container and clears
    // the quarantine (the transient removal failure has cleared).
    state.rmErrors.clear();
    await fresh.destroy("task1");
    expect(containerForTask(state, "task1")).toBeUndefined();
    expect(internals(fresh).quarantinedTasks.has("task1")).toBe(false);
  });

  it("a failed create() quarantines its unremovable half-initialized container; a successful replacement clears it", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    // Reaper staging fails AND removal fails: create() leaves a
    // half-initialized container (no reaper, no git baseline) that
    // CANNOT be removed.
    state.cpFailures = 1;
    // Force the rm failure only while the (half-initialized) container
    // actually EXISTS: the pre-cleanup sees no container before the
    // create and skips the rm entirely (rm is bound to a re-inspected
    // container id), so the catch-path removal is the one that must fail.
    state.onRm = (name) => {
      const provisional = containerForTask(state, "task1");
      if (!provisional || name !== provisional) return;
      if (state.containers.has(name)) {
        state.rmErrors.set(
          name,
          "Error: removing container: device or resource busy\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    // The half-initialized container survived under its provisional
    // name; the durable quarantine record marks it.
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(currentQuarantine(provider.leaseDir, "task1")).toBeDefined();
    // The quarantine is in effect on this instance...
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // ...and (via the shared durable record) on a restarted instance.
    await expect(
      makeProvider(state, {
        leaseDir: provider.leaseDir,
        instanceId: provider.instanceId,
      }).open("task1"),
    ).rejects.toThrow("Task workspace is quarantined");
    // A replacement whose setup completes fully clears the quarantine:
    // its pre-cleanup removes the surviving half-initialized container
    // (a replacement must not orphan it), and the flag is dropped only
    // after the new setup succeeds.
    state.onRm = undefined; // the removals work now
    state.rmErrors.clear();
    const ws = await provider.create("task1", src);
    const taskNames = [...state.containers].filter((n) =>
      n.startsWith("valmont-sandbox-task1--g-"),
    );
    expect(taskNames).toHaveLength(1);
    expect(currentQuarantine(provider.leaseDir, "task1")).toBeUndefined();
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

  it("a docker create that leaked a container (CLI failure after daemon accept) is an unreachable orphan", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    // The daemon ACCEPTED the container but the CLI reports failure (a
    // timeout mid-create): the container exists, half-initialized, under
    // its generation-scoped provisional name — and it cannot be removed.
    state.onCreate = (name) => {
      if (name.startsWith("valmont-sandbox-task1--g-")) {
        state.createErrors.set(
          name,
          "Error: creating container: request timeout\n",
        );
      }
    };
    state.onRm = (name) => {
      const provisional = containerForTask(state, "task1");
      if (provisional && name === provisional && state.containers.has(name)) {
        state.rmErrors.set(
          name,
          "Error: removing container: device or resource busy\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not create sandbox container",
    );
    // The leaked container survived under its provisional name as an
    // unreachable orphan: no mapping ever references it.
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(
      readAuthoritativeMapping(provider.leaseDir, "task1"),
    ).toBeUndefined();
    // This instance refuses the failed task (quarantined flag); a fresh
    // instance has nothing to open — the orphan is unreachable, not
    // openable.
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    await expect(
      makeProvider(state, {
        leaseDir: provider.leaseDir,
        instanceId: provider.instanceId,
      }).open("task1"),
    ).rejects.toThrow("Task workspace is unavailable");
  });

  it("a quarantine whose container cannot be removed is durable via the epoch-aware record (no rename)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("task1", src);
    const provisional = containerForTask(state, "task1")!;
    // The reaper cannot start and the container cannot be removed: the
    // durable marker is the epoch-aware quarantine RECORD (the protocol
    // never renames to a task-derived name).
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      provisional,
      "Error: removing container: device or resource busy\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // NO task-derived rename was ever issued; the container survived
    // under its provisional name and the record is durable.
    expect(
      state.calls.filter(
        (c) => c.command === "docker" && c.args[0] === "rename",
      ),
    ).toHaveLength(0);
    expect(containerForTask(state, "task1")).toBeDefined();
    expect(currentQuarantine(provider.leaseDir, "task1")).toBeDefined();
    // A fresh instance (no in-memory flag) gets no handle: the shared
    // durable record blocks it.
    const fresh = makeProvider(state, {
      leaseDir: provider.leaseDir,
      instanceId: provider.instanceId,
    });
    await expect(fresh.open("task1")).rejects.toThrow(
      "Task workspace is quarantined",
    );
    // An explicit destroy removes the surviving container and the
    // record — that is how this state gets cleaned up.
    state.rmErrors.clear();
    await fresh.destroy("task1");
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    expect(containerForTask(state, "task1")).toBeDefined();
    // B's reaper sees the container (OLD_CREATED — older than any TTL)
    // but A's lease is FRESH: reaping it would destroy A's live
    // workspace, so B skips it.
    await internals(b).reapExpired();
    expect(containerForTask(state, "task1")).toBeDefined();
    // A dies: its lease stops being refreshed and goes stale. B's
    // reaper may now remove the container by age (the owner is
    // provably gone). Record retirement is generation-aware: B never
    // removes a record naming a different generation (a replacement
    // owner's fresh records must survive a racing teardown).
    await sleep(400);
    await internals(b).reapExpired();
    expect(containerForTask(state, "task1")).toBeUndefined();
    // B never wrote a lease: any retained lease record still names the
    // dead owner, not B.
    const leftOver = readRecords(leaseDir, "leases", "task1");
    if (leftOver.length > 0) {
      expect(leftOver[0]!.instanceId).toBe("instance-a");
    }
  });

  it("a quarantined container is reaped by age by ANY instance, even a live owner", async () => {
    const state = makeState();
    const a = makeProvider(state, { instanceId: "instance-a" });
    const b = makeProvider(state, { instanceId: "instance-b" });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await a.create("task1", src);
    const provisional = containerForTask(state, "task1")!;
    // A quarantines: the reaper cannot start AND the container cannot
    // be removed, so it survives under its provisional name with a
    // durable quarantine record.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      provisional,
      "Error: removing container: device or resource busy\n",
    );
    await expect(a.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    expect(containerForTask(state, "task1")).toBeDefined();
    // The transient "device busy" condition clears once the quarantine
    // gives up: the daemon can remove the container again.
    state.rmErrors.clear();
    // A's lease is FRESH (A is alive and just operated on the task) —
    // yet B's reaper removes the QUARANTINED container anyway: it is
    // unusable by definition (every operation rejects it), so no live
    // user can be racing its removal. (B has its own coordination dir,
    // so the surviving container is an unmapped orphan from B's view.)
    await internals(b).reapExpired();
    expect(containerForTask(state, "task1")).toBeUndefined();
    // B never touched A's lease records.
    expect(readRecords(a.leaseDir, "leases", "task1").length).toBeGreaterThan(
      0,
    );
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
    // it on open and publishes a fresh epoch/generation mapping...
    seedContainer(state, "valmont-sandbox-task1", {
      "valmont.task": "task1",
    });
    const handle = await a.open("task1");
    expect(handle).toEqual({ id: "task1", root: "/workspace" });
    expect(readAuthoritativeMapping(leaseDir, "task1")).toBeDefined();
    // ...and while the claim is fresh, B's reaper skips it (by age it
    // is long overdue: OLD_CREATED).
    await internals(b).reapExpired();
    expect(containerForTask(state, "task1")).toBeDefined();
    // A dies: the claim goes stale, and B reaps the orphan by age.
    await sleep(400);
    await internals(b).reapExpired();
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    expect(containerForTask(state, "task1")).toBeDefined();
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
    const provisional = containerForTask(state, "task1")!;
    state.inspectErrors.set(
      provisional,
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
    expect(containerForTask(state, "task1")).toBeDefined();
    // destroy must not have recorded activity while failing.
    expect(internals(provider).taskActivity.has("task1")).toBe(true);
    state.inspectErrors.delete(provisional);
    // Once the daemon is reachable again, the teardown completes.
    await provider.destroy("task1");
    expect(containerForTask(state, "task1")).toBeUndefined();
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
    // failure catch (the durable epoch-aware record blocks every open
    // even when every docker call is ambiguous).
    state.cpFailures = 1;
    state.onRm = (name) => {
      const provisional = containerForTask(state, "task1");
      if (provisional && name === provisional && state.containers.has(name)) {
        state.rmErrors.set(
          name,
          "Error: removing container: device or resource busy\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    // Quarantine was NOT skipped: the durable record is published, so
    // this instance, a FRESH instance, and a same-identity restart are
    // all blocked.
    expect(currentQuarantine(leaseDir, "task1")).toBeDefined();
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
    // Force the combined inspect after the create to an UNKNOWN result:
    // the old catch consulted the follow-up inspect and skipped
    // quarantine whenever it did not clearly show an existing container,
    // which an UNKNOWN result masqueraded as. The new catch publishes
    // the durable quarantine record BEFORE any docker call, so it
    // quarantines unconditionally.
    state.onInspect = (_name, format) => {
      const provisional = containerForTask(state, "task1");
      if (
        format.startsWith("{{.Id}}|") &&
        provisional &&
        state.containers.has(provisional) &&
        // Arm the UNKNOWN only after reaper staging has been reached (the
        // `cp` call): the create-time verification inspect must still
        // succeed so the sequence reaches the failing `cp`.
        state.calls.some((c) => c.command === "docker" && c.args[0] === "cp")
      ) {
        state.inspectErrors.set(
          provisional,
          "Error: response from daemon: request timed out\n",
        );
      }
    };
    await expect(provider.create("task1", src)).rejects.toThrow(
      "Could not stage the validation reaper",
    );
    // The in-memory flag is set regardless of the ambiguous inspect.
    expect(internals(provider).quarantinedTasks.has("task1")).toBe(true);
    // The durable record was published before the docker calls and is
    // only retired when a container state is confirmed gone/durable:
    // UNKNOWN inspect results never retire it, so it stays and blocks
    // every open() on every instance even when the daemon answers
    // ambiguously.
    expect(currentQuarantine(leaseDir, "task1")).toBeDefined();
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
      fenceLockTtlMs: 8_000,
      fenceReapWaitMs: 2_000,
      fenceOwnerWaitMs: 8_000,
      timeoutMs: 2_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 8_000,
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
    // (the in-fence mapping read) and rejects with the ownership error.
    expect(error.message).toMatch(
      /owned by another|state could not be determined/,
    );
    // The published mapping/lease names exactly the winning instance.
    const lease = currentLease(leaseDir, "task9");
    expect(["instance-a", "instance-b"]).toContain(lease?.instanceId);
    // The container still exists under its adopted provisional name (no
    // rm raced the adoption).
    expect(containerForTask(state, "task9")).toBeDefined();
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
    makeLeaseStale(leaseDir, "task7");
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
      expect(containerForTask(state, "task7")).toBeDefined();
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
    // B must age-route, but the FENCE must protect A. Achieve age
    // routing with a stale lease, while A's slow read holds the fence.
    makeLeaseStale(leaseDir, "task8");
    const read = a.readFile({ id: "task8", root: "/workspace" }, "a.txt");
    await sleep(300); // let the read acquire the fence
    await internals(b).reapExpired(); // must NOT rm (fence held)
    await read;
    expect(containerForTask(state, "task8")).toBeDefined();
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
    // Stale legacy lease (dead owner).
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
    expect(containerForTask(state, "taskP")).toBeUndefined();
    // Now A creates a replacement: a fresh generation + mapping + lease
    // records land under the shared coordination dir.
    const src = await makeSource({ "a.txt": "x" });
    await a.create("taskP", src);
    expect(containerForTask(state, "taskP")).toBeDefined();
    const mapping = readAuthoritativeMapping(leaseDir, "taskP");
    expect(mapping?.instanceId).toBe("instance-a");
    expect(currentLease(leaseDir, "taskP")?.instanceId).toBe("instance-a");
    // B's earlier (stale-generation) retirement must not have left
    // state that later removes the new records: a follow-up B sweep
    // with the fresh foreign lease SKIPS — the container and its new
    // records survive.
    await internals(b).reapExpired();
    expect(containerForTask(state, "taskP")).toBeDefined();
    expect(readAuthoritativeMapping(leaseDir, "taskP")?.instanceId).toBe(
      "instance-a",
    );
    expect(currentLease(leaseDir, "taskP")?.instanceId).toBe("instance-a");
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
    const beforeEntries = recordEntries(leaseDir, "leases", "task3");
    await sleep(20);
    // B's rejected foreign attempts must not touch A's lease records.
    await expect(b.open("task3")).rejects.toThrow("owned by another");
    await expect(b.create("task3", src)).rejects.toThrow("owned by another");
    await expect(b.destroy("task3")).rejects.toThrow("owned by another");
    await expect(
      b.readFile({ id: "task3", root: "/workspace" }, "a.txt"),
    ).rejects.toThrow("owned by another");
    expect(recordEntries(leaseDir, "leases", "task3")).toEqual(beforeEntries);
    expect(currentLease(leaseDir, "task3")?.instanceId).toBe("instance-a");
    // The container is intact.
    expect(containerForTask(state, "task3")).toBeDefined();
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

  it("an unwritable lease directory fails the owner op CLOSED (no docker call; the reaper removes nothing)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const src = await makeSource({ "a.txt": "x" });
    // The lease directory is unwritable (0o500): the token fence cannot
    // be created at all, so cross-instance mutual exclusion is NOT
    // established. The old "degraded coordination, proceed" behavior
    // would run create() unfenced — exactly the two-holders hazard two
    // provider instances must never hit. The operation must fail
    // closed instead (unknown coordination failure, not unavailable:
    // THIS process cannot know whether peers can still fence).
    chmodForce(path.join(leaseDir), 0o500);
    let provider: DockerWorkspaceProvider | undefined;
    try {
      provider = makeProvider(state, {
        leaseDir,
        fenceOwnerWaitMs: 250,
        fenceReapWaitMs: 250,
      });
      await expect(provider.create("taskW", src)).rejects.toThrow(
        /could not be determined/,
      );
      // Fail-closed BEFORE any docker call: nothing was created.
      expect(state.calls.filter((c) => c.command === "docker")).toHaveLength(0);
      // The reaper cannot fence either: an abandoned old container is
      // left for the operator/next interval, never removed.
      state.containers.add("valmont-sandbox-old1");
      state.createdAt.set("valmont-sandbox-old1", OLD_CREATED);
      state.psLines = ["valmont-sandbox-old1\told1"];
      await internals(provider).reapExpired();
      expect(state.containers.has("valmont-sandbox-old1")).toBe(true);
      expect(
        state.calls.filter((c) => c.command === "docker" && c.args[0] === "rm"),
      ).toHaveLength(0);
    } finally {
      chmodForce(leaseDir, 0o700);
    }
    // Once the directory is writable again the provider recovers: the
    // failure above was fail-closed coordination, not a dead provider.
    const handle = await provider!.create("taskW", src);
    expect(handle.id).toBe("taskW");
  });

  it("a successful destroy() leaves no lease, no activity, no marker", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskD", src);
    expect(readRecords(leaseDir, "mappings", "taskD")).toHaveLength(1);
    expect(readRecords(leaseDir, "leases", "taskD").length).toBeGreaterThan(0);
    await provider.destroy("taskD");
    expect(readRecords(leaseDir, "mappings", "taskD")).toHaveLength(0);
    expect(readRecords(leaseDir, "leases", "taskD")).toHaveLength(0);
    expect(readRecords(leaseDir, "quarantines", "taskD")).toHaveLength(0);
    expect(internals(provider).taskActivity.has("taskD")).toBe(false);
    expect(containerForTask(state, "taskD")).toBeUndefined();
    // A completion refresh after destroy must not RESURRECT the lease
    // records (the old bug: withTaskLock's finally re-wrote the lease).
    await sleep(20);
    expect(readRecords(leaseDir, "leases", "taskD")).toHaveLength(0);
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
    const oldName = containerForTask(state, "taskR")!;
    state.containers.delete(oldName);
    state.createdAt.delete(oldName);
    state.labels.delete(oldName);
    state.stopped.delete(oldName);
    // Interleave A's create with B's destroy: whichever order the
    // fence admits, the assertion below must hold.
    const destroy = b.destroy("taskR");
    const create = a.create("taskR", src);
    await Promise.allSettled([destroy, create]);
    expect(containerForTask(state, "taskR")).toBeDefined();
    // A's container is the one present (its create stamped the label),
    // and a subsequent B destroy on that RUNNING foreign container
    // must refuse to remove it.
    expect(
      state.labels.get(containerForTask(state, "taskR")!)?.["valmont.instance"],
    ).toBe("instance-a");
    await expect(b.destroy("taskR")).rejects.toThrow(
      "owned by another provider instance",
    );
    expect(containerForTask(state, "taskR")).toBeDefined();
  });

  it("a failed quarantine record write falls back to a checked stop: the stopped container blocks a same-identity restart", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // A stable identity (the documented restart case): same instanceId,
    // fresh provider object. The durable RECORD write is failed with
    // EIO, so only the STOP fallback can make the quarantine durable.
    const mk = () =>
      makeProvider(state, {
        instanceId: "stable-id",
        leaseDir,
        fenceReapWaitMs: 3_000,
        fsOverride: {
          writeFile: (p, data, options) =>
            p.includes(`${path.sep}quarantines${path.sep}`)
              ? Promise.reject(errnoFailure("EIO"))
              : fsWriteFile(p, data, options),
        },
      });
    const provider = mk();
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("taskS", src);
    const provisional = containerForTask(state, "taskS")!;
    // Cleanup fails, the record write fails (EIO), and the removal
    // fails (busy) — only the STOP fallback remains.
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      provisional,
      "Error: removing container: device or resource busy\n",
    );
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      "Could not complete validation cleanup",
    );
    // The container survived but was STOPPED by the fallback — a
    // durable, daemon-side "do not use" state (Running=false).
    expect(containerForTask(state, "taskS")).toBeDefined();
    expect(state.stopped.has(provisional)).toBe(true);
    const stopCall = state.calls.find(
      (c) => c.command === "docker" && c.args[0] === "stop",
    );
    // The stop is bound to the IMMUTABLE container id, never the name.
    expect(stopCall?.args).toEqual(["stop", state.idOf.get(provisional)!]);
    // This instance rejects.
    await expect(provider.open("taskS")).rejects.toThrow("quarantined");
    // A RESTARTED provider with the SAME stable identity — which would
    // otherwise see its OWN container and reopen it — sees a STOPPED
    // container and refuses.
    const restarted = mk();
    await expect(restarted.open("taskS")).rejects.toThrow(
      /quarantined|unavailable/,
    );
    // Explicit destroy clears it.
    state.rmErrors.clear();
    await restarted.destroy("taskS");
    expect(containerForTask(state, "taskS")).toBeUndefined();
  });

  it("a long-running owner operation renews its fence: the stale-breaker never takes over a live holder", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // TTL 8 s => the renewal heartbeat fires every ~2.67 s. The read
    // below takes ~10 s (six delayed `stat` execs + a delayed `cat`),
    // i.e. LONGER than the fence TTL: a holder that did not renew
    // would be stale-broken mid-operation. timeoutMs stays inside the
    // documented bound (half the TTL minus host overhead = 2 s) so
    // every fenced command fits the fence it runs under.
    const mk = (instanceId: string) =>
      makeProvider(state, {
        instanceId,
        leaseDir,
        leaseTtlMs: 600_000,
        fenceLockTtlMs: 8_000,
        fenceOwnerWaitMs: 500,
        fenceReapWaitMs: 500,
        timeoutMs: 2_000,
      });
    const a = mk("instance-a");
    const b = mk("instance-b");
    const src = await makeSource({ "a/b/c/d/e/f.txt": "x" });
    const ws = await a.create("taskRenew", src);
    // Age the container so a lease-based reap decision would be "old".
    state.createdAt.set(containerForTask(state, "taskRenew")!, OLD_CREATED);
    // Deep read: /workspace + a + b + c + d + e + f.txt => six `stat`
    // execs (1.5 s each) plus the `cat` (1 s) ~= 10 s under one fence.
    const deep = "/workspace/a/b/c/d/e/f.txt";
    for (const dir of [
      "/workspace",
      "/workspace/a",
      "/workspace/a/b",
      "/workspace/a/b/c",
      "/workspace/a/b/c/d",
      "/workspace/a/b/c/d/e",
    ]) {
      state.statResults.set(dir, {
        code: 0,
        stdout: "directory\n",
        stderr: "",
      });
    }
    state.statResults.set(deep, {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set(deep, { code: 0, stdout: "x\n", stderr: "" });
    state.execDelays.set("stat", 1_500);
    state.execDelays.set("cat", 1_000);
    // Rewind the lease to STALE the moment the read is under way (at
    // its first stat): lease freshness can then never explain why B
    // cannot remove the container mid-op — only the RENEWED FENCE can.
    let rewound = false;
    state.onExec = (_n, cmd) => {
      if (cmd[0] === "stat" && !rewound) {
        rewound = true;
        makeLeaseStale(leaseDir, "taskRenew");
      }
      return undefined;
    };
    const lockDir = path.join(leaseDir, ".locks", "taskRenew.lock");
    const read = a.readFile(ws, "a/b/c/d/e/f.txt");
    // Wait until the fence is held, then past the first heartbeat, and
    // sample the token's mtime EARLY (directly observable renewal).
    await waitFor(() => tokenPathOf(lockDir) !== null);
    await sleep(3_300);
    const token = tokenPathOf(lockDir)!;
    const earlyMtime = lstatSync(token).mtimeMs;
    // Renewed within the last heartbeat interval — not the stale
    // acquire-time mtime a non-renewing holder would still carry.
    expect(Date.now() - earlyMtime).toBeLessThan(2_700);
    // B's reaper routes the (now stale) lease by AGE — it would remove
    // the container if it ever got the fence. It must be declined.
    await internals(b).reapExpired();
    expect(containerForTask(state, "taskRenew")).toBeDefined();
    // A direct owner-role takeover attempt by B fails the same way.
    const takeover = await internals(b).acquireTaskFence("taskRenew", "owner");
    expect(takeover?.active).toBe(false);
    // Wait until the final `cat` exec has been issued (the op is about
    // to complete) and sample the token's mtime LATE — while the fence
    // is still held, BEFORE the release removes the token.
    await waitFor(
      () =>
        state.calls.some(
          (c) =>
            c.command === "docker" &&
            c.args[0] === "exec" &&
            c.args.includes("cat"),
        ),
      10_000,
    );
    const lateMtime = lstatSync(token).mtimeMs;
    const contents = await read;
    expect(contents).toBe("x\n");
    expect(rewound).toBe(true);
    expect(lateMtime).toBeGreaterThan(earlyMtime + 2_000);
    expect(Date.now() - lateMtime).toBeLessThan(4_000);
    expect(containerForTask(state, "taskRenew")).toBeDefined();
    // The lease stayed STALE for the whole operation (only the renewed
    // fence protected the container — the renewal is what this test
    // isolates; a lease-freshness explanation is excluded by design).
    const leaseNow = currentLease(leaseDir, "taskRenew");
    expect(Date.now() - (leaseNow?.updatedAt as number)).toBeGreaterThan(
      25 * 60_000,
    );
    // After A released, B CAN acquire the fence: the rejections above
    // were genuine live-holder contention, not a broken provider.
    const later = await internals(b).acquireTaskFence("taskRenew", "owner");
    expect(later?.active).toBe(true);
    await later!.release();
  }, 30_000);

  it("an owner operation FAILS CLOSED (undetermined) when a peer holds the fence past the owner wait — it never runs with an inactive contended fence", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 8_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 8_000,
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
    // A adopts the legacy container; the adoption publishes a fresh
    // generation mapping and a versioned lease claim.
    const handle = await a.open("taskAdopt");
    expect(handle.id).toBe("taskAdopt");
    const lease = currentLease(leaseDir, "taskAdopt");
    expect(lease?.instanceId).toBe("instance-a");
    expect(typeof lease?.generation).toBe("string");
    expect((lease?.generation as string).length).toBeGreaterThan(0);
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
    // The container survived every B attempt (now under its adopted
    // generation-scoped provisional name).
    expect(containerForTask(state, "taskAdopt")).toBeDefined();
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
    // The .locks fencing dir works, but the LEASE publication path is
    // blocked: <leaseDir>/leases is a FILE where the record directory
    // must be, so writeLease's mkdir + tmp/link cannot publish and the
    // readback fails. The fence itself is acquired normally (it lives
    // under .locks), so this is the functioning-fence/lease-write-failed
    // case the reaper's "absent ⇒ owner gone" routing would otherwise
    // turn into a live reap.
    writeFileSync(path.join(leaseDir, "leases"), "blocked");
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
    // No handle was returned: unblock the lease namespace, then an
    // explicit destroy clears the leftover state and the task is usable
    // again on replacement.
    rmSync(path.join(leaseDir, "leases"), { force: true });
    await provider.destroy("taskW");
    expect(containerForTask(state, "taskW")).toBeUndefined();
  });

  it("quarantine surfaces undetermined when NO durable channel survives (record write, rm, and stop all fail)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // The FENCE keeps working (`.locks` is fine); only the durable
    // quarantine RECORD channel fails: every write under the
    // `quarantines` namespace dies with EIO. That isolates the
    // quarantine catch's own ladder: in-memory flag first, then each
    // durable channel in turn.
    const provider = makeProvider(state, {
      leaseDir,
      fenceOwnerWaitMs: 500,
      fenceReapWaitMs: 300,
      fsOverride: {
        writeFile: (p, data, options) =>
          p.includes(`${path.sep}quarantines${path.sep}`)
            ? Promise.reject(errnoFailure("EIO"))
            : fsWriteFile(p, data, options),
      },
    });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("taskQ", src);
    const provisional = containerForTask(state, "taskQ")!;
    // Every daemon durable channel fails ambiguously...
    state.spawnFail.set("node", "spawn docker ENOENT");
    state.rmErrors.set(
      provisional,
      "Error: removing container: device or resource busy\n",
    );
    state.stopErrors.set(
      provisional,
      "Error: response from daemon: request timed out\n",
    );
    // ...and the validation exec itself fails at spawn. The quarantine
    // catch must still: set the in-memory flag FIRST (no I/O required),
    // attempt every durable channel — record write EIO, rm failure, stop
    // timeout/ambiguous, container confirmed still running — and report
    // UNDETERMINED to the caller (it can never claim "durable" without a
    // durably-written record).
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      /could not be determined|quarantined|validation/i,
    );
    // The in-memory flag still protects THIS process regardless of the
    // durable failure.
    expect(internals(provider).quarantinedTasks.has("taskQ")).toBe(true);
    await expect(provider.open("taskQ")).rejects.toThrow(/quarantined/);
    // No durable record could be written (the EIO channel failed).
    expect(currentQuarantine(leaseDir, "taskQ")).toBeUndefined();
    // The container was never removed/stopped (all channels failed) and
    // survives for the operator/TTL backstop.
    expect(containerForTask(state, "taskQ")).toBeDefined();
    expect(state.stopped.has(provisional)).toBe(false);
    // Once the daemon cooperates again, explicit destroy clears the
    // container (the flag is removed by a successful teardown) and the
    // task is recoverable.
    state.spawnFail.delete("node");
    state.rmErrors.delete(provisional);
    state.stopErrors.delete(provisional);
    await provider.destroy("taskQ");
    expect(containerForTask(state, "taskQ")).toBeUndefined();
  });

  it("an empty stale lock directory (crashed mid-acquire) is recovered and the reaper proceeds", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      fenceLockTtlMs: 6_000,
      fenceReapWaitMs: 2_000,
      fenceOwnerWaitMs: 2_000,
      timeoutMs: 1_000,
    });
    seedContainer(state, "valmont-sandbox-taskEmpty", {
      "valmont.task": "taskEmpty",
    });
    // A lock directory with NO token (an acquire interrupted after
    // mkdir but before its token write), aged past the TTL. The
    // twice-read staleness check (dir mtime, gap 120 ms) must see it
    // stale and the non-recursive rmdir recovers it.
    const lockDir = path.join(leaseDir, ".locks", "taskEmpty.lock");
    mkdirSync(lockDir, { recursive: true });
    await sleep(6_300); // mtime older than the 6 s fence TTL
    await internals(provider).reapExpired();
    // The stale EMPTY lock was broken (rmdir of an empty dir) and the
    // sweep proceeded to remove the abandoned container.
    expect(state.containers.has("valmont-sandbox-taskEmpty")).toBe(false);
  }, 20_000);

  it("lease generation: a teardown never unlinks a lease whose generation differs from the container it removed", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskGen", src);
    const first = currentLease(leaseDir, "taskGen");
    expect(typeof first?.generation).toBe("string");
    expect((first?.generation as string).length).toBeGreaterThan(0);
    // Direct generation-aware retirement: an UNEXPECTED generation
    // leaves the lease in place (defense in depth for the fenced
    // teardown — a replacement owner's fresh lease can never be
    // unlinked).
    const intern = internals(provider) as unknown as {
      retireTaskRecords(
        taskId: string,
        fence: unknown,
        resolved?: { epoch: number; generation: string; containerId: string },
      ): Promise<void>;
    };
    await intern.retireTaskRecords("taskGen", undefined, {
      epoch: first?.epoch as number,
      generation: "a-different-generation",
      containerId: first?.containerId as string,
    });
    expect(currentLease(leaseDir, "taskGen")).toBeDefined();
    // The teardown that DID remove this generation retires its lease.
    await intern.retireTaskRecords("taskGen", undefined, {
      epoch: first?.epoch as number,
      generation: first?.generation as string,
      containerId: first?.containerId as string,
    });
    expect(currentLease(leaseDir, "taskGen")).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // Cross-instance coordination config & unlabeled-adoption liveness rules
  // (carried over from the merged PR #32 baseline; adapted where the
  // fail-closed rewrite strengthened the behavior).
  // -------------------------------------------------------------------------

  it("an invalid instanceId (empty, whitespace, or label-breaking) is rejected at construction", () => {
    expect(
      () => new DockerWorkspaceProvider({ image: "x", instanceId: "   " }),
    ).toThrow(/instanceId must be a non-empty/);
    expect(
      () => new DockerWorkspaceProvider({ image: "x", instanceId: "a|b" }),
    ).toThrow(/instanceId must be a non-empty/);
    expect(
      () => new DockerWorkspaceProvider({ image: "x", instanceId: "a b" }),
    ).toThrow(/instanceId must be a non-empty/);
    // A clean id is accepted.
    expect(
      () => new DockerWorkspaceProvider({ image: "x", instanceId: "inst-1" }),
    ).not.toThrow();
  });

  it("fromEnv wires the cross-instance coordination settings (lease dir, instance id, TTLs)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "valmont-env-leases-"));
    leaseDirs.push(dir);
    const p = DockerWorkspaceProvider.fromEnv({
      VALMONT_SANDBOX_IMAGE: "test:latest",
      VALMONT_SANDBOX_LEASE_DIR: dir,
      VALMONT_SANDBOX_INSTANCE_ID: "stable-inst-42",
      VALMONT_SANDBOX_LEASE_TTL_MS: "123000",
      VALMONT_SANDBOX_FENCE_TTL_MS: "456000",
    } as unknown as NodeJS.ProcessEnv);
    const intern = internals(p) as unknown as {
      leaseDir: string;
      instanceId: string;
      leaseTtlMs: number;
      fenceLockTtlMs: number;
    };
    expect(intern.leaseDir).toBe(dir);
    expect(intern.instanceId).toBe("stable-inst-42");
    expect(intern.leaseTtlMs).toBe(123000);
    expect(intern.fenceLockTtlMs).toBe(456000);
    // Defaults stay correct when the vars are absent.
    const d = DockerWorkspaceProvider.fromEnv({
      VALMONT_SANDBOX_IMAGE: "x",
    } as unknown as NodeJS.ProcessEnv);
    const di = internals(d) as unknown as {
      leaseDir: string;
      instanceId: string;
    };
    expect(di.leaseDir).toContain("valmont-sandbox-leases");
    expect(di.instanceId.length).toBeGreaterThan(8);
  });

  it("a peer reaper skips a FRESH foreign adoption claim and age-reaps a STALE one (the documented unlabeled-adoption liveness rule)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 300,
    });
    seedContainer(state, "valmont-sandbox-taskX", {
      "valmont.task": "taskX",
    });
    // FRESH foreign claim: B skips it (despite the container's old age).
    writeFileSync(
      path.join(leaseDir, "taskX.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now(),
        containerName: "valmont-sandbox-taskX",
        taskId: "taskX",
        generation: "gen-A",
      }),
    );
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-taskX")).toBe(true);
    // A's claim stays untouched.
    const lease = JSON.parse(
      readFileSync(path.join(leaseDir, "taskX.lease"), "utf8"),
    );
    expect(lease.instanceId).toBe("instance-a");
    // The claim goes stale: B age-reaps the orphaned adoption.
    await sleep(400);
    await internals(b).reapExpired();
    expect(state.containers.has("valmont-sandbox-taskX")).toBe(false);
  }, 10_000);

  it("an adopted (unlabeled) container with a STALE same-instance claim is routed 'mine' and re-heartbeated — never age-reaped on a live adopter", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // No leases at all -> the adoption claims one. ttlMs is large: the
    // point of the test is the LEASE-driven routing of a live adopter,
    // not TTL abandonment (a live adopter's provider also refreshes its
    // activity on every operation; here the provider goes idle right
    // after the adoption, as it would between long-idle validations).
    const provider = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 300,
      ttlMs: 3_600_000,
    });
    // A RUNNING unlabeled container (legacy), seeded the way a real
    // daemon holds one.
    seedContainer(state, "valmont-sandbox-taskLegacy", {
      "valmont.task": "taskLegacy",
    });
    // adopt it
    const ws = await provider.open("taskLegacy");
    expect(ws.id).toBe("taskLegacy");
    // Let the claim go STALE (the adopter is still alive; the sweeps
    // that would have refreshed it were simply missed).
    await sleep(450);
    // Reap: a stale claim that NAMES THIS INSTANCE must route "mine"
    // (the adopter's own activity record drives the decision), so the
    // in-fence heartbeat refreshes the claim and the container
    // survives despite its old age — never age-reaped on a live
    // adopter.
    await internals(provider).reapExpired();
    expect(containerForTask(state, "taskLegacy")).toBeDefined();
    // The heartbeat refreshed the claim (it reads back fresh and ours).
    const lease = currentLease(leaseDir, "taskLegacy");
    expect(lease?.instanceId).toBe("instance-a");
    expect(Date.now() - (lease?.updatedAt as number)).toBeLessThan(2_000);
    // A second sweep keeps it alive (the heartbeat is per-sweep).
    await internals(provider).reapExpired();
    expect(containerForTask(state, "taskLegacy")).toBeDefined();
  }, 10_000);

  it("handle ops on an unlabeled container FAIL CLOSED when the durable adoption claim is absent (never mint a claim implicitly)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    seedContainer(state, "valmont-sandbox-taskClaim", {
      "valmont.task": "taskClaim",
    });
    // A FORGED handle (never issued by open): no lease exists. The
    // gate must fail closed rather than let the op proceed.
    const handle = { id: "taskClaim", root: "/workspace" };
    await expect(provider.readFile(handle, "a.txt")).rejects.toThrow(
      /could not be determined/,
    );
    await expect(provider.writeFile(handle, "a.txt", "x")).rejects.toThrow(
      /could not be determined/,
    );
    await expect(provider.runValidation(handle, "npm test")).rejects.toThrow(
      /could not be determined/,
    );
    // ...whereas open() ADOPTS and then file ops succeed (the claim is
    // established only by open/create).
    const ws = await provider.open("taskClaim");
    // There is no a.txt in the seeded container; the gate must now
    // PASS (failing later at cat, not at the ownership gate).
    await expect(provider.readFile(ws, "a.txt")).rejects.toThrow(
      /Could not read workspace file/,
    );
  });

  it("re-adoption after the original adopter is gone mints a fresh generation (never reuses a foreign generation)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // A distinct id from the dead adopter: the stale claim names
    // instance-a; B adopts and must stamp its OWN generation.
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 300,
    });
    seedContainer(state, "valmont-sandbox-taskGen", {
      "valmont.task": "taskGen",
    });
    writeFileSync(
      path.join(leaseDir, "taskGen.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now() - 60_000,
        containerName: "valmont-sandbox-taskGen",
        taskId: "taskGen",
        generation: "gen-FROM-A",
      }),
    );
    await b.open("taskGen");
    const lease = currentLease(leaseDir, "taskGen");
    expect(lease?.instanceId).toBe("instance-b");
    expect(lease?.generation).not.toBe("gen-FROM-A");
    expect(lease?.generation).toBeTruthy();

    // Same-identity RESTART resumes with the SAME generation.
    const restarted = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      leaseTtlMs: 300,
    });
    await restarted.open("taskGen");
    const lease2 = currentLease(leaseDir, "taskGen");
    expect(lease2?.instanceId).toBe("instance-b");
    expect(lease2?.generation).toBe(lease?.generation);
  });

  // ---------------------------------------------------------------------------
  // Token-fence race windows (review items 1, 2, 5, 6, 7, 8, 9): every test
  // below drives the provider THROUGH the race (delayed fs ops, mid-flight
  // token deletion, replacement holders) rather than around it.
  // ---------------------------------------------------------------------------

  it("losing the fence token mid-operation aborts the op before its next docker call — and the release never touches the replacement holder", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 8_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await a.create("taskAbort", src);
    state.statResults.set("/workspace", {
      code: 0,
      stdout: "directory\n",
      stderr: "",
    });
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
    state.execDelays.set("stat", 900);
    const lockDir = path.join(leaseDir, ".locks", "taskAbort.lock");
    let statStarted = false;
    state.onExec = (_n, cmd) => {
      if (cmd[0] === "stat" && cmd[cmd.length - 1] === "/workspace/a.txt") {
        statStarted = true;
      }
      return undefined;
    };
    const read = a.readFile(ws, "a.txt");
    // The (delayed) verification stat is in flight. While it runs, a
    // stale-breaker completes a break of A's fence and a replacement
    // holder installs its own token.
    await waitFor(() => statStarted);
    const callsAtLoss = state.calls.length;
    expect(tokenPathOf(lockDir)).not.toBeNull();
    const replacement = breakFenceAndReplace(lockDir);
    // The operation must fail CLOSED: the `cat` that would have
    // followed the stat never runs (zero docker calls after the loss).
    await expect(read).rejects.toThrow(/could not be determined/);
    expect(state.calls.length).toBe(callsAtLoss);
    // The abort left the container alone.
    expect(containerForTask(state, "taskAbort")).toBeDefined();
    // The failed operation's own release (finally block) could not
    // touch the replacement holder's token or lock directory.
    expect(existsSync(replacement)).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
    // Every later owner op on this provider also fails closed while
    // the replacement holds the fence (no touch, no takeover).
    await expect(a.readFile(ws, "a.txt")).rejects.toThrow(
      /could not be determined/,
    );
    expect(existsSync(replacement)).toBe(true);
  }, 15_000);

  it("a renewal DELAYED past a completed break fails with ENOENT: the fence is lost and the operation fails closed", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    // The heartbeat's utimes is slowed (event-loop pause / slow fs):
    // while it is in flight a breaker deletes the token. The renewal
    // must then fail (ENOENT on the removed path) and mark the fence
    // lost — never silently "succeed" against a replacement's state.
    const renewalStarts: number[] = [];
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 6_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 1_000,
      fsOverride: {
        utimes: async (p, atime, mtime) => {
          renewalStarts.push(Date.now());
          await sleep(700);
          await fsUtimes(p, atime, mtime);
        },
      },
    });
    const src = await makeSource({ "a/b.txt": "x" });
    const ws = await a.create("taskDU", src);
    const deep = "/workspace/a/b.txt";
    for (const dir of ["/workspace", "/workspace/a"]) {
      state.statResults.set(dir, {
        code: 0,
        stdout: "directory\n",
        stderr: "",
      });
    }
    state.statResults.set(deep, {
      code: 0,
      stdout: "regular file\n",
      stderr: "",
    });
    state.fileContents.set(deep, { code: 0, stdout: "x\n", stderr: "" });
    state.execDelays.set("stat", 900);
    state.execDelays.set("cat", 900);
    const lockDir = path.join(leaseDir, ".locks", "taskDU.lock");
    const read = a.readFile(ws, "a/b.txt");
    // Wait until the first heartbeat renewal is IN FLIGHT (it started
    // but has not landed yet), then complete a break under it.
    await waitFor(() => renewalStarts.length > 0);
    const token = tokenPathOf(lockDir)!;
    rmSync(token, { force: true });
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "replacement-token"), "peer\n");
    // The delayed renewal lands on the deleted path => ENOENT => the
    // fence is marked lost => the pending `cat` aborts the operation.
    await expect(read).rejects.toThrow(/could not be determined/);
    // The cat exec never ran (only the two stats did).
    expect(
      state.calls.filter(
        (c) =>
          c.command === "docker" &&
          c.args[0] === "exec" &&
          c.args.includes("cat"),
      ),
    ).toHaveLength(0);
    expect(containerForTask(state, "taskDU")).toBeDefined();
    expect(existsSync(path.join(lockDir, "replacement-token"))).toBe(true);
  }, 15_000);

  it("a stale-break CANNOT capture a token renewed before the capture: it restores the token and declines", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      fenceLockTtlMs: 6_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 1_000,
    });
    // B's breaker sees a token whose mtime is stale at the cheap
    // pre-check, but the holder renews BETWEEN that check and the
    // capture rename (the rename is delayed here; the renewal lands on
    // the token first). The capture-verify step must observe the FRESH
    // mtime, restore the token, and decline the break.
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      fenceLockTtlMs: 6_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 1_000,
      fsOverride: {
        rename: async (oldPath, newPath) => {
          if (newPath.includes(".deadtoken.")) {
            // The live holder renews while the breaker holds the
            // pre-capture window; the captured file carries the fresh
            // mtime once the rename lands.
            const now = new Date();
            await fsUtimes(oldPath, now, now);
          }
          return fsRename(oldPath, newPath);
        },
      },
    });
    const fenceA = (await internals(a).acquireTaskFence(
      "taskVR",
      "owner",
    )) as FenceHandle | null;
    expect(fenceA?.active).toBe(true);
    const lockDir = path.join(leaseDir, ".locks", "taskVR.lock");
    const token = tokenPathOf(lockDir)!;
    // Make the token look stale to the pre-check...
    const old = new Date(Date.now() - 60_000);
    await fsUtimes(token, old, old);
    // ...then have B try to break it.
    const attempt = await internals(b).acquireTaskFence("taskVR", "owner");
    expect(attempt?.active).toBe(false);
    // A's token was RESTORED (not captured, not deleted) and the fence
    // is still usable: the next renewal succeeds and stays fresh.
    expect(existsSync(token)).toBe(true);
    expect(Date.now() - lstatSync(token).mtimeMs).toBeLessThan(5_000);
    await (
      internals(a) as unknown as {
        renewFence(f: unknown): Promise<void>;
      }
    ).renewFence(fenceA);
    expect(fenceA?.lost).toBeFalsy();
    expect(Date.now() - lstatSync(token).mtimeMs).toBeLessThan(2_000);
    // No graveyard leftovers from the aborted capture.
    expect(
      readdirSync(path.join(leaseDir, ".locks")).filter((e) =>
        e.includes(".deadtoken."),
      ),
    ).toHaveLength(0);
    await fenceA!.release();
    expect(existsSync(lockDir)).toBe(false);
  }, 15_000);

  it("a broken stale holder loses its fence: its own release leaves the replacement holder's lock untouched", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const a = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      fenceLockTtlMs: 6_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 1_000,
    });
    const b = makeProvider(state, {
      instanceId: "instance-b",
      leaseDir,
      fenceLockTtlMs: 6_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 1_000,
    });
    const fenceA = (await internals(a).acquireTaskFence(
      "taskSB",
      "owner",
    )) as FenceHandle | null;
    expect(fenceA?.active).toBe(true);
    const lockDir = path.join(leaseDir, ".locks", "taskSB.lock");
    // A's token is genuinely stale (the holder died): B breaks it and
    // takes over with its OWN token.
    const token = tokenPathOf(lockDir)!;
    const old = new Date(Date.now() - 60_000);
    await fsUtimes(token, old, old);
    const attempt = await internals(b).acquireTaskFence("taskSB", "owner");
    expect(attempt?.active).toBe(true);
    // A's next renewal fails on its removed token path: the fence is
    // lost (sticky) for the rest of A's operation.
    expect(existsSync(fenceA?.tokenFile ?? token)).toBe(false);
    await (
      internals(a) as unknown as {
        renewFence(f: unknown): Promise<void>;
      }
    ).renewFence(fenceA);
    expect(fenceA?.lost).toBe(true);
    // A's release (e.g. the finally of an operation that already
    // failed) removes NOTHING of B's: the replacement token and the
    // lock directory survive it.
    await fenceA!.release();
    const bToken = tokenPathOf(lockDir)!;
    expect(existsSync(bToken)).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
    // B still holds a fully working fence and releases cleanly.
    const now = new Date();
    await fsUtimes(bToken, now, now);
    await attempt!.release();
    expect(existsSync(lockDir)).toBe(false);
  }, 15_000);

  it("coordination-directory failures (EIO/ENOENT/ESTALE/EACCES) fail the owner op CLOSED with zero docker calls", async () => {
    // These are LOCAL/transient failures: this instance cannot know
    // whether peers can still fence, so proceeding would risk two
    // holders. None of them may be read as "degraded, proceed".
    for (const code of ["EIO", "ENOENT", "ESTALE", "EACCES"]) {
      const state = makeState();
      const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
      leaseDirs.push(leaseDir);
      const src = await makeSource({ "a.txt": "x" });
      const provider = makeProvider(state, {
        leaseDir,
        fenceOwnerWaitMs: 250,
        fenceReapWaitMs: 250,
        fsOverride: failingLocksMkdir(code),
      });
      await expect(
        provider.create("taskDeg", src),
        `code ${code} must fail closed`,
      ).rejects.toThrow(/could not be determined/);
      expect(
        state.calls.filter((c) => c.command === "docker"),
        `code ${code} must not run docker`,
      ).toHaveLength(0);
    }
  }, 15_000);

  it("with the fence unusable, two instances NEVER concurrently adopt the same unlabeled container", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    seedContainer(state, "valmont-sandbox-taskNA", {
      "valmont.task": "taskNA",
    });
    const mk = (instanceId: string) =>
      makeProvider(state, {
        instanceId,
        leaseDir,
        leaseTtlMs: 600_000,
        fenceOwnerWaitMs: 200,
        fenceReapWaitMs: 200,
        fsOverride: failingLocksMkdir("EIO"),
      });
    const a = mk("instance-a");
    const b = mk("instance-b");
    // Both instances race to adopt the legacy (unlabeled) container.
    const [ra, rb] = await Promise.allSettled([
      a.open("taskNA"),
      b.open("taskNA"),
    ]);
    expect(ra.status).toBe("rejected");
    expect(rb.status).toBe("rejected");
    expect(String((ra as PromiseRejectedResult).reason)).toMatch(
      /could not be determined/,
    );
    expect(String((rb as PromiseRejectedResult).reason)).toMatch(
      /could not be determined/,
    );
    // Neither attempt wrote a lease claim, neither ran ANY docker
    // command, and the container is exactly as it was.
    expect(existsSync(path.join(leaseDir, "taskNA.lease"))).toBe(false);
    expect(state.calls.filter((c) => c.command === "docker")).toHaveLength(0);
    expect(state.containers.has("valmont-sandbox-taskNA")).toBe(true);
  }, 15_000);

  it("a stale own lease on a REPLACEMENT container is never refreshed: the rejected op cannot poison the new owner", async () => {
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
    // B's REPLACEMENT container under the task name (A's original was
    // destroyed and B re-created): the immutable instance label names
    // B — but A's OLD lease for the destroyed original is still on
    // disk, stale.
    seedContainer(state, "valmont-sandbox-taskPO", {
      "valmont.task": "taskPO",
      "valmont.instance": "instance-b",
    });
    const leasePath = path.join(leaseDir, "taskPO.lease");
    const staleLease = JSON.stringify({
      instanceId: "instance-a",
      updatedAt: Date.now() - 30 * 60_000,
      containerName: "valmont-sandbox-taskPO",
      taskId: "taskPO",
      generation: "old-generation",
    });
    writeFileSync(leasePath, staleLease);
    const mtimeBefore = lstatSyncSafe(leasePath);
    await sleep(20);
    // A's open and handle op both reject (the container is foreign)...
    await expect(a.open("taskPO")).rejects.toThrow(/owned by another/);
    await expect(
      a.readFile({ id: "taskPO", root: "/workspace" }, "a.txt"),
    ).rejects.toThrow(/owned by another|could not be determined/);
    // ...CRITICALLY without refreshing the stale lease: the old
    // pre-gate heartbeat would have re-stamped it fresh, blocking B's
    // create/destroy with a bogus "owned by another" claim.
    expect(readFileSync(leasePath, "utf8")).toBe(staleLease);
    expect(lstatSyncSafe(leasePath)).toBe(mtimeBefore);
    // B — the replacement's real owner — is unaffected: its open
    // succeeds and re-mints the claim for B.
    const handle = await b.open("taskPO");
    expect(handle.id).toBe("taskPO");
    const lease = currentLease(leaseDir, "taskPO");
    expect(lease?.instanceId).toBe("instance-b");
    expect(lease?.generation).not.toBe("old-generation");
  });

  it("losing the lease file mid-operation does not disturb the fenced op; the next op re-establishes the claim", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "instance-ll",
      leaseDir,
      leaseTtlMs: 600_000,
      fenceLockTtlMs: 8_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("taskLL", src);
    state.statResults.set("/workspace", {
      code: 0,
      stdout: "directory\n",
      stderr: "",
    });
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
    state.execDelays.set("stat", 800);
    const leasesDir = path.join(leaseDir, "leases", "taskLL");
    let statStarted = false;
    state.onExec = (_n, cmd) => {
      if (cmd[0] === "stat" && cmd[cmd.length - 1] === "/workspace/a.txt") {
        statStarted = true;
      }
      return undefined;
    };
    const read = provider.readFile(ws, "a.txt");
    await waitFor(() => statStarted);
    // The claim records vanish mid-op (operator cleanup / disk fault):
    // the fence still proves exclusivity for the in-flight operation,
    // which completes normally.
    rmSync(leasesDir, { recursive: true, force: true });
    expect(await read).toBe("x\n");
    expect(containerForTask(state, "taskLL")).toBeDefined();
    // The NEXT operation re-establishes the claim under the fence, so
    // peer reapers still see a live owner rather than an adoptable
    // orphan.
    expect(await provider.readFile(ws, "a.txt")).toBe("x\n");
    const lease = currentLease(leaseDir, "taskLL");
    expect(lease?.instanceId).toBe("instance-ll");
    expect(typeof lease?.generation).toBe("string");
    expect((lease?.generation as string).length).toBeGreaterThan(0);
  }, 15_000);

  it("a reaper that loses its fence token mid-sweep NEVER issues the rm (the replacement holder's lock is untouched)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      ttlMs: 400,
      fenceReapWaitMs: 2_000,
    });
    seedContainer(state, "valmont-sandbox-taskTL", {
      "valmont.task": "taskTL",
      "valmont.instance": "instance-b",
    });
    // A stale foreign lease => the reaper routes the row by AGE (it
    // would remove the container if it got the fence).
    writeFileSync(
      path.join(leaseDir, "taskTL.lease"),
      JSON.stringify({
        instanceId: "instance-b",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-taskTL",
        taskId: "taskTL",
      }),
    );
    const lockDir = path.join(leaseDir, ".locks", "taskTL.lock");
    // The reaper is INSIDE its fence (the in-fence identity re-check
    // inspect) when a stale-breaker completes a break and a
    // replacement holder takes over the lock directory.
    let broke = false;
    state.onInspect = (name, format) => {
      if (
        !broke &&
        name === "valmont-sandbox-taskTL" &&
        format.startsWith("{{.Id}}|")
      ) {
        broke = true;
        breakFenceAndReplace(lockDir);
      }
    };
    state.psLines = [
      "valmont-sandbox-taskTL\ttaskTL\tinstance-b\t<no value>\t<no value>\t/valmont-sandbox-taskTL",
    ];
    // The sweep must fail closed (undetermined) instead of issuing the
    // rm it can no longer prove it is entitled to.
    await expect(internals(provider).reapExpired()).rejects.toThrow(
      /could not be determined/,
    );
    expect(broke).toBe(true);
    expect(
      state.calls.filter((c) => c.command === "docker" && c.args[0] === "rm"),
    ).toHaveLength(0);
    expect(state.containers.has("valmont-sandbox-taskTL")).toBe(true);
    // The replacement holder's token survived the failed sweep's
    // cleanup/release path.
    expect(existsSync(path.join(lockDir, "replacement-token"))).toBe(true);
  }, 15_000);

  it("a replacement created between the ps row and the in-fence re-check is skipped; its fresh lease is restored, never unlinked", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      ttlMs: 400,
      fenceReapWaitMs: 2_000,
    });
    seedContainer(state, "valmont-sandbox-taskRP", {
      "valmont.task": "taskRP",
      "valmont.instance": "instance-a",
    });
    const oldId = state.idOf.get("valmont-sandbox-taskRP")!;
    // Stale lease => the reaper routes by age.
    writeFileSync(
      path.join(leaseDir, "taskRP.lease"),
      JSON.stringify({
        instanceId: "instance-a",
        updatedAt: Date.now() - 30 * 60_000,
        containerName: "valmont-sandbox-taskRP",
        taskId: "taskRP",
      }),
    );
    const leasePath = path.join(leaseDir, "taskRP.lease");
    // Between the ps listing and the reaper's in-fence re-check, the
    // old container dies and a REPLACEMENT (a different immutable id,
    // owned by instance-a) takes the name with a FRESH lease.
    let swapped = false;
    state.onInspect = (name, format) => {
      if (
        !swapped &&
        format.startsWith("{{.Id}}|") &&
        (name === oldId || name === "valmont-sandbox-taskRP")
      ) {
        swapped = true;
        unregisterContainer(state, "valmont-sandbox-taskRP");
        registerContainer(state, "valmont-sandbox-taskRP", {
          "valmont.task": "taskRP",
          "valmont.instance": "instance-a",
        });
        state.createdAt.set("valmont-sandbox-taskRP", new Date().toISOString());
        writeFileSync(
          leasePath,
          JSON.stringify({
            instanceId: "instance-a",
            updatedAt: Date.now(),
            containerName: "valmont-sandbox-taskRP",
            taskId: "taskRP",
            generation: "replacement-generation",
          }),
        );
      }
    };
    state.psLines = [`${oldId}\ttaskRP\tinstance-a\t/valmont-sandbox-taskRP`];
    await internals(provider).reapExpired();
    expect(swapped).toBe(true);
    // The rm targeted the row's immutable ID; by re-check time that id
    // resolves to nothing, so NO rm was ever issued...
    expect(
      state.calls.filter((c) => c.command === "docker" && c.args[0] === "rm"),
    ).toHaveLength(0);
    // ...the replacement container is intact...
    expect(state.containers.has("valmont-sandbox-taskRP")).toBe(true);
    expect(state.idOf.get("valmont-sandbox-taskRP")).not.toBe(oldId);
    // ...and its fresh lease SURVIVED the sweep's generation-aware
    // deletion: still the replacement owner's claim (never unlinked,
    // never left absent — capture-verify-restore refused it).
    const afterLease = JSON.parse(readFileSync(leasePath, "utf8"));
    expect(afterLease.instanceId).toBe("instance-a");
    expect(afterLease.generation).toBe("replacement-generation");
    expect(Date.now() - afterLease.updatedAt).toBeLessThan(60_000);
  }, 15_000);

  it("a restarted provider with the SAME stable instance id honors its predecessor's fresh lease (removes only once it is stale)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const first = makeProvider(state, {
      instanceId: "stable-id",
      leaseDir,
      leaseTtlMs: 600_000,
      ttlMs: 400,
    });
    const src = await makeSource({ "a.txt": "x" });
    await first.create("taskST", src);
    const provisional = containerForTask(state, "taskST")!;
    // The first "process" is gone; its container is old by age, but its
    // lease claim is FRESH (a recent idle heartbeat). A restarted
    // process with the same stable identity must NOT remove it.
    state.createdAt.set(provisional, OLD_CREATED);
    const restarted = makeProvider(state, {
      instanceId: "stable-id",
      leaseDir,
      leaseTtlMs: 600_000,
      ttlMs: 400,
      fenceReapWaitMs: 2_000,
    });
    await internals(restarted).reapExpired();
    expect(containerForTask(state, "taskST")).toBeDefined();
    // Control: once the lease is truly stale, the same sweep removes
    // the container — proving the skip above was lease-driven, not a
    // disabled reaper.
    makeLeaseStale(leaseDir, "taskST");
    await internals(restarted).reapExpired();
    expect(containerForTask(state, "taskST")).toBeUndefined();
  }, 15_000);

  it("record retirement restores a lease a replacement owner swapped in between the teardown's read and the capture", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
    });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskGR", src);
    const original = currentLease(leaseDir, "taskGR")!;
    // A replacement owner's writeLease (tmp + link) completes in the
    // window between this teardown's lease READ (generation g1) and its
    // capture rename: the capture grabs the REPLACEMENT's record, the
    // verification fails, and the captured record is RESTORED — the
    // replacement's claim is never unlinked.
    const replacementLease = JSON.stringify({
      schemaVersion: 1,
      taskId: "taskGR",
      epoch: (original.epoch as number) + 1,
      generation: "g2-replacement",
      instanceId: "instance-b",
      provisionalName: original.provisionalName,
      containerId: original.containerId,
      updatedAt: Date.now(),
    });
    const rigged = makeProvider(state, {
      instanceId: "instance-a",
      leaseDir,
      fsOverride: {
        rename: async (oldPath, newPath) => {
          if (
            newPath.includes(".captured.") &&
            oldPath.includes(`${path.sep}leases${path.sep}`)
          ) {
            // The concurrent replacement write lands first...
            await fsWriteFile(oldPath, replacementLease);
          }
          return fsRename(oldPath, newPath);
        },
      },
    });
    const intern = rigged as unknown as {
      retireTaskRecords(
        taskId: string,
        fence: unknown,
        resolved?: { epoch: number; generation: string; containerId: string },
      ): Promise<void>;
    };
    await intern.retireTaskRecords("taskGR", undefined, {
      epoch: original.epoch as number,
      generation: original.generation as string,
      containerId: original.containerId as string,
    });
    // The lease on disk is the REPLACEMENT's claim (the capture-verify
    // refused to retire it and restored it from the graveyard).
    const after = readRecords(leaseDir, "leases", "taskGR");
    expect(after).toHaveLength(1);
    expect(after[0]!.instanceId).toBe("instance-b");
    expect(after[0]!.generation).toBe("g2-replacement");
  });

  it("a destroy that loses its fence mid-teardown reports undetermined, keeps the lease, and a retry completes", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      fenceLockTtlMs: 8_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskFD", src);
    const provisional = containerForTask(state, "taskFD")!;
    const leaseBefore = readRecords(leaseDir, "leases", "taskFD");
    const lockDir = path.join(leaseDir, ".locks", "taskFD.lock");
    // The rm is slow; while it is in flight a stale-breaker completes a
    // break and a replacement holder takes the lock.
    state.dockerDelays.set("rm", 800);
    let broke = false;
    state.onRm = (name) => {
      if (name === provisional && !broke) {
        broke = true;
        breakFenceAndReplace(lockDir);
      }
    };
    await expect(provider.destroy("taskFD")).rejects.toThrow(
      /could not be determined/,
    );
    // The rm itself was issued under a fence that was live at issue
    // time, so the container is gone — but the teardown REFUSED to
    // retire state it could no longer prove it owned: the records
    // survive untouched for the replacement/retry to resolve...
    expect(broke).toBe(true);
    expect(containerForTask(state, "taskFD")).toBeUndefined();
    expect(readRecords(leaseDir, "leases", "taskFD")).toEqual(leaseBefore);
    // ...and the replacement holder's token was not swept by the
    // failed teardown's release.
    expect(existsSync(path.join(lockDir, "replacement-token"))).toBe(true);
    // The replacement holder finishes and releases; a retry completes
    // the teardown cleanly.
    state.dockerDelays.clear();
    state.onRm = undefined;
    rmSync(lockDir, { recursive: true, force: true });
    await provider.destroy("taskFD");
    expect(readRecords(leaseDir, "leases", "taskFD")).toHaveLength(0);
  }, 15_000);

  it("quarantine stops at fence loss: no rename, no stop, and the undetermined outcome is surfaced", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      leaseDir,
      fenceLockTtlMs: 8_000,
      fenceOwnerWaitMs: 400,
      fenceReapWaitMs: 400,
      timeoutMs: 2_000,
    });
    const src = await makeSource({ "a.txt": "x" });
    const ws = await provider.create("taskQF", src);
    const provisional = containerForTask(state, "taskQF")!;
    const lockDir = path.join(leaseDir, ".locks", "taskQF.lock");
    // The validation cleanup fails (a survivor escapes the reaper) and
    // the quarantine's own rm fails while the container survives —
    // and MID-SEQUENCE the fence is broken away with a replacement
    // holder taking over. The sequence must STOP: no rename by name,
    // no stop, no record retirement.
    state.onExec = (_n, cmd) =>
      cmd[0] === "node"
        ? {
            code: 1,
            stdout: "",
            stderr: "validation-reap: survivor pid 42 (state R)\n",
          }
        : undefined;
    state.rmErrors.set(
      provisional,
      "Error: removing container: device or resource busy\n",
    );
    state.dockerDelays.set("rm", 600);
    let broke = false;
    state.onRm = (name) => {
      if (name === provisional && !broke) {
        broke = true;
        breakFenceAndReplace(lockDir);
      }
    };
    await expect(provider.runValidation(ws, "npm test")).rejects.toThrow(
      /could not be determined|quarantined|validation/i,
    );
    // The in-memory flag was set FIRST (no I/O needed)...
    expect(internals(provider).quarantinedTasks.has("taskQF")).toBe(true);
    // ...the durable quarantine record was written BEFORE the loss and
    // is kept...
    expect(currentQuarantine(leaseDir, "taskQF")).toBeDefined();
    // ...and NO rename or stop was ever issued (the sequence stopped
    // at the fence gate instead of touching a container a replacement
    // may hold).
    expect(
      state.calls.filter(
        (c) =>
          c.command === "docker" &&
          (c.args[0] === "rename" || c.args[0] === "stop"),
      ),
    ).toHaveLength(0);
    expect(containerForTask(state, "taskQF")).toBeDefined();
    expect(state.stopped.has(provisional)).toBe(false);
    // The replacement holder finishes; an explicit destroy recovers
    // the task (container, record, and flag all cleared).
    state.onExec = undefined;
    state.rmErrors.delete(provisional);
    state.dockerDelays.clear();
    state.onRm = undefined;
    rmSync(lockDir, { recursive: true, force: true });
    await provider.destroy("taskQF");
    expect(containerForTask(state, "taskQF")).toBeUndefined();
    expect(currentQuarantine(leaseDir, "taskQF")).toBeUndefined();
    expect(internals(provider).quarantinedTasks.has("taskQF")).toBe(false);
  }, 15_000);

  it("a LATE-registered create stays an unreachable orphan: the surfaced container is unopenable until reaped", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    // The create request times out client-side; the daemon is still
    // processing it and the container is NOT yet visible. The late
    // create is armed on the generation-scoped provisional name (only
    // known at create time).
    let provisionalName: string | undefined;
    state.onCreate = (name) => {
      provisionalName = name;
      state.lateCreates.set(name, { labels: {}, pending: false });
    };
    await expect(provider.create("taskLC", src)).rejects.toThrow(/create/);
    // The create outcome was UNCERTAIN: the in-memory quarantine flag
    // is set, but NO mapping is published — a late-surfacing container
    // is an unreachable orphan by construction.
    expect(internals(provider).quarantinedTasks.has("taskLC")).toBe(true);
    expect(readAuthoritativeMapping(leaseDir, "taskLC")).toBeUndefined();
    // The daemon finishes the create LATE: the container appears AFTER
    // the cleanup probes concluded "missing", under its generation-
    // scoped provisional name (never the canonical name).
    expect(flushLateCreate(state, provisionalName!)).toBe(true);
    expect(containerForTask(state, "taskLC")).toBeDefined();
    // ...and it is NOT openable: this instance's in-memory quarantine
    // blocks it...
    await expect(provider.open("taskLC")).rejects.toThrow(/quarantined/);
    // ...and a fresh instance finds no mapping for it (an unreachable
    // orphan), so it fails closed as unavailable.
    const fresh = makeProvider(state, { leaseDir });
    await expect(fresh.open("taskLC")).rejects.toThrow(/unavailable/);
    // The orphan is removed by age by the reaper, never by any mapping.
    await internals(fresh).reapExpired();
    expect(containerForTask(state, "taskLC")).toBeUndefined();
    // ...and the task is usable again.
    state.onCreate = undefined;
    const ws = await provider.create("taskLC", src);
    expect(ws.id).toBe("taskLC");
  }, 15_000);

  it("never creates a container under the canonical name: every create name carries a fresh generation", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("task1", src);
    await provider.destroy("task1");
    await provider.create("task1", src);
    const names = state.calls
      .filter((c) => c.command === "docker" && c.args[0] === "create")
      .map((c) => c.args[c.args.indexOf("--name") + 1]);
    expect(names.length).toBe(2);
    for (const name of names) {
      // Generation-scoped, never the canonical name.
      expect(name).toMatch(/^valmont-sandbox-task1--g-[0-9a-f-]{36}$/);
      expect(name).not.toBe("valmont-sandbox-task1");
    }
    // The replacement used a FRESH generation (a name is never reused).
    expect(names[0]).not.toBe(names[1]);
  });

  it("fencing epochs are durable and monotonically increasing across acquisitions", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    // Prior acquisitions left durable epoch claims 1..2 on disk.
    writeEpochs(leaseDir, "taskE", 2);
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskE", src);
    // The create's fence took epoch 3 (max + 1) — never reused.
    expect(readEpochs(leaseDir, "taskE")).toEqual([1, 2, 3]);
    expect(readAuthoritativeMapping(leaseDir, "taskE")?.epoch).toBe(3);
    // Each subsequent acquisition keeps advancing monotonically (destroy
    // then replace each allocate their own epoch).
    await provider.destroy("taskE");
    await provider.create("taskE", src);
    expect(readEpochs(leaseDir, "taskE")).toEqual([1, 2, 3, 4, 5]);
    expect(readAuthoritativeMapping(leaseDir, "taskE")?.epoch).toBe(5);
  });

  it("a stale lower-epoch mapping is ignored when a higher-epoch mapping exists", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "inst-a",
      leaseDir,
    });
    // A live lower-epoch generation...
    const g1 = seedGeneration(state, "task1", {
      epoch: 1,
      generation: "g1",
      instanceId: "inst-a",
    });
    writeCoordRecord(leaseDir, "mappings", "task1", {
      taskId: "task1",
      epoch: 1,
      generation: g1.generation,
      instanceId: "inst-a",
      provisionalName: g1.name,
      containerId: g1.id,
      publishedAt: Date.now(),
    });
    // ...and a HIGHER-epoch mapping naming a successor container that is
    // GONE. The higher epoch is authoritative: open must report the
    // successor as unavailable, never fall back to the live lower-epoch
    // generation.
    writeCoordRecord(leaseDir, "mappings", "task1", {
      taskId: "task1",
      epoch: 2,
      generation: "g2",
      instanceId: "inst-a",
      provisionalName: "valmont-sandbox-task1--g-g2",
      containerId: "fakeid-gone",
      publishedAt: Date.now(),
    });
    await expect(provider.open("task1")).rejects.toThrow(
      "Task workspace is unavailable",
    );
  });

  it("duplicate highest-epoch mappings fail closed (unknown)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "inst-a",
      leaseDir,
    });
    // Two records at the SAME highest epoch but different generations.
    writeCoordRecord(leaseDir, "mappings", "task2", {
      taskId: "task2",
      epoch: 1,
      generation: "g1",
      instanceId: "inst-a",
      provisionalName: "valmont-sandbox-task2--g-g1",
      containerId: "fakeid-a",
      publishedAt: Date.now(),
    });
    writeCoordRecord(leaseDir, "mappings", "task2", {
      taskId: "task2",
      epoch: 1,
      generation: "g2",
      instanceId: "inst-a",
      provisionalName: "valmont-sandbox-task2--g-g2",
      containerId: "fakeid-b",
      publishedAt: Date.now(),
    });
    // No unique highest-epoch mapping: open fails closed.
    await expect(provider.open("task2")).rejects.toThrow(
      /could not be determined/,
    );
  });

  it("malformed mapping records fail closed", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const dir = path.join(leaseDir, "mappings", "task3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "torn.json"),
      '{"schemaVersion": 1, "taskId": "task3", "epoch": ',
    );
    await expect(provider.open("task3")).rejects.toThrow(
      /could not be determined/,
    );
  });

  it("an unknown recovery artifact (a publication temp) fails closed", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const dir = path.join(leaseDir, "mappings", "task4");
    mkdirSync(dir, { recursive: true });
    // A crashed PUBLICATION temp (never linked to a `.json`): an unknown
    // recovery artifact the reader must never silently skip.
    writeFileSync(path.join(dir, "deadbeef.json.tmp"), "{}");
    await expect(provider.open("task4")).rejects.toThrow(
      /could not be determined/,
    );
  });

  it("a fence lost before publication refuses the lease record (create fails closed)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    let broke = false;
    const provider = makeProvider(state, {
      leaseDir,
      fsOverride: {
        writeFile: async (p, data, options) => {
          if (
            !broke &&
            p.includes(`${path.sep}leases${path.sep}`) &&
            p.endsWith(".json.tmp")
          ) {
            // The fence is broken away the moment the lease publication
            // temp lands: the publication must be refused (never linked).
            broke = true;
            const lockDir = path.join(leaseDir, ".locks", "taskPub.lock");
            for (const entry of readdirSync(lockDir)) {
              rmSync(path.join(lockDir, entry), { force: true });
            }
            rmSync(lockDir, { recursive: true, force: true });
          }
          return fsWriteFile(p, data, options);
        },
      },
    });
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("taskPub", src)).rejects.toThrow(
      /could not be determined/,
    );
    expect(broke).toBe(true);
    // No lease record was ever published.
    expect(readRecords(leaseDir, "leases", "taskPub")).toHaveLength(0);
  });

  it("a failed capture RESTORE retains the captured record (recoverable, never lost)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "inst-a",
      leaseDir,
    });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskR", src);
    const g1 = currentLease(leaseDir, "taskR")!;
    // A replacement owner's record lands between the teardown's read and
    // its capture (so the capture no longer qualifies), AND the restore
    // link-back fails with EIO: the capture must be RETAINED as a
    // first-class recovery record, never silently dropped.
    const replacement = JSON.stringify({
      schemaVersion: 1,
      taskId: "taskR",
      epoch: (g1.epoch as number) + 1,
      generation: "g2",
      instanceId: "inst-b",
      provisionalName: g1.provisionalName,
      containerId: g1.containerId,
      updatedAt: Date.now(),
    });
    const rigged = makeProvider(state, {
      instanceId: "inst-a",
      leaseDir,
      fsOverride: {
        rename: async (oldPath, newPath) => {
          if (
            newPath.includes(".captured.") &&
            oldPath.includes(`${path.sep}leases${path.sep}`)
          ) {
            await fsWriteFile(oldPath, replacement);
          }
          return fsRename(oldPath, newPath);
        },
        link: async (existingPath, newPath) => {
          if (
            newPath.endsWith(".json") &&
            existingPath.includes(".captured.")
          ) {
            throw errnoFailure("EIO");
          }
          return fsLink(existingPath, newPath);
        },
      },
    });
    const intern = rigged as unknown as {
      retireTaskRecords(
        taskId: string,
        fence: unknown,
        resolved?: { epoch: number; generation: string; containerId: string },
      ): Promise<void>;
    };
    await intern.retireTaskRecords("taskR", undefined, {
      epoch: g1.epoch as number,
      generation: g1.generation as string,
      containerId: g1.containerId as string,
    });
    // The captured record survives as a retained recovery artifact.
    const entries = recordEntries(leaseDir, "leases", "taskR");
    expect(entries.some((e) => e.includes(".captured."))).toBe(true);
  });

  it("stale retirement never touches a newer generation's records", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, {
      instanceId: "inst-a",
      leaseDir,
    });
    const src = await makeSource({ "a.txt": "x" });
    await provider.create("taskN", src);
    const g1 = currentLease(leaseDir, "taskN")!;
    // A peer published a NEWER generation (epoch 2) for a replacement.
    writeCoordRecord(leaseDir, "mappings", "taskN", {
      taskId: "taskN",
      epoch: 2,
      generation: "g2",
      instanceId: "inst-b",
      provisionalName: "valmont-sandbox-taskN--g-g2",
      containerId: "fakeid-g2",
      publishedAt: Date.now(),
    });
    writeCoordRecord(leaseDir, "leases", "taskN", {
      taskId: "taskN",
      epoch: 2,
      generation: "g2",
      instanceId: "inst-b",
      provisionalName: "valmont-sandbox-taskN--g-g2",
      containerId: "fakeid-g2",
      updatedAt: Date.now(),
    });
    // A STALE teardown retires generation g1 (epoch 1): the newer
    // epoch-2 records must survive untouched.
    const intern = internals(provider) as unknown as {
      retireTaskRecords(
        taskId: string,
        fence: unknown,
        resolved?: { epoch: number; generation: string; containerId: string },
      ): Promise<void>;
    };
    await intern.retireTaskRecords("taskN", undefined, {
      epoch: g1.epoch as number,
      generation: g1.generation as string,
      containerId: g1.containerId as string,
    });
    const mappings = readRecords(leaseDir, "mappings", "taskN");
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.epoch).toBe(2);
    const leases = readRecords(leaseDir, "leases", "taskN");
    expect(leases).toHaveLength(1);
    expect(leases[0]!.epoch).toBe(2);
  });

  it("an old handle from a superseded generation is rejected after a replacement (never silently re-bound)", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });
    const ws1 = await provider.create("taskOldH", src);
    // A replacement (fresh generation/epoch) supersedes the handle's.
    await provider.destroy("taskOldH");
    const ws2 = await provider.create("taskOldH", src);
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
    // The CURRENT handle operates on the replacement generation.
    expect(await provider.readFile(ws2, "a.txt")).toBe("x\n");
    // The OLD handle is rejected (fail closed) instead of silently
    // re-binding to the replacement's container.
    await expect(provider.readFile(ws1, "a.txt")).rejects.toThrow(
      /could not be determined/,
    );
  });

  it("losing the fence between the pre-spawn check and docker create leaves an unreachable orphan, never a mapping", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    const lockDir = path.join(leaseDir, ".locks", "taskSpawn.lock");
    state.onCreate = () => {
      // The fence was LIVE at the final pre-spawn check; it is broken away
      // at the exact instant the create is issued to the daemon.
      rmSync(lockDir, { recursive: true, force: true });
    };
    await expect(provider.create("taskSpawn", src)).rejects.toThrow(
      /could not be determined/,
    );
    // The daemon-side create DID land (the spawn happened), but it is an
    // unreachable orphan: no canonical mapping was ever published for it.
    expect(containerForTask(state, "taskSpawn")).toBeDefined();
    expect(readAuthoritativeMapping(leaseDir, "taskSpawn")).toBeUndefined();
    // A fresh instance cannot open it (no mapping => unavailable), and the
    // reaper removes the orphan by its immutable id, never by a mapping.
    const fresh = makeProvider(state, { leaseDir });
    await expect(fresh.open("taskSpawn")).rejects.toThrow(/unavailable/);
    await internals(fresh).reapExpired();
    expect(containerForTask(state, "taskSpawn")).toBeUndefined();
  });

  it("a delayed stale create surfacing after a replacement took ownership stays an unreachable orphan", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    // The FIRST create request times out client-side; the daemon defers
    // registering the half-initialized (generation g1) container.
    let g1Name: string | undefined;
    state.onCreate = (name) => {
      if (g1Name === undefined) {
        g1Name = name;
        state.lateCreates.set(name, { labels: {}, pending: false });
      }
    };
    await expect(provider.create("taskLate", src)).rejects.toThrow(/create/);
    expect(g1Name).toBeDefined();
    // A REPLACEMENT takes ownership (generation g2) and is destroyed.
    const ws = await provider.create("taskLate", src);
    const g2Name = containerForTask(state, "taskLate")!;
    expect(g2Name).not.toBe(g1Name);
    const g2Mapping = readAuthoritativeMapping(leaseDir, "taskLate");
    expect(g2Mapping).toBeDefined();
    // The daemon finishes the STALE create LATE — after the successor owns
    // the task. It surfaces under its own g1 provisional name.
    expect(flushLateCreate(state, g1Name!)).toBe(true);
    // The g1 container is NOT canonical: the authoritative mapping still
    // names the successor, and open()/handles resolve g2, never g1.
    expect(
      (
        readAuthoritativeMapping(leaseDir, "taskLate") as Record<
          string,
          unknown
        >
      ).containerId,
    ).toBe(g2Mapping!.containerId);
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
    expect(await provider.readFile(ws, "a.txt")).toBe("x\n");
    // The stale g1 orphan is reaped (by id/label/age verification), while
    // the successor's container and mapping are untouched.
    await internals(provider).reapExpired();
    expect(state.containers.has(g1Name!)).toBe(false);
    expect(state.containers.has(g2Name)).toBe(true);
    expect(
      (
        readAuthoritativeMapping(leaseDir, "taskLate") as Record<
          string,
          unknown
        >
      ).containerId,
    ).toBe(g2Mapping!.containerId);
  });

  it("a fence lost at the mapping-publication instant refuses publication (create fails closed)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    let broke = false;
    const provider = makeProvider(state, {
      leaseDir,
      fsOverride: {
        link: async (existingPath, newPath) => {
          if (
            newPath.includes(`${path.sep}mappings${path.sep}`) &&
            newPath.endsWith(".json")
          ) {
            // The fence is broken away and the link fails (EIO, not
            // EEXIST) at the publication instant: the mapping is refused.
            broke = true;
            const lockDir = path.join(leaseDir, ".locks", "taskMapPub.lock");
            for (const entry of readdirSync(lockDir)) {
              rmSync(path.join(lockDir, entry), { force: true });
            }
            rmSync(lockDir, { recursive: true, force: true });
            throw errnoFailure("EIO");
          }
          return fsLink(existingPath, newPath);
        },
      },
    });
    const src = await makeSource({ "a.txt": "x" });
    await expect(provider.create("taskMapPub", src)).rejects.toThrow(
      /could not be determined/,
    );
    expect(broke).toBe(true);
    // No canonical mapping was ever published; the half-initialized
    // container survives as a reaper-discoverable orphan (recovery
    // evidence), never as canonical state.
    expect(readRecords(leaseDir, "mappings", "taskMapPub")).toHaveLength(0);
    expect(containerForTask(state, "taskMapPub")).toBeDefined();
  });

  it("a stale publisher refuses to publish over a higher-epoch mapping (publication conflict fails closed)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const src = await makeSource({ "a.txt": "x" });
    // A peer publishes a HIGHER-epoch mapping the instant this create is
    // issued. The stale (lower-epoch) publisher must refuse to publish and
    // fail closed rather than clobber the authoritative mapping.
    state.onCreate = () => {
      writeCoordRecord(leaseDir, "mappings", "taskPubC", {
        taskId: "taskPubC",
        epoch: 99,
        generation: "peer-generation",
        instanceId: "inst-peer",
        provisionalName: "valmont-sandbox-taskPubC--g-peer-generation",
        containerId: "fakeid-peer",
        publishedAt: Date.now(),
      });
    };
    await expect(provider.create("taskPubC", src)).rejects.toThrow(
      /could not be determined/,
    );
    // The higher-epoch mapping is untouched; this provider never published.
    const records = readRecords(leaseDir, "mappings", "taskPubC");
    expect(records).toHaveLength(1);
    expect(records[0]!.epoch).toBe(99);
    // The just-created container was quarantined/removed, never canonical.
    expect(containerForTask(state, "taskPubC")).toBeUndefined();
  });

  it("an unreadable (EIO) mapping record fails closed, never treated as absent", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const dir = path.join(leaseDir, "mappings", "taskUnread");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "x.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "taskUnread",
        epoch: 1,
        generation: "g1",
        instanceId: "inst-a",
        provisionalName: "valmont-sandbox-taskUnread--g-g1",
        containerId: "fakeid-u",
        publishedAt: Date.now(),
      }),
    );
    // A mapping read that fails with EIO is NOT "absent": it fails closed.
    const rigged = makeProvider(state, {
      leaseDir,
      fsOverride: {
        readFile: async (p, encoding) => {
          if (
            p.includes(`${path.sep}mappings${path.sep}`) &&
            p.endsWith(".json")
          ) {
            throw errnoFailure("EIO");
          }
          return fsReadFile(p, encoding);
        },
      },
    });
    await expect(rigged.open("taskUnread")).rejects.toThrow(
      /could not be determined/,
    );
  });

  it("a failed QUARANTINE-marker restore (EIO, not EEXIST) retains the marker (recoverable, never lost)", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    makeProvider(state, { instanceId: "inst-a", leaseDir });
    // Seed a quarantine marker for the superseded generation.
    writeCoordRecord(leaseDir, "quarantines", "taskQM", {
      taskId: "taskQM",
      epoch: 1,
      generation: "g1",
      instanceId: "inst-a",
      containerId: "fakeid-q1",
      quarantinedAt: Date.now(),
    });
    // A replacement owner's (newer) marker lands between the teardown's
    // read and its capture, AND the restore link fails with EIO: the
    // capture must be RETAINED as a first-class recovery record.
    const replacement = JSON.stringify({
      schemaVersion: 1,
      taskId: "taskQM",
      epoch: 2,
      generation: "g2",
      instanceId: "inst-b",
      containerId: "fakeid-q2",
      quarantinedAt: Date.now(),
    });
    const rigged = makeProvider(state, {
      instanceId: "inst-a",
      leaseDir,
      fsOverride: {
        rename: async (oldPath, newPath) => {
          if (
            newPath.includes(".captured.") &&
            oldPath.includes(`${path.sep}quarantines${path.sep}`)
          ) {
            await fsWriteFile(oldPath, replacement);
          }
          return fsRename(oldPath, newPath);
        },
        link: async (existingPath, newPath) => {
          if (
            newPath.endsWith(".json") &&
            existingPath.includes(".captured.")
          ) {
            throw errnoFailure("EIO");
          }
          return fsLink(existingPath, newPath);
        },
      },
    });
    const intern = rigged as unknown as {
      retireQuarantineRecords(
        taskId: string,
        fence: unknown,
        epoch: number,
        generation: string,
        containerId: string,
      ): Promise<void>;
    };
    await intern.retireQuarantineRecords(
      "taskQM",
      undefined,
      1,
      "g1",
      "fakeid-q1",
    );
    const entries = recordEntries(leaseDir, "quarantines", "taskQM");
    expect(entries.some((e) => e.includes(".captured."))).toBe(true);
  });

  it("a retained capture is cleaned up once a later retirement proves it superseded", async () => {
    const state = makeState();
    const leaseDir = mkdtempSync(path.join(tmpdir(), "valmont-test-leases-"));
    leaseDirs.push(leaseDir);
    const provider = makeProvider(state, { leaseDir });
    const dir = path.join(leaseDir, "leases", "taskRC");
    mkdirSync(dir, { recursive: true });
    // A retained capture (a prior restore failed) holding an epoch-1 lease.
    writeFileSync(
      path.join(dir, "retained.json.captured.abc.tmp"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: "taskRC",
        epoch: 1,
        generation: "g1",
        instanceId: "inst-a",
        provisionalName: "valmont-sandbox-taskRC--g-g1",
        containerId: "fakeid-r1",
        updatedAt: Date.now(),
      }),
    );
    // A replacement generation (epoch 2) retires the superseded capture.
    const intern = internals(provider) as unknown as {
      retireTaskRecords(
        taskId: string,
        fence: unknown,
        resolved?: { epoch: number; generation: string; containerId: string },
      ): Promise<void>;
    };
    await intern.retireTaskRecords("taskRC", undefined, {
      epoch: 2,
      generation: "g2",
      containerId: "fakeid-r2",
    });
    expect(recordEntries(leaseDir, "leases", "taskRC")).toHaveLength(0);
  });

  it("destroy and quarantine remove by the immutable container id, never a reusable name", async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const src = await makeSource({ "a.txt": "x" });

    // Destroy path: the removal is bound to the container's immutable id.
    await provider.create("taskId1", src);
    const name1 = containerForTask(state, "taskId1")!;
    const id1 = state.idOf.get(name1)!;
    await provider.destroy("taskId1");

    // Quarantine path: a setup failure leaves the container, and the
    // quarantine removes it by its immutable id too.
    state.onExec = (_n, cmd) =>
      cmd[0] === "git"
        ? { code: 1, stdout: "", stderr: "git: boom\n" }
        : undefined;
    await expect(provider.create("taskId2", src)).rejects.toThrow(/initialise/);
    state.onExec = undefined;

    const rmTargets = state.calls
      .filter((c) => c.command === "docker" && c.args[0] === "rm")
      .map((c) => c.args[c.args.length - 1]);
    // Destroy removed exactly id1 (the immutable id), never the name.
    expect(rmTargets).toContain(id1);
    expect(rmTargets).not.toContain(name1);
    // Every removal (destroy + quarantine) targeted an immutable id.
    expect(rmTargets.length).toBeGreaterThanOrEqual(2);
    for (const target of rmTargets) {
      expect(target).toMatch(/^fakeid-\d+$/);
    }
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
