import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import type {
  MakeDirectoryOptions,
  RmOptions,
  Stats,
  WriteFileOptions,
} from "node:fs";
import { createReadStream } from "node:fs";
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
 * ("Critical sandbox boundary") and docs/SECURITY.md.
 *
 * # Lifecycle protocol: durable fencing epochs + generation-scoped names
 *
 * The lifecycle is coordinated through a DURABLE, MONOTONIC fencing epoch and
 * a GENERATION-scoped provisional container name, so a stale or suspended
 * process can never make an older container generation canonical after a
 * successor has taken ownership:
 *
 * 1. DURABLE MONOTONIC FENCING EPOCH. Every successful per-task fence
 *    acquisition allocates a durable, monotonically increasing, non-
 *    overwriting, crash-safe epoch: a `<n>` claim file in
 *    `<leaseDir>/epochs/<taskId>/` created with an exclusive `writeFile(...,
 *    { flag: "wx" })`; the next epoch is always `max(existing) + 1`, so
 *    concurrent or crashed allocators can never reuse an epoch. Epoch N+1 is
 *    authoritative over epoch N. Malformed, conflicting, or unreadable epoch
 *    state FAILS CLOSED (the fence acquisition fails). There is no
 *    wall-clock ownership ordering anywhere: ordering is epoch order only.
 *
 * 2. GENERATION-SCOPED PROVISIONAL NAMES. A generation UUID is minted BEFORE
 *    `docker create`; the provider NEVER creates with the canonical name
 *    `valmont-sandbox-<taskId>`. The provisional name is
 *    `valmont-sandbox-<taskId>--g-<generation>`, and the create labels are
 *    `valmont.managed=true`, `valmont.task=<taskId>`,
 *    `valmont.instance=<instanceId>`, `valmont.generation=<generation>`,
 *    `valmont.epoch=<epoch>`. A delayed/stale create can therefore only ever
 *    surface as an UNREACHABLE ORPHAN (nothing publishes a mapping for it).
 *
 * 3. SEPARATE CANONICAL MAPPING. Immutable coordination records in
 *    `<leaseDir>/mappings/<taskId>/<uuid>.json` carry schema version, task
 *    id, fencing epoch, generation UUID, provider instance id, provisional
 *    container name, immutable container id, and publication timestamp.
 *    Publication is NON-OVERWRITING (unique temp + exclusive link) and
 *    refused when a higher-epoch mapping already exists. Readers select the
 *    UNIQUE valid highest-epoch mapping; duplicate/conflicting/malformed/
 *    unreadable records at the same highest epoch FAIL CLOSED. A stale
 *    lower-epoch record is never canonical. Publication happens only after
 *    setup succeeds and the immutable id/labels/provisional name are
 *    verified.
 *
 * 4. IMMUTABLE-ID LIFECYCLE RESOLVER. open/create/handle ops/start/stop/
 *    destroy/quarantine/cleanup/reaper all share ONE resolver: read the
 *    highest-epoch mapping, verify the caller's epoch/generation, inspect
 *    Docker BY THE IMMUTABLE ID only (never by name), verify the labels and
 *    the provisional name, and return a bound object. The result is a
 *    discriminated union of absent / unknown / conflict / missing / legacy /
 *    bound — every caller maps those to its own fail-closed behavior.
 *
 * 5. STALE-OP BEHAVIOR. A lower-epoch operation targets only its own
 *    provisional name/id; a lower-epoch mapping is ignored; a stale create
 *    is an orphan; a stale cleanup may remove only its own old generation;
 *    post-op verification detects fence loss and routes uncertain side
 *    effects to orphan recovery without publishing a stale mapping.
 *
 * 6. LEASES. Versioned records in `<leaseDir>/leases/<taskId>/` bound to
 *    task/epoch/generation/instance/provisional name/container id. A refresh
 *    requires an EXACT match against the current mapping; a stale lower-epoch
 *    lease never supersedes; records are immutable (never overwritten) and
 *    readers scan the retained recovery records (`.tmp` captures fail
 *    closed); cleanup retires only superseded generations; destroy/
 *    replacement clears eligible captures.
 *
 * 7. QUARANTINE. Records in `<leaseDir>/quarantines/<taskId>/` bound to
 *    task/epoch/generation/container id. No reusable task-derived rename:
 *    the durable marker is the epoch-aware record (plus the legacy
 *    `<taskId>.quarantined` host file for migration). Markers are
 *    non-overwriting and epoch-aware; retained marker captures are
 *    first-class; replacement/destroy retires superseded captures; cleanup
 *    never removes a newer marker.
 *
 * 8. REAPER/ORPHAN CLEANUP. Resolve the current mapping and act only on the
 *    immutable id after exact label/epoch/generation verification; a lease
 *    never overrides a foreign immutable label; orphans are discovered via
 *    Docker label listing; a container is reaped only after id/label/age/
 *    fence verification AND only if no mapping references it; timed-out
 *    Docker results are UNKNOWN and never authorize cleanup.
 *
 * # Migration
 *
 * Explicit legacy (canonical-name) behavior: a container under
 * `valmont-sandbox-<taskId>` with no generation label is LEGACY state, never
 * silently treated as a new generation. Discovery is fail-closed (a
 * canonical-name container, or a legacy `-quarantined` container, is read as
 * legacy). Adoption is an isolated migration path: the container is renamed
 * by immutable id to a generation-scoped provisional name and a FRESH
 * epoch/generation mapping is published FIRST (marked `legacyAdopted`), before
 * any normal operation uses it. The legacy `<taskId>.lease` and
 * `<taskId>.quarantined` host files are read during migration and removed once
 * adoption publishes the new mapping. See `resolveTask`/`discoverLegacy`/
 * `adoptLegacy`.
 *
 * # Sandbox hardening (unchanged from the previous protocol)
 *
 * The container is created with `--user <uid>:<gid>` (uid/gid are the single
 * source of truth; uid 0 is rejected), `--init`, `--read-only`,
 * `--cap-drop ALL`, `--security-opt no-new-privileges:true`, NO explicit
 * seccomp option (so Docker's BUILT-IN default profile applies — an explicit
 * value is a profile FILE path: `seccomp=default` makes the daemon try to
 * open a file named "default" and reject the create, first seen in PR #35's
 * real-Docker CI run; `seccomp=unconfined` would weaken the sandbox and is
 * never used), `--network none`, CPU/memory/no-swap/PID limits, and
 * three bounded tmpfs mounts (`/workspace` owned by the task uid, a root-owned
 * `0701` `/reap` for the validation reaper, and `/dev/shm`). Every file
 * operation verifies each path component with fixed-argv `stat` and rejects
 * symlinks/non-directory ancestors; writes extract via a host-built tar
 * archive AS the unprivileged user (no in-container chown). Every exec is
 * direct argv (no shell). Validation runs a kernel-start-time reaper script
 * that SIGKILLs every process the validation started; a failed cleanup
 * quarantines the task. Cross-instance mutual exclusion is the token-based
 * mkdir fence described in `acquireTaskFence` (unchanged); the fencing epoch
 * allocated there is the ordering key layered on top of it.
 */
export interface DockerWorkspaceOptions {
  image: string;
  /**
   * The uid the unprivileged user runs as — the SINGLE source of truth for
   * the container identity: create-time `--user`, every exec's `--user`, and
   * the tmpfs mount ownership are all this numeric pair. Must be > 0 (root
   * task code could rewrite the root-owned reaper script). A user NAME is
   * deliberately not accepted.
   */
  uid?: number;
  /** The gid for the same identity; also the tmpfs mount owner. Must be > 0. */
  gid?: number;
  timeoutMs?: number;
  outputLimitBytes?: number;
  cpuLimit?: number;
  memoryLimitBytes?: number;
  pidsLimit?: number;
  storageLimitBytes?: number;
  ttlMs?: number;
  reapIntervalMs?: number;
  /**
   * This provider instance's identity (default: a random UUID per process).
   * Stamped as the creation-time `valmont.instance` label and compared when
   * resolving ownership. Set a STABLE value for a deployment that restarts.
   */
  instanceId?: string;
  /**
   * Host-side coordination directory: fences (`.locks/`), fencing epochs
   * (`epochs/`), canonical mappings (`mappings/`), versioned leases
   * (`leases/`), and quarantine records (`quarantines/`), plus the legacy
   * `<taskId>.lease` / `<taskId>.quarantined` files read during migration.
   * Default: `<os tmpdir>/valmont-sandbox-leases`. Always enabled.
   */
  leaseDir?: string;
  /**
   * How long a lease counts as alive (default 10 minutes). See the versioned
   * lease records in the class documentation.
   */
  leaseTtlMs?: number;
  /**
   * TTL of the cross-instance per-task fence (an `mkdir`-based lock directory
   * under `<leaseDir>/.locks`, default 20 minutes). See `acquireTaskFence`.
   */
  fenceLockTtlMs?: number;
  /** How long the reaper waits for the task fence before skipping. */
  fenceReapWaitMs?: number;
  /** How long an owner operation waits for the task fence. */
  fenceOwnerWaitMs?: number;
  /** Output cap (bytes) for the TTL reaper's `docker ps` listing. */
  psListLimitBytes?: number;
  allowedCommands?: Record<string, readonly [string, ...string[]]>;
  /** Test seam: replace the `docker` CLI invocation. */
  spawnOverride?: DockerSpawn;
  /**
   * TEST SEAM: per-function overrides for the filesystem operations the
   * coordination state (fences, epochs, mappings, leases, quarantine
   * records) uses.
   */
  fsOverride?: Partial<FenceFsSeam>;
}

export interface DockerSpawnOptions {
  stdio: ["pipe", "pipe", "pipe"] | ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  stdinPath?: string;
}

export type DockerSpawn = (
  command: string,
  args: readonly string[],
  options: DockerSpawnOptions,
) => ChildProcess;

/**
 * A held cross-instance per-task fence. `active` is false when the fence is
 * NOT held; every inactive outcome fails closed. `epoch` is the durable
 * monotonic fencing epoch allocated while the fence is held (see
 * `allocateEpoch`); it is the ordering key for every mapping/lease/quarantine
 * record published by this operation.
 */
interface HeldFence {
  taskId: string;
  token: string;
  active: boolean;
  /** Durable monotonic fencing epoch bound to this acquisition (0 if inactive). */
  epoch: number;
  inactiveReason?: "contention" | "unavailable" | "unknown";
  lockDir: string;
  tokenFile: string;
  lost: boolean;
  heartbeat?: NodeJS.Timeout;
  release: () => Promise<void>;
}

/**
 * A task's Docker container, BOUND to the immutable container identity a gate
 * or resolver step verified: `id` is the Docker container ID (stable for the
 * container's whole life), `name` is the generation-scoped provisional name.
 */
interface TaskContainer {
  taskId: string;
  epoch: number;
  generation: string;
  name: string;
  id: string;
}

const nodeSpawn: DockerSpawn = (command, args, options) =>
  spawn(command, args, options);

/**
 * The filesystem operations the CROSS-INSTANCE COORDINATION state (fence
 * locks, epochs, mappings, leases, quarantine records) runs through.
 * Production always uses the real `node:fs/promises` functions; `fsOverride`
 * is a TEST SEAM.
 */
export interface FenceFsSeam {
  lstat(path: string): Promise<Stats>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  rmdir(path: string, options?: RmOptions): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(
    path: string,
    options?: MakeDirectoryOptions,
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options?: WriteFileOptions,
  ): Promise<void>;
}

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

/** The documented lifecycle error for a task whose container is gone. */
const WORKSPACE_UNAVAILABLE = "Task workspace is unavailable";

/**
 * Fail-closed lifecycle error: a Docker probe failed for a reason other
 * than "no such object" (timeout, transport, permission, exit/parse error),
 * so the provider CANNOT tell whether the container exists. No destructive
 * action may follow this state.
 */
const WORKSPACE_UNDETERMINED = "Task workspace state could not be determined";

/**
 * How far in the FUTURE a lease/marker timestamp may read and still be
 * accepted as sane (host clock skew).
 */
const LEASE_FUTURE_SKEW_MS = 60_000;

/** Host-side overhead budgeted on top of every fenced Docker command. */
const FENCE_HOST_OVERHEAD_MS = 2_000;

/** Smallest allowed budget for a single fenced Docker command. */
const MIN_FENCED_COMMAND_MS = 1_000;

/** Floor for the fence renewal heartbeat interval. */
const MIN_FENCE_HEARTBEAT_MS = 25;

/** The error for a task owned by another live provider instance. */
const WORKSPACE_OWNED = "Task workspace is owned by another provider instance";

/**
 * What a Go `{{index .Labels "..."}}` template renders for a MISSING label.
 */
const NO_LABEL = "<no value>";

/**
 * Quarantined tasks reject every operation until explicit teardown.
 */
const QUARANTINE_ERROR =
  "Task workspace is quarantined (validation cleanup failed); destroy the task";

/**
 * Suffix of the LEGACY durable quarantine marker name (migration only): the
 * new protocol never renames a container to a task-derived name; a surviving
 * unremovable quarantined container is instead marked by an epoch-aware
 * quarantine RECORD. The suffix is kept so legacy `-quarantined` containers
 * are still discovered and reaped.
 */
const QUARANTINED_SUFFIX = "-quarantined";

/** The canonical name prefix (legacy discovery + provisional-name base). */
const CANONICAL_PREFIX = "valmont-sandbox-";

/** Coordination subdirectories under `leaseDir`. */
const EPOCHS_DIR = "epochs";
const MAPPINGS_DIR = "mappings";
const LEASES_DIR = "leases";
const QUARANTINES_DIR = "quarantines";

/**
 * Task identifiers are validated against TASK_ID AND must not end with the
 * quarantine suffix. The reservation is what keeps the task-name space
 * disjoint from the legacy quarantine-name space (see `isValidTaskId`).
 */
function isValidTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId) && !taskId.endsWith(QUARANTINED_SUFFIX);
}

/**
 * An immutable canonical mapping record (see the class documentation,
 * "Separate canonical mapping").
 */
interface MappingRecord {
  schemaVersion: 1;
  taskId: string;
  epoch: number;
  generation: string;
  instanceId: string;
  provisionalName: string;
  containerId: string;
  publishedAt: number;
  legacyAdopted: boolean;
}

/** A versioned lease record (see "Leases" in the class documentation). */
interface LeaseRecord {
  schemaVersion: 1;
  taskId: string;
  epoch: number;
  generation: string;
  instanceId: string;
  provisionalName: string;
  containerId: string;
  updatedAt: number;
}

/** An epoch-aware quarantine record (see "Quarantine"). */
interface QuarantineRecord {
  schemaVersion: 1;
  taskId: string;
  epoch: number;
  generation: string;
  instanceId: string;
  containerId: string;
  quarantinedAt: number;
}

/**
 * The shared immutable-id lifecycle resolver's result (see "Immutable-ID
 * lifecycle resolver" in the class documentation). Callers map each variant
 * to their own fail-closed behavior:
 * - `unknown`: the daemon/coordination state could not be determined — no
 *   destructive action may follow;
 * - `absent`: no mapping and no legacy container;
 * - `conflict`: the current state does not match what the caller expected
 *   (`stale` = a lower epoch/generation/id than authoritative, `labels` =
 *   label/name mismatch, `foreign` = another live instance owns it);
 * - `missing`: a mapping exists but its container is gone;
 * - `legacy`: an un-mapped canonical-name container (migration);
 * - `bound`: a verified, mapped, running container bound to its immutable id.
 */
type ResolvedTask =
  | { kind: "unknown" }
  | { kind: "absent" }
  | { kind: "conflict"; reason: "stale" | "labels" | "foreign" }
  | { kind: "missing" }
  | {
      kind: "legacy";
      taskId: string;
      name: string;
      containerId: string;
      running: boolean;
      instanceLabel: string;
      taskLabel: string;
      quarantined: boolean;
    }
  | {
      kind: "bound";
      taskId: string;
      epoch: number;
      generation: string;
      instanceId: string;
      name: string;
      containerId: string;
      running: boolean;
      legacyAdopted: boolean;
    };

/** Discriminated result of reading the versioned lease state for a task. */
type LeaseState =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "corrupt" }
  | {
      kind: "valid";
      instanceId: string;
      updatedAt: number;
      epoch: number;
      generation: string;
      containerId: string;
      provisionalName: string;
      legacy: boolean;
    };

/** Discriminated result of reading the durable quarantine state for a task. */
type QuarantineState =
  | { kind: "absent" }
  | {
      kind: "quarantined";
      epoch: number;
      generation: string;
      containerId: string;
      legacy: boolean;
    }
  | { kind: "unknown" };

function parseMappingRecord(raw: string): MappingRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  if (typeof r.taskId !== "string" || r.taskId === "") return null;
  if (
    typeof r.epoch !== "number" ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch <= 0
  ) {
    return null;
  }
  if (typeof r.generation !== "string" || r.generation === "") return null;
  if (typeof r.instanceId !== "string" || r.instanceId.trim() === "") {
    return null;
  }
  if (typeof r.provisionalName !== "string" || r.provisionalName === "") {
    return null;
  }
  if (typeof r.containerId !== "string" || r.containerId === "") return null;
  if (typeof r.publishedAt !== "number" || !Number.isFinite(r.publishedAt)) {
    return null;
  }
  const legacyAdopted = r.legacyAdopted === true;
  return {
    schemaVersion: 1,
    taskId: r.taskId,
    epoch: r.epoch,
    generation: r.generation,
    instanceId: r.instanceId,
    provisionalName: r.provisionalName,
    containerId: r.containerId,
    publishedAt: r.publishedAt,
    legacyAdopted,
  };
}

function parseLeaseRecord(raw: string): LeaseRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  if (typeof r.taskId !== "string" || r.taskId === "") return null;
  if (
    typeof r.epoch !== "number" ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch <= 0
  ) {
    return null;
  }
  if (typeof r.generation !== "string" || r.generation === "") return null;
  if (typeof r.instanceId !== "string" || r.instanceId.trim() === "") {
    return null;
  }
  if (typeof r.provisionalName !== "string" || r.provisionalName === "") {
    return null;
  }
  if (typeof r.containerId !== "string" || r.containerId === "") return null;
  if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) {
    return null;
  }
  const ts = r.updatedAt;
  if (ts < 946_684_800_000 || ts > Date.now() + LEASE_FUTURE_SKEW_MS) {
    return null;
  }
  return {
    schemaVersion: 1,
    taskId: r.taskId,
    epoch: r.epoch,
    generation: r.generation,
    instanceId: r.instanceId,
    provisionalName: r.provisionalName,
    containerId: r.containerId,
    updatedAt: ts,
  };
}

function parseQuarantineRecord(raw: string): QuarantineRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  if (typeof r.taskId !== "string" || r.taskId === "") return null;
  if (
    typeof r.epoch !== "number" ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch <= 0
  ) {
    return null;
  }
  if (typeof r.generation !== "string" || r.generation === "") return null;
  if (typeof r.instanceId !== "string" || r.instanceId.trim() === "") {
    return null;
  }
  if (typeof r.containerId !== "string" || r.containerId === "") return null;
  if (
    typeof r.quarantinedAt !== "number" ||
    !Number.isFinite(r.quarantinedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    taskId: r.taskId,
    epoch: r.epoch,
    generation: r.generation,
    instanceId: r.instanceId,
    containerId: r.containerId,
    quarantinedAt: r.quarantinedAt,
  };
}
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
 * Validation reaper, staged by the provider onto the root-owned `/reap`
 * tmpfs mount at creation and run AS THE UNPRIVILEGED USER (fixed argv,
 * no shell) after every validation run. It SIGKILLs every process in the
 * container that started at or after the given epoch-ms boundary — i.e.
 * everything the validation spawned, including background grandchildren —
 * so no validation process can outlive the validation and later race the
 * workspace paths. It signals as the same uid as the validation tree, so
 * no `CAP_KILL` is needed (which `--cap-drop ALL` would not grant
 * anyway); it can read the script (root-owned `0644` on the root-owned
 * `0701` mount) but has no write path to it or the mount — and the mount
 * point cannot be renamed or replaced — so it cannot tamper with its own
 * cleanup. Kernel `/proc` start times are used, which are immutable per
 * process and immune to reparenting.
 *
 * Start-time precision: the boundary is the host's wall clock (epoch ms)
 * captured just before the validation exec. Process start times are
 * jiffies since boot; instead of converting them through /proc/stat's
 * second-truncated `btime` (which can shift a reconstructed start by up
 * to ~1 s), the script derives a SUB-SECOND boot epoch from the kernel's
 * own monotonic uptime: bootMs = Date.now() - /proc/uptime, read in that
 * order so the estimate errs early (a later-appearing start can only
 * over-kill, never miss). The jiffies-to-ms conversion uses the real
 * USER_HZ from `getconf CLK_TCK` (a wrong or missing HZ would mis-scale
 * every start time, so it is fail-closed). The total reconstruction
 * error is bounded to ~2 ticks (20 ms at the slowest standard HZ=100)
 * plus the two-read gap, so the kill decision uses a 100 ms error budget
 * (CLEANUP_EPSILON_MS) instead of a second-scale margin. The only
 * process that could legitimately start inside that budget is the
 * container's main process (entrypoint) when a validation starts ~100 ms
 * after container start — and it is EXCLUDED EXPLICITLY, with pid 1:
 * the main process is pid 1's oldest child (it started at container
 * start, before every provider operation), while a validation descendant
 * reparented to pid 1 started strictly later and is therefore never the
 * oldest child and never excluded. Killing the main process would stop
 * the container (tini exits when it does), so no timing argument —
 * however good — is the guard against that; the exclusion is.
 *
 * Fail-closed contract (the provider treats any non-zero exit as a failed
 * cleanup): exit 2 = bad argument; exit 1 = USER_HZ or the uptime/boot
 * time is unreadable or inconsistent (start times would be uncomputable),
 * a pid could not be inspected or signalled (anything but ESRCH), a start
 * time was unparsable, or the confirmation scan still finds a non-zombie
 * process that started within the error budget after the boundary. A
 * delivered signal is NOT treated as proof of termination: kill rounds
 * rescan until a round finds nothing new (a killed process may have
 * forked a child just before dying), and a final confirmation scan
 * requires every bounded process to be gone or a zombie (dead — no
 * execution, memory, or file descriptors; only a pid slot remains until
 * its parent reaps it). Exit 0 only when that holds.
 *
 * `VALMONT_REAPER_PROC_DIR` is a TEST SEAM only: it redirects the /proc
 * reads so unit tests can run the script against a synthetic /proc tree.
 * The provider never sets it — the reaper exec passes no environment at
 * all — so in production the reads always target the real /proc, and a
 * task process cannot influence the provider's reaper invocation.
 */
export const VALIDATION_REAPER_SCRIPT = `import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const fail = (code, message) => {
  process.stderr.write("validation-reap: " + message + "\\n");
  process.exit(code);
};

// Test seam (never set by the provider; see the doc above).
const PROC = process.env.VALMONT_REAPER_PROC_DIR || "/proc";

const boundary = Number(process.argv[2]);
if (!Number.isInteger(boundary) || boundary <= 0) {
  fail(2, "expected a positive integer epoch-ms boundary");
}

// USER_HZ (jiffies per second): the jiffies-to-ms conversion factor for
// process start times. A wrong or missing HZ would mis-scale every
// start time, so it is fail-closed.
let hz;
try {
  hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
} catch {
  hz = NaN;
}
if (!Number.isInteger(hz) || hz <= 0) {
  fail(
    1,
    "cannot determine USER_HZ (getconf CLK_TCK); refusing to run cleanup",
  );
}

// Sub-second boot epoch. /proc/stat's btime is truncated to whole
// seconds, so boot times are NOT reconstructed from it (that can shift
// a start time by up to ~1 s). Instead the boot time comes from the
// kernel's own monotonic uptime (seconds at 1/100 s resolution, same
// kernel that stamps process start times):
//   bootMs = wall clock - uptime
// with the WALL clock read FIRST: the estimate then errs EARLY, and an
// early boot estimate makes processes appear OLDER — which can only
// over-kill, never miss. (See the doc above for the error budget and
// the explicit exclusion of the pre-validation process set.)
const wallMs = Date.now();
let uptimeSec;
try {
  uptimeSec = Number(readFileSync(PROC + "/uptime", "utf8").split(" ")[0]);
} catch {
  uptimeSec = NaN;
}
if (!Number.isFinite(uptimeSec) || uptimeSec < 0) {
  fail(1, "cannot read /proc/uptime; refusing to run cleanup");
}
const bootMs = wallMs - uptimeSec * 1000;

// Cross-check the uptime-derived boot time against the kernel's btime
// (whole seconds): the true boot is in [btime, btime + 1 s) and the
// estimate's error is at most a couple of ticks, so the estimate must
// sit just inside that second. Anything else means the two sources
// disagree — neither can be trusted, so fail closed.
let statFile;
try {
  statFile = readFileSync(PROC + "/stat", "utf8");
} catch {
  fail(1, "cannot read /proc/stat; refusing to run cleanup");
}
let btimeSec = 0;
for (const line of statFile.split("\\n")) {
  if (line.startsWith("btime ")) {
    btimeSec = Number(line.slice(6).trim());
    break;
  }
}
if (!Number.isFinite(btimeSec) || btimeSec <= 0) {
  fail(1, "boot time unavailable; refusing to run cleanup");
}
const btimeMs = btimeSec * 1000;
if (bootMs < btimeMs - 100 || bootMs >= btimeMs + 1100) {
  fail(
    1,
    "uptime-derived boot time inconsistent with btime; refusing to run cleanup",
  );
}

// Error budget (ms) for the kill decision. The reconstructed start
// time bootMs + jiffies*1000/HZ is off from a process's true start by
// at most ~2 ticks (20 ms at the slowest standard HZ=100) plus the
// wall/uptime read gap. 100 ms covers that with headroom: a validation
// process spawned at or after the boundary is NEVER missed. The only
// legitimate process that could start within the budget (the
// container's main process, if a validation starts ~100 ms after
// container start) is excluded EXPLICITLY below — the pre-validation
// process set is not guarded by the budget alone.
const EPSILON_MS = 100;
const limit = boundary - EPSILON_MS;
const self = process.pid;

// Read one pid's stat. Returns null for a pid that is gone (ENOENT
// only); any other read error means we cannot reason about it — fail
// closed.
const readStat = (pid) => {
  let stat;
  try {
    stat = readFileSync(PROC + "/" + pid + "/stat", "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      fail(1, "cannot read /proc/" + pid + "/stat; not assuming it is safe");
    }
    return null;
  }
  // Field 2 (comm) is parenthesised and may contain spaces or parens,
  // so split after the last ')'. fields[0] is state (stat field 3),
  // fields[1] is ppid (stat field 4); fields[19] is starttime (stat
  // field 22: jiffies since boot).
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  const starttime = Number(fields[19]);
  if (!Number.isFinite(starttime)) {
    fail(1, "unparsable start time for pid " + pid);
  }
  return { pid, state: fields[0], ppid: Number(fields[1]), starttime };
};

// Every live process (except self and pid 1), freshly read.
const collect = () => {
  const procs = [];
  for (const entry of readdirSync(PROC)) {
    if (!/^\\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === self || pid === 1) continue;
    const parsed = readStat(pid);
    if (parsed !== null) procs.push(parsed);
  }
  return procs;
};

// The container's MAIN process, excluded explicitly with pid 1 (see
// the doc above): pid 1's child with the SMALLEST start time — it
// started when the container started, before every provider operation,
// so it is by definition pre-validation. A validation descendant
// reparented to pid 1 started strictly later (pids are never reused
// within a namespace), so it is never the oldest child and is never
// excluded — it is still killed.
const mainPidOf = (procs) => {
  let main;
  let oldest = Infinity;
  for (const p of procs) {
    if (p.ppid === 1 && p.starttime < oldest) {
      oldest = p.starttime;
      main = p.pid;
    }
  }
  return main;
};

// Every process whose RECONSTRUCTED start time is within EPSILON_MS
// after the boundary, EXCEPT the excluded pre-validation set, with its
// current state.
const scan = () => {
  const procs = collect();
  const mainPid = mainPidOf(procs);
  const targets = [];
  for (const p of procs) {
    if (p.pid === mainPid) continue;
    if (bootMs + (p.starttime / hz) * 1000 >= limit) {
      targets.push({ pid: p.pid, state: p.state });
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
  private readonly uid: number;
  private readonly gid: number;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly cpuLimit: number;
  private readonly memoryLimitBytes: number;
  private readonly pidsLimit: number;
  private readonly storageLimitBytes: number;
  private readonly ttlMs: number;
  private readonly psListLimitBytes: number;
  private readonly allowedCommands: Record<
    string,
    readonly [string, ...string[]]
  >;
  private readonly spawnImpl: DockerSpawn;
  /**
   * This instance's identity (see the `instanceId` option): stamped on
   * every container this instance creates and compared against the
   * `valmont.instance` label when resolving task ownership.
   */
  readonly instanceId: string;
  /** Host-side lease directory (see the `leaseDir` option); always set. */
  readonly leaseDir: string;
  /** Lease liveness window (see the `leaseTtlMs` option). */
  readonly leaseTtlMs: number;
  /** TTL of a cross-instance task fence held by a dead process. */
  private readonly fenceLockTtlMs: number;
  /** How long the reaper waits for the fence before skipping. */
  private readonly fenceReapWaitMs: number;
  /** How long an owner operation waits for the fence. */
  private readonly fenceOwnerWaitMs: number;
  /**
   * Renewal heartbeat interval for a held fence: max(MIN_FENCE_HEARTBEAT_MS,
   * fenceLockTtlMs / 3), always strictly below the TTL (validated at
   * construction).
   */
  private readonly fenceHeartbeatMs: number;
  /**
   * Largest timeout any single fenced Docker command may use: half the
   * fence TTL minus host-side overhead (validated at construction so the
   * fixed Docker operation timeouts are clamped, never able to outlive
   * the fence that serializes them).
   */
  private readonly maxFencedCommandMs: number;
  /**
   * The coordination-state filesystem (fences, leases, quarantine
   * markers): the real node:fs/promises functions, plus the test seam
   * overrides (see FenceFsSeam).
   */
  private readonly fs: FenceFsSeam;
  private reaperTimer?: NodeJS.Timeout;
  private reaperRunning = false;
  /**
   * Per-task operation queues: every provider operation for a task runs
   * strictly one at a time (FIFO), so one operation's stat-then-use
   * sequence can never interleave with another operation on the same task.
   */
  private readonly taskLocks = new Map<string, Promise<void>>();
  /**
   * Last provider-operation timestamp per task, recorded when an operation
   * is ENQUEUED and REFRESHED when it COMPLETES (not when it starts
   * executing): a task is "abandoned" (and eligible for reaping) only when
   * it has had neither an in-flight nor a queued operation for longer than
   * the TTL — a long-running or backlog-heavy but still-active task is
   * never reaped, and a long operation that outlives its own enqueue
   * timestamp cannot be reaped the moment it finishes (the reaper waits
   * behind it for the per-task lock, and the completion refresh makes the
   * in-lock activity check see the task as freshly used).
   */
  private readonly taskActivity = new Map<string, number>();
  /**
   * Quarantined tasks: a validation cleanup failed (a survivor process may
   * be racing the workspace and can evade later cleanups — it predates the
   * next boundary), so the workspace is untrusted. Every operation rejects
   * with "Task workspace is quarantined" until an explicit destroy() — or
   * a create() that fully replaces the container — succeeds. The flag
   * persists even if the immediate best-effort removal fails.
   */
  private readonly quarantinedTasks = new Set<string>();
  /**
   * The epoch/generation/immutable-id each HANDED-OUT handle was bound to.
   * A handle is a lightweight `{ id, root }` object (the public interface),
   * so the binding is kept here rather than on the handle itself. Handle
   * operations re-resolve the current mapping through the shared resolver
   * UNDER this binding: a handle minted for a superseded generation is
   * rejected (fail closed) instead of silently re-binding to a replacement.
   */
  private readonly handleBindings = new WeakMap<
    WorkspaceHandle,
    { epoch: number; generation: string; containerId: string }
  >();

  constructor(options: DockerWorkspaceOptions) {
    this.image = options.image;
    this.uid = options.uid ?? 1000;
    this.gid = options.gid ?? 1000;
    // Root task code would defeat the isolation boundary (it could rewrite
    // the root-owned reaper script, read any root-owned file, ...). The
    // uid/gid pair is the single source of truth for the container
    // identity, so rejecting 0 here covers create, every exec, and the
    // tmpfs ownership at once.
    if (!Number.isInteger(this.uid) || this.uid <= 0) {
      throw new Error(
        `The sandbox uid must be a positive integer: ${this.uid}`,
      );
    }
    if (!Number.isInteger(this.gid) || this.gid <= 0) {
      throw new Error(
        `The sandbox gid must be a positive integer: ${this.gid}`,
      );
    }
    // The numeric identity used for create --user, every exec --user, and
    // the tmpfs mount ownership — one pair, so they cannot disagree.
    this.user = `${this.uid}:${this.gid}`;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.outputLimitBytes = options.outputLimitBytes ?? 256_000;
    this.cpuLimit = options.cpuLimit ?? 2;
    this.memoryLimitBytes = options.memoryLimitBytes ?? 2_147_483_648;
    this.pidsLimit = options.pidsLimit ?? 256;
    this.storageLimitBytes = options.storageLimitBytes ?? 2_147_483_648;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.psListLimitBytes = options.psListLimitBytes ?? 4_194_304;
    this.allowedCommands = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
    this.spawnImpl = options.spawnOverride ?? nodeSpawn;
    // The instance identity becomes part of a container LABEL, whose
    // values are parsed by `inspectContainer` as a single pipe-delimited
    // line. An empty/whitespace id would read back as NO_LABEL (every
    // container would look unlabeled — and therefore adoptable); a `|`
    // or newline would break that parse. Both are rejected at
    // construction, before any state is built around the id.
    this.instanceId = options.instanceId ?? randomUUID();
    if (this.instanceId.trim() === "" || /[\s|]/.test(this.instanceId)) {
      throw new Error(
        `The sandbox instanceId must be a non-empty, whitespace-free label: ${JSON.stringify(this.instanceId)}`,
      );
    }
    // Lease files are ALWAYS enabled: without cross-instance liveness
    // information the default config would either let one instance's
    // reaper remove a task another live instance is using (foreign
    // containers reaped by age) or orphan every container after a
    // restart (foreign containers never reaped). The default directory
    // lives in the OS temp dir (writable, per-host); a deployment with
    // several provider processes on one host shares it automatically.
    this.leaseDir =
      options.leaseDir ?? path.join(tmpdir(), "valmont-sandbox-leases");
    this.leaseTtlMs = options.leaseTtlMs ?? 600_000;
    this.fenceLockTtlMs = options.fenceLockTtlMs ?? 1_200_000;
    this.fenceReapWaitMs = options.fenceReapWaitMs ?? 15_000;
    this.fenceOwnerWaitMs =
      options.fenceOwnerWaitMs ?? this.fenceLockTtlMs + 30_000;
    this.fs = {
      lstat,
      utimes,
      rm,
      rmdir,
      rename,
      link,
      readdir,
      mkdir,
      readFile,
      writeFile,
      ...options.fsOverride,
    };
    // Every timing value must be a positive finite number: NaN/0/negative
    // TTLs and timeouts would silently disable liveness and fencing
    // (a NaN TTL compares false everywhere and makes nothing stale).
    const positiveFinite = (name: string, value: number): number => {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `The ${name} must be a positive finite number of milliseconds: ${value}`,
        );
      }
      return value;
    };
    positiveFinite("command timeout (timeoutMs)", this.timeoutMs);
    positiveFinite("task TTL (ttlMs)", this.ttlMs);
    positiveFinite("lease TTL (leaseTtlMs)", this.leaseTtlMs);
    positiveFinite("fence TTL (fenceLockTtlMs)", this.fenceLockTtlMs);
    positiveFinite("fence reaper wait (fenceReapWaitMs)", this.fenceReapWaitMs);
    positiveFinite(
      "fence owner wait (fenceOwnerWaitMs)",
      this.fenceOwnerWaitMs,
    );
    // Renewal heartbeat: a live holder renews its token at
    // max(MIN_FENCE_HEARTBEAT_MS, TTL/3). An interval at or above the TTL
    // would let a LIVE holder's token go stale between beats (the
    // documented misconfiguration behind "a long-running owner operation
    // renews its fence"), so such a TTL is rejected outright.
    this.fenceHeartbeatMs = Math.max(
      MIN_FENCE_HEARTBEAT_MS,
      Math.floor(this.fenceLockTtlMs / 3),
    );
    if (this.fenceHeartbeatMs >= this.fenceLockTtlMs) {
      throw new Error(
        `fenceLockTtlMs (${this.fenceLockTtlMs}) is too small: the renewal ` +
          `heartbeat interval (${this.fenceHeartbeatMs} ms) must stay ` +
          `below the TTL or a live holder looks stale between beats`,
      );
    }
    // DOCUMENTED OPERATION BOUND, actually enforced: a fenced Docker
    // command may run at most half the fence TTL, HOST OVERHEAD INCLUDED.
    // This covers (a) the user-configured per-command timeoutMs, and
    // (b) the FIXED Docker operation timeouts (create/start/rm/rename/
    // stop/inspect/cp — 15–60 s) which are clamped to the same budget,
    // so a small fence TTL cannot silently leave a fixed-timeout
    // operation that outlives the fence. The bound keeps a frozen-then-
    // resumed operation from overlapping a stale-break takeover: the
    // peer can only take over after the TTL, by which time every bounded
    // command of a live operation has long finished.
    this.maxFencedCommandMs =
      Math.floor(this.fenceLockTtlMs / 2) - FENCE_HOST_OVERHEAD_MS;
    if (this.maxFencedCommandMs < MIN_FENCED_COMMAND_MS) {
      throw new Error(
        `fenceLockTtlMs (${this.fenceLockTtlMs}) is too small: every ` +
          `fenced Docker command (including the fixed 15-60 s operation ` +
          `timeouts) must fit in half the TTL minus ` +
          `${FENCE_HOST_OVERHEAD_MS} ms of host overhead; configure a ` +
          `fence TTL of at least ` +
          `${2 * (MIN_FENCED_COMMAND_MS + FENCE_HOST_OVERHEAD_MS)} ms or ` +
          `raise it until timeoutMs fits the bound`,
      );
    }
    if (this.timeoutMs > this.maxFencedCommandMs) {
      throw new Error(
        `timeoutMs (${this.timeoutMs}) exceeds the fenced operation bound ` +
          `(fenceLockTtlMs=${this.fenceLockTtlMs} → at most ` +
          `${this.maxFencedCommandMs} ms per command including host ` +
          `overhead): an operation cannot outlive the fence that ` +
          `serializes it`,
      );
    }
    const reapIntervalMs = options.reapIntervalMs ?? 600_000;
    if (reapIntervalMs < 0 || !Number.isFinite(reapIntervalMs)) {
      throw new Error(
        `The reap interval must be a non-negative finite number: ${reapIntervalMs}`,
      );
    }
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
      // No VALMONT_SANDBOX_USER: a user NAME would resolve against the
      // image's /etc/passwd and could disagree with the numeric create
      // uid. VALMONT_SANDBOX_UID/_GID (fallback 1000:1000) are the single
      // source of truth; "0" falls back to the non-root default.
      uid: positive(env.VALMONT_SANDBOX_UID, 1000),
      gid: positive(env.VALMONT_SANDBOX_GID, 1000),
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
      // Cross-instance coordination. In a single-process deployment the
      // defaults (a per-host tmpdir lease dir, a random per-process
      // identity) are correct; a deployment with several provider
      // processes sharing one Docker daemon — in particular processes
      // on DIFFERENT hosts — must point VALMONT_SANDBOX_LEASE_DIR at a
      // shared POSIX-consistent volume (the mkdir/rename/utimes fence
      // lives there) and, for processes expected to resume their own
      // tasks across restarts, give each logical provider a stable
      // VALMONT_SANDBOX_INSTANCE_ID (distinct per concurrently-live
      // provider).
      ...(env.VALMONT_SANDBOX_LEASE_DIR?.trim()
        ? { leaseDir: env.VALMONT_SANDBOX_LEASE_DIR.trim() }
        : {}),
      ...(env.VALMONT_SANDBOX_INSTANCE_ID?.trim()
        ? { instanceId: env.VALMONT_SANDBOX_INSTANCE_ID.trim() }
        : {}),
      ...(env.VALMONT_SANDBOX_LEASE_TTL_MS
        ? { leaseTtlMs: positive(env.VALMONT_SANDBOX_LEASE_TTL_MS, 600_000) }
        : {}),
      ...(env.VALMONT_SANDBOX_FENCE_TTL_MS
        ? {
            fenceLockTtlMs: positive(
              env.VALMONT_SANDBOX_FENCE_TTL_MS,
              1_200_000,
            ),
          }
        : {}),
    });
  }
  async create(taskId: string, sourceRoot: string): Promise<WorkspaceHandle> {
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    return this.withOwnerTaskOperation(taskId, (fence) =>
      this.createCore(taskId, sourceRoot, fence),
    );
  }

  private async createCore(
    taskId: string,
    sourceRoot: string,
    fence: HeldFence,
  ): Promise<WorkspaceHandle> {
    // The generation is minted BEFORE any destructive call (a replacement
    // removes the old container), so the generation-scoped provisional name
    // exists in memory for the whole setup sequence and can never collide
    // with any other generation. `docker create` NEVER uses the canonical
    // name: a delayed/stale create of this generation can therefore only
    // ever surface as an unreachable orphan (no mapping references it).
    const generation = randomUUID();
    const provisional = this.provisionalName(taskId, generation);
    const epoch = fence.epoch;
    // The immutable container id once the daemon has reported one (used to
    // bind setup and, on failure, the quarantine record to THIS container).
    // A `docker create` REQUEST that fails (non-zero exit after a
    // daemon-side accept, a CLI timeout, or a spawn/transport failure) never
    // reports an id, so `knownId` stays undefined: the daemon may hold — or
    // may yet SURFACE, late — a half-initialized container. Because it
    // carries the generation-scoped provisional name and NO mapping is ever
    // published for it, it is an unreachable orphan by construction.
    let knownId: string | undefined;

    const createArgs = [
      "create",
      "--name",
      provisional,
      "--user",
      `${this.uid}:${this.gid}`,
      "--init",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      // NOTE: no explicit seccomp option. Docker applies its BUILT-IN
      // default seccomp profile only when no `--security-opt seccomp=…`
      // is present; an explicit value is a profile FILE path
      // (`seccomp=default` makes the daemon try to open a file named
      // "default" and reject the create — carried over from #35's
      // real-Docker CI fix). "unconfined" would weaken the sandbox and
      // is deliberately not used either.
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
      "--tmpfs",
      `/workspace:rw,nosuid,nodev,size=${this.storageLimitBytes},uid=${this.uid},gid=${this.gid}`,
      "--tmpfs",
      "/reap:rw,nosuid,nodev,mode=0701,size=1m",
      "--tmpfs",
      "/dev/shm:rw,nosuid,nodev,mode=777,size=64m",
      "--label",
      "valmont.managed=true",
      "--label",
      `valmont.task=${taskId}`,
      "--label",
      `valmont.instance=${this.instanceId}`,
      "--label",
      `valmont.generation=${generation}`,
      "--label",
      `valmont.epoch=${String(epoch)}`,
      "--restart",
      "no",
      "--stop-timeout",
      "5",
      this.image,
    ];
    // Pre-cleanup: resolve the current mapping and remove any previous
    // generation (and any legacy canonical-name container) by its IMMUTABLE
    // id, retiring its superseded records. This gate runs OUTSIDE the setup
    // try/catch: a refusal (a foreign live owner, a corrupt claim, an
    // unknown state) is a lifecycle error that must propagate WITHOUT
    // quarantine — only an ACTUAL setup failure quarantines.
    await this.removeExistingForReplacement(taskId, fence);
    try {
      const created = await this.fencedDocker(
        fence,
        createArgs,
        this.opTimeout(60_000),
        this.outputLimitBytes,
      );
      if (created.code !== 0 || created.timedOut) {
        throw new Error(
          `Could not create sandbox container: ${created.stderr.trim() || created.code}`,
        );
      }
      const newId = created.stdout.trim();
      if (!newId) {
        throw new Error(
          "Could not create sandbox container: the daemon reported no container id",
        );
      }
      knownId = newId;
      // VERIFY the daemon-side result before any setup step: the immutable
      // id, the provisional name, and all five ownership labels must match
      // what this generation demanded. A mismatch fails the create closed.
      await this.verifyCreatedContainer(
        taskId,
        newId,
        fence,
        generation,
        epoch,
        provisional,
      );
      const started = await this.fencedDocker(
        fence,
        ["start", newId],
        this.opTimeout(30_000),
        this.outputLimitBytes,
      );
      if (started.code !== 0) {
        throw new Error(
          `Could not start sandbox container: ${started.stderr.trim() || started.code}`,
        );
      }
      await this.stageSource(taskId, sourceRoot, newId, fence);
      await this.installValidationReaper(taskId, newId, fence);
      await this.gitBaseline(taskId, newId, fence);
    } catch (error) {
      // Setup failed — including the `docker create` call itself, whose
      // failure/timeout is an UNCERTAIN side effect. Quarantine
      // UNCONDITIONALLY while the fence is still held: remove the container
      // by immutable id if it can be removed, and otherwise make the
      // quarantine durable (an epoch-aware record). A late-surfacing create
      // needs NO tombstone: it is a generation-scoped orphan with no
      // mapping. The original setup error wins; a quarantine that could not
      // be made DURABLE is surfaced as the undetermined error.
      const outcome = await this.quarantineTask(
        taskId,
        fence,
        knownId ? { epoch, generation, containerId: knownId } : undefined,
      );
      if (outcome === "failed") {
        throw new Error(WORKSPACE_UNDETERMINED);
      }
      throw error;
    }
    // Setup completed fully. Publish the canonical mapping FIRST (see the
    // class documentation): it is what makes THIS generation authoritative
    // and openable. A stale/lost fence or a conflicting higher-epoch mapping
    // makes the publication fail closed.
    this.quarantinedTasks.delete(taskId);
    await this.retireQuarantineRecords(
      taskId,
      fence,
      epoch,
      generation,
      knownId!,
    );
    await this.removeLegacyFiles(taskId);
    const published = await this.publishMapping(
      taskId,
      fence,
      epoch,
      generation,
      provisional,
      knownId!,
    );
    if (!published) {
      await this.quarantineTask(taskId, fence, {
        epoch,
        generation,
        containerId: knownId!,
      });
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    const leased = await this.writeLease(
      taskId,
      fence,
      epoch,
      generation,
      provisional,
      knownId!,
    );
    if (!leased) {
      // The setup fully succeeded and the mapping is durable, but the
      // liveness claim is not: another instance's reaper could age-reap a
      // live container. Quarantine the ready container and fail closed.
      await this.quarantineTask(taskId, fence, {
        epoch,
        generation,
        containerId: knownId!,
      });
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    this.taskActivity.set(taskId, Date.now());
    return this.bindHandle(taskId, {
      epoch,
      generation,
      containerId: knownId!,
    });
  }

  async open(taskId: string): Promise<WorkspaceHandle> {
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    this.taskActivity.set(taskId, Date.now());
    return this.withOwnerTaskOperation(taskId, (fence) =>
      this.openCore(taskId, fence),
    );
  }

  private async openCore(
    taskId: string,
    fence: HeldFence,
  ): Promise<WorkspaceHandle> {
    this.assertNotQuarantined(taskId);
    // A durable quarantine record (any instance, any epoch) blocks open: the
    // container it names is untrusted. Unknown quarantine state fails closed.
    const marked = await this.readQuarantine(taskId);
    if (marked.kind === "unknown") {
      this.quarantinedTasks.add(taskId);
      throw new Error(QUARANTINE_ERROR);
    }
    if (marked.kind === "quarantined") {
      this.quarantinedTasks.add(taskId);
      throw new Error(QUARANTINE_ERROR);
    }
    // The shared resolver reads the highest-epoch mapping and verifies the
    // immutable id + labels + provisional name in ONE pass. A legacy
    // canonical-name container is a MIGRATION case, never silently treated
    // as a new generation.
    const resolved = await this.resolveTask(taskId, fence);
    switch (resolved.kind) {
      case "unknown":
        throw new Error(WORKSPACE_UNDETERMINED);
      case "absent":
      case "missing":
        throw new Error(WORKSPACE_UNAVAILABLE);
      case "conflict":
        if (resolved.reason === "foreign") throw new Error(WORKSPACE_OWNED);
        if (resolved.reason === "labels") {
          throw new Error(WORKSPACE_UNAVAILABLE);
        }
        throw new Error(WORKSPACE_UNDETERMINED);
      case "legacy": {
        if (resolved.quarantined) {
          this.quarantinedTasks.add(taskId);
          throw new Error(QUARANTINE_ERROR);
        }
        if (!resolved.running) throw new Error(WORKSPACE_UNAVAILABLE);
        if (this.classifyContainer(resolved.instanceLabel) === "foreign") {
          throw new Error(WORKSPACE_OWNED);
        }
        if (this.classifyContainer(resolved.instanceLabel) === "unlabeled") {
          await this.assertNoForeignLegacyClaim(taskId, resolved.name);
        }
        // MIGRATION ADOPTION: publish a fresh epoch/generation mapping
        // FIRST (marked legacyAdopted), then hand out the handle bound to
        // that fresh generation.
        const adopted = await this.adoptLegacy(taskId, resolved, fence);
        this.taskActivity.set(taskId, Date.now());
        return this.bindHandle(taskId, {
          epoch: adopted.epoch,
          generation: adopted.generation,
          containerId: adopted.containerId,
        });
      }
      case "bound": {
        if (resolved.instanceId !== this.instanceId) {
          throw new Error(WORKSPACE_OWNED);
        }
        if (!resolved.running) throw new Error(WORKSPACE_UNAVAILABLE);
        // Refresh the versioned lease for the CURRENT generation. A refresh
        // that cannot be made durable fails the open closed.
        const leased = await this.writeLease(
          taskId,
          fence,
          resolved.epoch,
          resolved.generation,
          resolved.name,
          resolved.containerId,
        );
        if (!leased) throw new Error(WORKSPACE_UNDETERMINED);
        this.taskActivity.set(taskId, Date.now());
        return this.bindHandle(taskId, {
          epoch: resolved.epoch,
          generation: resolved.generation,
          containerId: resolved.containerId,
        });
      }
    }
  }
  async readFile(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<string> {
    this.safeContainerPath(relativePath);
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.readFileCore(workspace, relativePath, fence),
    );
  }

  private async readFileCore(
    workspace: WorkspaceHandle,
    relativePath: string,
    fence: HeldFence,
  ): Promise<string> {
    const container = await this.gateHandleOperation(workspace, fence);
    const absolute = this.safeContainerPath(relativePath);
    const target = await this.verifyPathComponents(container, absolute, fence);
    if (target === null) throw new Error("Could not read workspace file");
    const result = await this.execIn(
      container.id,
      ["cat", "--", absolute],
      this.opTimeout(15_000),
      this.outputLimitBytes,
      fence,
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
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.readFileForCommitCore(workspace, relativePath, fence),
    );
  }

  private async readFileForCommitCore(
    workspace: WorkspaceHandle,
    relativePath: string,
    fence: HeldFence,
  ): Promise<string> {
    const container = await this.gateHandleOperation(workspace, fence);
    const absolute = this.safeContainerPath(relativePath);
    const target = await this.verifyPathComponents(container, absolute, fence);
    if (target === null) throw new Error("Could not read workspace file");
    const result = await this.execIn(
      container.id,
      ["cat", "--", absolute],
      this.opTimeout(15_000),
      this.outputLimitBytes,
      fence,
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
    // Pure local validation before taking the queue/fence (and before
    // any docker call): invalid/sensitive paths must produce the
    // path error, not an ownership error.
    if (isSensitivePath(relativePath)) {
      throw new Error("Writing sensitive paths is blocked");
    }
    this.safeContainerPath(relativePath);
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.writeFileCore(workspace, relativePath, content, fence),
    );
  }

  private async writeFileCore(
    workspace: WorkspaceHandle,
    relativePath: string,
    content: string,
    fence: HeldFence,
  ): Promise<void> {
    const container = await this.gateHandleOperation(workspace, fence);
    if (isSensitivePath(relativePath)) {
      throw new Error("Writing sensitive paths is blocked");
    }
    const absolute = this.safeContainerPath(relativePath);
    await this.prepareWriteParents(container, absolute, fence);
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const archive = `${scratch}.tar`;
    try {
      // The content file is staged under its workspace-relative path so
      // the tar member IS that path (no symlinks, no host paths in the
      // archive). safeContainerPath already rejected absolute paths,
      // NUL/newline bytes, and `..` components; this guard is the
      // host-side containment check that refuses to stage anything
      // outside the scratch directory regardless.
      const target = path.resolve(scratch, relativePath);
      if (target === scratch || !target.startsWith(`${scratch}${path.sep}`)) {
        throw new Error("Invalid workspace path");
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
      // Extract in the container AS the unprivileged user: the file AND
      // any parents the extraction creates are that user's (no
      // in-container chown is possible under --cap-drop ALL, so none is
      // attempted). `--` ends option parsing: a workspace-relative path
      // may legally begin with `-` (e.g. `-weird.txt`), and without `--`
      // tar would read it as an option (--add-file=..., -f ...),
      // disclosing or overwriting host files.
      const archived = await this.fencedDocker(
        fence,
        ["-cf", archive, "-C", scratch, "--", relativePath],
        this.opTimeout(30_000),
        20_000,
        "tar",
      );
      if (archived.code !== 0) {
        throw new Error("Could not stage workspace file");
      }
      const extracted = await this.fencedDocker(
        fence,
        [
          "exec",
          "-i",
          "--user",
          this.user,
          "--workdir",
          "/workspace",
          // Bound to the immutable container ID the gate verified, so the
          // extraction can never land in a replacement container that
          // re-used the task name.
          container.id,
          "tar",
          "-xf",
          "-",
          "-C",
          "/workspace",
        ],
        this.opTimeout(30_000),
        this.outputLimitBytes,
        "docker",
        archive,
      );
      if (extracted.code !== 0) {
        throw new Error("Could not write workspace file");
      }
    } finally {
      await rm(archive, { force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async deleteFile(
    workspace: WorkspaceHandle,
    relativePath: string,
  ): Promise<void> {
    this.safeContainerPath(relativePath);
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.deleteFileCore(workspace, relativePath, fence),
    );
  }

  private async deleteFileCore(
    workspace: WorkspaceHandle,
    relativePath: string,
    fence: HeldFence,
  ): Promise<void> {
    const container = await this.gateHandleOperation(workspace, fence);
    const absolute = this.safeContainerPath(relativePath);
    const target = await this.verifyPathComponents(container, absolute, fence);
    if (target === null) throw new Error("Could not delete workspace file");
    const result = await this.execIn(
      container.id,
      ["rm", "--", absolute],
      this.opTimeout(15_000),
      20_000,
      fence,
    );
    if (result.code !== 0) throw new Error("Could not delete workspace file");
  }

  async listChangedFiles(workspace: WorkspaceHandle): Promise<ChangedFile[]> {
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.listChangedFilesCore(workspace, fence),
    );
  }

  private async listChangedFilesCore(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<ChangedFile[]> {
    const container = await this.gateHandleOperation(workspace, fence);
    await this.markUntrackedForDiff(container, fence);
    const result = await this.execIn(
      container.id,
      ["git", "diff", "--name-status", "HEAD", "--", "."],
      this.opTimeout(15_000),
      this.outputLimitBytes,
      fence,
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
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.gitDiffCore(workspace, fence),
    );
  }

  private async gitDiffCore(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<string> {
    const container = await this.gateHandleOperation(workspace, fence);
    await this.markUntrackedForDiff(container, fence);
    const result = await this.execIn(
      container.id,
      ["git", "diff", "HEAD", "--no-ext-diff", "--no-color", "--", "."],
      this.opTimeout(15_000),
      this.outputLimitBytes,
      fence,
    );
    if (result.code !== 0 || result.stdoutTruncated) {
      throw new Error("Could not inspect workspace diff");
    }
    return redactSecrets(result.stdout);
  }

  async gitStatus(workspace: WorkspaceHandle): Promise<string> {
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.gitStatusCore(workspace, fence),
    );
  }

  private async gitStatusCore(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<string> {
    const container = await this.gateHandleOperation(workspace, fence);
    const result = await this.execIn(
      container.id,
      ["git", "status", "--short", "--untracked-files=all"],
      this.opTimeout(15_000),
      this.outputLimitBytes,
      fence,
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
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.runValidationCore(workspace, command, fence),
    );
  }

  private async runValidationCore(
    workspace: WorkspaceHandle,
    command: string,
    fence: HeldFence,
  ): Promise<CommandResult> {
    const container = await this.gateHandleOperation(workspace, fence);
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
    let result: DockerRunResult;
    try {
      result = await this.execIn(
        container.id,
        ["timeout", "--signal=KILL", String(timeoutSeconds), ...executable],
        // The CLI kill fires within the fenced command bound; the
        // in-container timeout wrapper fires first (timeoutMs plus a
        // grace, both clamped) so the wrapper's own exit status is
        // normally what reports a timeout.
        Math.min(this.timeoutMs + 15_000, this.maxFencedCommandMs),
        this.outputLimitBytes,
        fence,
      );
    } catch (error) {
      // The exec failed to report. If the container is gone, there is
      // nothing to clean up (keep the documented lifecycle error).
      // Otherwise the host-side docker CLI failed for an unknown reason
      // while the exec may have started — a daemon-side process can
      // survive a client disconnect, so the CLI timeout/kill alone does
      // not prove the command stopped — and the cleanup is attempted;
      // if it cannot complete, the task is quarantined (see below).
      if (!(
        error instanceof Error && error.message === WORKSPACE_UNAVAILABLE
      )) {
        await this.runReaperOrQuarantine(container, started, fence);
      }
      throw error;
    }
    // Validation cleanup (kernel start-time based, see the script): kill
    // everything the validation started — direct children AND background
    // grandchildren — so no process it spawned can survive the validation
    // and later race the workspace paths between a stat and its use.
    // Runs under the per-task queue, so nothing else is in flight.
    //
    // Runs AS THE UNPRIVILEGED USER (the default), not root: the validation
    // tree is the same uid, so SIGKILL needs no CAP_KILL under --cap-drop
    // ALL; root, by contrast, could not signal it at all without that
    // capability. The script is root-owned 0644 on a root-owned 0701
    // tmpfs mount (/reap): this uid can traverse and read it but has no
    // write path to it or the mount, and the mount point cannot be
    // renamed, replaced, or shadowed — so task code (the same uid) cannot
    // tamper with the cleanup.
    //
    // If the cleanup CANNOT complete, the task is quarantined: a survivor
    // would keep racing later path verification, and it predates any
    // future validation boundary, so no later cleanup would ever reach
    // it.
    await this.runReaperOrQuarantine(container, started, fence);
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
        // 124: GNU timeout's own "timed out" status. 137 (128+SIGKILL):
        // the wrapper reporting the killed child's status — the only
        // signal we send is KILL, so this is a timeout as well.
        result.code === 124 || result.code === 137
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
   * Run the post-validation reaper, quarantining the task when the
   * cleanup cannot complete. Quarantine is essential: a surviving
   * validation process (a) would keep racing later path verification and
   * file operations, and (b) predates any future validation boundary, so
   * no later cleanup would ever reach it. A reaper exec that REJECTS
   * (the host-side CLI could not spawn it, or its client was killed and
   * the daemon-side exec may still be running) means the cleanup did not
   * complete and is treated exactly like a non-zero exit.
   */
  /**
   * Run the post-validation reaper, quarantining the task when the
   * cleanup cannot complete (see quarantineTask). The quarantine is bound
   * to the container's epoch/generation/immutable id.
   */
  private async runReaperOrQuarantine(
    container: TaskContainer,
    started: number,
    fence: HeldFence,
  ): Promise<void> {
    const taskId = container.taskId;
    const target = {
      epoch: container.epoch,
      generation: container.generation,
      containerId: container.id,
    };
    let cleaned: DockerRunResult;
    try {
      cleaned = await this.execIn(
        container.id,
        ["node", "/reap/validation-reap.mjs", String(started)],
        this.opTimeout(30_000),
        20_000,
        fence,
      );
    } catch {
      const outcome = await this.quarantineTask(taskId, fence, target);
      throw new Error(
        outcome === "failed"
          ? WORKSPACE_UNDETERMINED
          : "Could not complete validation cleanup",
      );
    }
    if (cleaned.code !== 0) {
      const outcome = await this.quarantineTask(taskId, fence, target);
      throw new Error(
        outcome === "failed"
          ? WORKSPACE_UNDETERMINED
          : "Could not complete validation cleanup",
      );
    }
  }

  /**
   * Quarantine a task after a failed validation cleanup (or a failed create
   * setup): mark it so every later operation rejects with the quarantine
   * error, destroy the container immediately (best-effort, bound to the
   * immutable id), and — when the container cannot be removed — make the
   * quarantine DURABLE through an epoch-aware record (never a rename to a
   * task-derived name; see the class documentation).
   *
   * `target` is the container to mark (its epoch/generation/immutable id).
   * When `target` is absent (an uncertain create whose daemon-side effect is
   * unknown), there is nothing to make durable: any late-surfacing container
   * carries a generation-scoped provisional name and no mapping references
   * it, so it is an unreachable managed orphan by construction.
   *
   * "durable" is returned ONLY when a durable channel provably blocks a
   * reopen: the epoch-aware quarantine record (written and never
   * contradicted), the container removed, or the container confirmed stopped
   * (Running=false is daemon-side and cross-instance).
   */
  private async quarantineTask(
    taskId: string,
    fence?: HeldFence,
    target?: { epoch: number; generation: string; containerId: string },
  ): Promise<"durable" | "failed"> {
    // The in-memory flag is set FIRST, before any Docker call and before
    // touching the coordination directory: it protects THIS instance even
    // when every durable channel below fails.
    this.quarantinedTasks.add(taskId);
    if (!target) {
      // No known container: the only possible daemon-side container is an
      // unreachable orphan. Nothing further needs to be made durable.
      return "durable";
    }
    // Publish the durable, epoch-aware quarantine record FIRST, before any
    // Docker call: it is what blocks open() on a restarted or second
    // instance when the container below cannot be removed.
    const recordDurable = await this.writeQuarantineRecord(
      taskId,
      fence,
      target.epoch,
      target.generation,
      target.containerId,
    );
    // Best-effort removal bound to the immutable container id. A FAILED
    // removal must throw nowhere — the durable-record path below is the
    // fail-closed path, and the caller's original error wins.
    let removed = false;
    try {
      await this.removeContainerById(taskId, target.containerId, fence);
      removed = true;
    } catch {
      removed = false;
    }
    // FENCE-LOSS GATE after the cleanup attempt: if the token is gone we may
    // already have been stale-broken and replaced. Stop here — no record
    // retirement — and surface undetermined.
    if (fence && !(await this.checkFenceLive(fence))) {
      return "failed";
    }
    if (removed) {
      // The container is gone; the record (if published) is retired with it.
      await this.retireQuarantineRecords(
        taskId,
        fence,
        target.epoch,
        target.generation,
        target.containerId,
      );
      this.taskActivity.delete(taskId);
      return "durable";
    }
    if (recordDurable) return "durable";
    // Stop fallback (still bound to the immutable id): a container confirmed
    // stopped is daemon-side, cross-instance "do not use" state.
    const stopped = await this.fencedDocker(
      fence,
      ["stop", target.containerId],
      this.opTimeout(30_000),
      20_000,
    );
    if (
      !stopped.timedOut &&
      (stopped.code === 0 || /no such container/i.test(stopped.stderr))
    ) {
      const state = await this.inspectContainer(target.containerId, fence);
      if (
        state.kind === "missing" ||
        (state.kind === "exists" && !state.running)
      ) {
        return "durable";
      }
    }
    return "failed";
  }
  private assertNotQuarantined(taskId: string): void {
    if (this.quarantinedTasks.has(taskId)) {
      throw new Error(QUARANTINE_ERROR);
    }
  }

  /**
   * Gate for an UNLABELED container (the legacy adoption case): open()
   * claims such containers atomically and records the claim in a lease.
   * Every destructive/handle operation consults the SAME claim before
   * touching it:
   * - fresh foreign lease: a peer adopted and is alive → WORKSPACE_OWNED
   *   (running containers; stopped legacy containers have no live
   *   adopter and may be removed).
   * - corrupt OR unreadable lease: a torn/unreadable claim cannot prove
   *   the previous adopter is dead → fail closed (UNDETERMINED). The
   *   reaper's path routes these to "skip" symmetrically.
   * - absent/stale: the legacy container is genuinely unclaimed.
   * Returns when safe; throws otherwise. Reads happen INSIDE the fence
   * (the caller holds it), so the decision can never interleave with a
   * peer's atomic adoption.
   */
  /**
   * Gate for a LEGACY (canonical-name, unlabeled) container (the migration
   * adoption case): open() claims such containers atomically and records the
   * claim in the LEGACY `<taskId>.lease` file. Destructive operations consult
   * the SAME claim. Reads happen INSIDE the fence; corrupt/unreadable claims
   * fail closed.
   */
  private async assertNoForeignLegacyClaim(
    taskId: string,
    name: string,
  ): Promise<void> {
    void name;
    const lease = await this.readLegacyLease(taskId);
    if (lease.kind === "corrupt" || lease.kind === "unreadable") {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (lease.kind !== "valid") return;
    if (lease.instanceId === this.instanceId) return;
    const fresh = Date.now() - lease.updatedAt <= this.leaseTtlMs;
    if (fresh) {
      throw new Error(WORKSPACE_OWNED);
    }
  }

  /**
   * Ownership gate for operations that RECEIVE a handle (read/write/exec/git/
   * validation). Every such operation RE-VALIDATES the container state under
   * the fence through the shared resolver, bound to the handle's epoch/
   * generation/container-id when the handle carries them (a stale handle from
   * a superseded generation is rejected rather than silently re-bound).
   */
  private async gateHandleOperation(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<TaskContainer> {
    const taskId = workspace.id;
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    this.assertNotQuarantined(taskId);
    // Resolve under the handle's recorded binding (its epoch/generation/
    // immutable id). A handle minted for a superseded generation is
    // rejected here rather than silently re-bound to a replacement.
    const expected = this.handleBindings.get(workspace);
    const resolved = await this.resolveTask(taskId, fence, expected);
    switch (resolved.kind) {
      case "unknown":
        throw new Error(WORKSPACE_UNDETERMINED);
      case "conflict":
        throw new Error(
          resolved.reason === "foreign"
            ? WORKSPACE_OWNED
            : WORKSPACE_UNDETERMINED,
        );
      case "absent":
      case "missing":
        // A mapped-but-gone container is a lifecycle error.
        throw new Error(WORKSPACE_UNAVAILABLE);
      case "legacy": {
        // A handle operation never adopts legacy state (only open() does).
        if (resolved.quarantined) {
          this.quarantinedTasks.add(taskId);
          throw new Error(QUARANTINE_ERROR);
        }
        if (this.classifyContainer(resolved.instanceLabel) === "foreign") {
          throw new Error(WORKSPACE_OWNED);
        }
        // Unlabeled legacy state with no durable adoption claim: the
        // handle's ownership cannot be established, so fail closed.
        throw new Error(WORKSPACE_UNDETERMINED);
      }
      case "bound": {
        if (resolved.instanceId !== this.instanceId) {
          throw new Error(WORKSPACE_OWNED);
        }
        if (!resolved.running) throw new Error(WORKSPACE_UNAVAILABLE);
        const q = await this.readQuarantine(taskId);
        if (q.kind === "unknown") throw new Error(WORKSPACE_UNDETERMINED);
        if (
          this.quarantineBlocksTask(
            {
              epoch: resolved.epoch,
              generation: resolved.generation,
              containerId: resolved.containerId,
            },
            q,
          )
        ) {
          this.quarantinedTasks.add(taskId);
          throw new Error(QUARANTINE_ERROR);
        }
        const leased = await this.writeLease(
          taskId,
          fence,
          resolved.epoch,
          resolved.generation,
          resolved.name,
          resolved.containerId,
        );
        if (!leased) throw new Error(WORKSPACE_UNDETERMINED);
        return {
          taskId,
          epoch: resolved.epoch,
          generation: resolved.generation,
          name: resolved.name,
          id: resolved.containerId,
        };
      }
    }
  }

  /**
   * Destroy the task container; its tmpfs workspace is removed with it. Call
   * when a task reaches a terminal state; the reaper is the backstop for
   * abandoned tasks. Also the explicit teardown that clears a quarantine.
   * destroy never refreshes or rewrites a lease; it retires only the records
   * of the removed generation (and any superseded history), never a newer
   * generation's.
   */
  async destroy(taskId: string): Promise<void> {
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    // recordActivity=false: destruction clears a workspace, so it must never
    // record liveness.
    return this.withOwnerTaskOperation(
      taskId,
      (fence) => this.destroyCore(taskId, fence),
      false,
    );
  }

  private async destroyCore(taskId: string, fence: HeldFence): Promise<void> {
    const resolved = await this.resolveTask(taskId, fence);
    switch (resolved.kind) {
      case "unknown":
        throw new Error(WORKSPACE_UNDETERMINED);
      case "conflict":
        throw new Error(
          resolved.reason === "foreign"
            ? WORKSPACE_OWNED
            : resolved.reason === "labels"
              ? WORKSPACE_UNAVAILABLE
              : WORKSPACE_UNDETERMINED,
        );
      case "absent":
      case "missing": {
        // Nothing live under the task. Retire any stale records and clear
        // bookkeeping; a missing mapped container's records are already dead.
        await this.retireTaskRecords(taskId, fence, undefined);
        this.quarantinedTasks.delete(taskId);
        this.taskActivity.delete(taskId);
        await this.removeLegacyFiles(taskId);
        return;
      }
      case "legacy": {
        if (resolved.quarantined) {
          await this.removeContainerById(taskId, resolved.containerId, fence);
          this.quarantinedTasks.delete(taskId);
          this.taskActivity.delete(taskId);
          await this.removeLegacyFiles(taskId);
          return;
        }
        if (
          this.classifyContainer(resolved.instanceLabel) === "foreign" &&
          resolved.running
        ) {
          throw new Error(WORKSPACE_OWNED);
        }
        if (this.classifyContainer(resolved.instanceLabel) === "unlabeled") {
          await this.assertNoForeignLegacyClaim(taskId, resolved.name);
        }
        await this.removeContainerById(taskId, resolved.containerId, fence);
        const legacyQ = await this.inspectContainer(
          this.legacyQuarantineName(taskId),
          fence,
        );
        if (legacyQ.kind === "exists") {
          await this.removeContainerById(taskId, legacyQ.id, fence);
        }
        this.quarantinedTasks.delete(taskId);
        this.taskActivity.delete(taskId);
        await this.removeLegacyFiles(taskId);
        return;
      }
      case "bound": {
        if (resolved.instanceId !== this.instanceId && resolved.running) {
          throw new Error(WORKSPACE_OWNED);
        }
        await this.removeContainerById(taskId, resolved.containerId, fence);
        await this.assertFenceLive(fence);
        // Ambiguity check: with the fence continuously held no peer could
        // have replaced the generation, so if the same immutable id still
        // resolves the teardown's outcome is ambiguous — fail closed.
        const after = await this.resolveTask(taskId, fence);
        if (
          after.kind === "bound" &&
          after.containerId === resolved.containerId
        ) {
          throw new Error(WORKSPACE_UNDETERMINED);
        }
        await this.retireTaskRecords(taskId, fence, {
          epoch: resolved.epoch,
          generation: resolved.generation,
          containerId: resolved.containerId,
        });
        this.quarantinedTasks.delete(taskId);
        this.taskActivity.delete(taskId);
        return;
      }
    }
  }
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
   * call — that an operation enqueued after it took the lock. That is how
   * the TTL removal decides what to do with a successful `rm`: the
   * container is gone, so the activity record (and any operation that
   * enqueued mid-removal — which now fails cleanly with "Task workspace
   * is unavailable") is dropped.
   */
  /**
   * Run `fn` as the next queued operation for `taskId` in THIS provider
   * (process-local FIFO; cross-instance serialization is the fence taken
   * by withOwnerTaskOperation). Operations record cross-instance liveness
   * via the fence + an explicit lease touch (the public methods record
   * process-local activity on ENQUEUE and refresh it here on COMPLETION;
   * rejected foreign operations never reach a lease write because the
   * ownership gate throws before one). The reaper passes
   * recordActivity=false and refreshes neither activity nor leases for
   * the task it is removing.
   */
  private withTaskLock<T>(
    taskId: string,
    fn: (myTail: Promise<void>) => Promise<T>,
    recordActivity: boolean = true,
  ): Promise<T> {
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
          if (recordActivity && this.taskActivity.has(taskId)) {
            // Refresh activity at COMPLETION as well as at enqueue: the
            // task was in use until the operation FINISHED, and a long
            // operation can outlive its own enqueue timestamp. The TTL
            // reaper waits behind this operation for the per-task lock,
            // so without the completion refresh its in-lock check would
            // still see the stale enqueue timestamp and remove the
            // container the moment the operation completes. The guard
            // means "refresh an EXISTING record, never create one": if
            // the record was dropped while this operation was in flight
            // (the documented rm-race outcome: the container is gone and
            // this operation failed with the lifecycle error), the
            // completion must not resurrect the bookkeeping. Cross-
            // instance liveness is the fence held around the whole body
            // (the reaper cannot run an overlapping destructive call),
            // so no lease is needed here.
            this.taskActivity.set(taskId, Date.now());
          }
        }
      });
  }

  /** The generation-scoped PROVISIONAL container name. */
  private provisionalName(taskId: string, generation: string): string {
    return `${CANONICAL_PREFIX}${taskId}--g-${generation}`;
  }

  /**
   * Mint a handle bound to the caller's epoch/generation/immutable-id. The
   * binding is recorded so a later handle operation can be rejected when a
   * replacement has superseded the generation it was handed out for.
   */
  private bindHandle(
    taskId: string,
    binding: { epoch: number; generation: string; containerId: string },
  ): WorkspaceHandle {
    const handle: WorkspaceHandle = { id: taskId, root: "/workspace" };
    this.handleBindings.set(handle, binding);
    return handle;
  }

  /**
   * The canonical task name — used ONLY by legacy discovery (migration). The
   * provider never calls `docker create` with this name.
   */
  private canonicalName(taskId: string): string {
    return `${CANONICAL_PREFIX}${taskId}`;
  }

  /** The LEGACY quarantine name (old protocol rename target, migration). */
  private legacyQuarantineName(taskId: string): string {
    return `${this.canonicalName(taskId)}${QUARANTINED_SUFFIX}`;
  }

  /**
   * Inspect a container by reference (an immutable ID, or — for legacy
   * discovery only — a name) in ONE call, reading its Running state, the
   * five ownership labels (task, instance, generation, epoch), and its
   * current name. The NAME alone is never trusted for ownership. A missing
   * label renders as `<no value>` (NO_LABEL).
   *
   * The result is a DISCRIMINATED union: "missing" (the daemon
   * authoritatively reports no such object), "exists" (all fields valid), or
   * "unknown" (a timeout/transport/permission/spawn/parse failure — the
   * caller MUST fail closed and never run an `rm`).
   */
  private async inspectContainer(
    ref: string,
    fence?: HeldFence,
  ): Promise<
    | { kind: "missing" }
    | { kind: "unknown" }
    | {
        kind: "exists";
        id: string;
        running: boolean;
        taskLabel: string;
        instanceLabel: string;
        generationLabel: string;
        epochLabel: string;
        name: string;
      }
  > {
    let result: DockerRunResult;
    try {
      result = await this.fencedDocker(
        fence,
        [
          "inspect",
          "--format",
          '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}|{{index .Config.Labels "valmont.generation"}}|{{index .Config.Labels "valmont.epoch"}}|{{.Name}}',
          ref,
        ],
        this.opTimeout(15_000),
        // The combined probe is protocol metadata (id + five labels + the
        // name), not user file content: it is capped at a FIXED generous
        // bound, never at the user-configured outputLimitBytes (which may
        // be smaller than a single UUID-prefixed row and would truncate
        // the pipe-delimited line into an "unknown" result).
        20_000,
      );
    } catch {
      return { kind: "unknown" };
    }
    if (result.timedOut) return { kind: "unknown" };
    if (result.code !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) {
        return { kind: "missing" };
      }
      return { kind: "unknown" };
    }
    const parts = result.stdout.trim().split("|");
    if (
      parts.length !== 7 ||
      (parts[1] !== "true" && parts[1] !== "false") ||
      !parts[0]
    ) {
      return { kind: "unknown" };
    }
    return {
      kind: "exists",
      id: parts[0],
      running: parts[1] === "true",
      taskLabel: parts[2] ?? "",
      instanceLabel: parts[3] ?? "",
      generationLabel: parts[4] ?? "",
      epochLabel: parts[5] ?? "",
      name: (parts[6] ?? "").replace(/^\//, ""),
    };
  }
  private classifyContainer(
    instanceLabel: string,
  ): "mine" | "unlabeled" | "foreign" {
    if (instanceLabel === "" || instanceLabel === NO_LABEL) return "unlabeled";
    if (instanceLabel === this.instanceId) return "mine";
    return "foreign";
  }

  private epochDirPath(taskId: string): string {
    return path.join(this.leaseDir, EPOCHS_DIR, taskId);
  }

  private mappingDirPath(taskId: string): string {
    return path.join(this.leaseDir, MAPPINGS_DIR, taskId);
  }

  private leasesDirPath(taskId: string): string {
    return path.join(this.leaseDir, LEASES_DIR, taskId);
  }

  private quarantineDirPath(taskId: string): string {
    return path.join(this.leaseDir, QUARANTINES_DIR, taskId);
  }

  /** Path of the cross-instance per-task fence lock directory. */
  private fencePath(taskId: string): string {
    return path.join(this.leaseDir, ".locks", `${taskId}.lock`);
  }

  /**
   * Scan a record directory. Entry classification:
   * - `<uuid>.json` (a published record) and
   *   `<uuid>.json.captured.<uuid>.tmp` (a RETAINED capture from an
   *   interrupted retirement — a first-class recovery record) must parse as
   *   a valid record for the task; anything else fails closed.
   * - `<uuid>.json.tmp` (a crashed PUBLICATION temp) and any unrecognized
   *   entry are UNKNOWN RECOVERY ARTIFACTS and fail closed.
   */
  private async scanRecords<T>(
    dir: string,
    parse: (entryName: string, raw: string) => T | null,
  ): Promise<T[]> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    const records: T[] = [];
    for (const entry of entries) {
      const isCapture = /\.captured\.[^.]+\.tmp$/.test(entry);
      const isTmp = entry.endsWith(".tmp");
      const isJson = entry.endsWith(".json");
      if (!isJson && !isCapture) throw new Error(WORKSPACE_UNDETERMINED);
      if (isTmp && !isCapture) throw new Error(WORKSPACE_UNDETERMINED);
      let raw: string;
      try {
        raw = await this.fs.readFile(path.join(dir, entry), "utf8");
      } catch {
        throw new Error(WORKSPACE_UNDETERMINED);
      }
      const parsed = parse(entry, raw);
      if (parsed === null) throw new Error(WORKSPACE_UNDETERMINED);
      records.push(parsed);
    }
    return records;
  }

  /**
   * Read the authoritative canonical mapping: the UNIQUE valid record with
   * the highest fencing epoch. Multiple records at the highest epoch,
   * malformed records, unreadable records, and unknown recovery artifacts
   * fail closed.
   */
  private async readAuthoritativeMapping(
    taskId: string,
  ): Promise<
    | { kind: "mapping"; record: MappingRecord }
    | { kind: "absent" }
    | { kind: "unknown" }
  > {
    let records: MappingRecord[];
    try {
      records = await this.scanRecords(
        this.mappingDirPath(taskId),
        (entry, raw) => {
          const m = parseMappingRecord(raw);
          return m !== null && m.taskId === taskId ? m : null;
        },
      );
    } catch {
      return { kind: "unknown" };
    }
    if (records.length === 0) return { kind: "absent" };
    let maxEpoch = 0;
    for (const r of records) if (r.epoch > maxEpoch) maxEpoch = r.epoch;
    const top = records.filter((r) => r.epoch === maxEpoch);
    if (top.length !== 1) return { kind: "unknown" };
    return { kind: "mapping", record: top[0]! };
  }

  /**
   * Publish a canonical mapping record. Non-overwriting (unique temp +
   * exclusive link); refuses to publish when a higher-epoch mapping already
   * exists; allowed only under a live fence and only after setup has
   * verified the immutable id and labels. Returns whether THIS record is now
   * authoritative.
   */
  private async publishMapping(
    taskId: string,
    fence: HeldFence | undefined,
    epoch: number,
    generation: string,
    provisionalName: string,
    containerId: string,
    opts: { legacyAdopted?: boolean } = {},
  ): Promise<boolean> {
    if (!this.leaseDir) return false;
    if (!fence || !(await this.checkFenceLive(fence))) return false;
    try {
      const dir = this.mappingDirPath(taskId);
      await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
      // Epoch-aware: a stale writer must never publish over a higher epoch.
      const current = await this.readAuthoritativeMapping(taskId);
      if (current.kind === "unknown") return false;
      if (current.kind === "mapping" && current.record.epoch > epoch) {
        return false;
      }
      const recordId = randomUUID();
      const tmp = path.join(dir, `${recordId}.json.tmp`);
      const final = path.join(dir, `${recordId}.json`);
      const payload = JSON.stringify({
        schemaVersion: 1,
        taskId,
        epoch,
        generation,
        instanceId: this.instanceId,
        provisionalName,
        containerId,
        publishedAt: Date.now(),
        ...(opts.legacyAdopted ? { legacyAdopted: true } : {}),
      });
      await this.fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      try {
        await this.fs.link(tmp, final);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          await this.fs.rm(tmp, { force: true }).catch(() => {});
          return false;
        }
      } finally {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
      }
      const back = await this.readAuthoritativeMapping(taskId);
      return (
        back.kind === "mapping" &&
        back.record.epoch === epoch &&
        back.record.generation === generation &&
        back.record.containerId === containerId
      );
    } catch {
      return false;
    }
  }

  /**
   * Verify a freshly created container's immutable id and the
   * generation/epoch/task/instance labels plus the observed provisional
   * name, before setup continues and again implicitly at publication.
   */
  private async verifyCreatedContainer(
    taskId: string,
    containerId: string,
    fence: HeldFence,
    generation: string,
    epoch: number,
    provisionalName: string,
  ): Promise<void> {
    const inspected = await this.inspectContainer(containerId, fence);
    if (inspected.kind !== "exists") throw new Error(WORKSPACE_UNDETERMINED);
    if (
      (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) ||
      inspected.instanceLabel !== this.instanceId ||
      inspected.generationLabel !== generation ||
      inspected.epochLabel !== String(epoch) ||
      inspected.name !== provisionalName
    ) {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
  }

  /**
   * The shared immutable-id resolver (see the class documentation). Used by
   * open, handle operations, destroy, quarantine, cleanup, and the reaper.
   */
  private async resolveTask(
    taskId: string,
    fence: HeldFence | undefined,
    expected?: { epoch?: number; generation?: string; containerId?: string },
  ): Promise<ResolvedTask> {
    const mapping = await this.readAuthoritativeMapping(taskId);
    if (mapping.kind === "unknown") return { kind: "unknown" };
    if (mapping.kind === "mapping") {
      const m = mapping.record;
      if (expected?.epoch !== undefined && expected.epoch !== m.epoch) {
        return { kind: "conflict", reason: "stale" };
      }
      if (
        expected?.generation !== undefined &&
        expected.generation !== m.generation
      ) {
        return { kind: "conflict", reason: "stale" };
      }
      if (
        expected?.containerId !== undefined &&
        expected.containerId !== m.containerId
      ) {
        return { kind: "conflict", reason: "stale" };
      }
      const inspected = await this.inspectContainer(m.containerId, fence);
      if (inspected.kind === "unknown") return { kind: "unknown" };
      if (inspected.kind === "missing") return { kind: "missing" };
      if (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) {
        return { kind: "conflict", reason: "labels" };
      }
      if (m.legacyAdopted) {
        // Legacy-adopted containers carry no generation/epoch labels (labels
        // are immutable); the instance label is either ours or absent.
        if (
          inspected.instanceLabel !== m.instanceId &&
          inspected.instanceLabel !== NO_LABEL &&
          inspected.instanceLabel !== ""
        ) {
          return { kind: "conflict", reason: "labels" };
        }
      } else {
        if (
          inspected.instanceLabel !== m.instanceId ||
          inspected.generationLabel !== m.generation ||
          inspected.epochLabel !== String(m.epoch)
        ) {
          return { kind: "conflict", reason: "labels" };
        }
      }
      if (inspected.name !== m.provisionalName) {
        return { kind: "conflict", reason: "labels" };
      }
      return {
        kind: "bound",
        taskId,
        epoch: m.epoch,
        generation: m.generation,
        instanceId: m.instanceId,
        name: m.provisionalName,
        containerId: m.containerId,
        running: inspected.running,
        legacyAdopted: m.legacyAdopted === true,
      };
    }
    return this.discoverLegacy(taskId, fence);
  }

  /**
   * MIGRATION PATH (clearly marked): discover old canonical-name protocol
   * state. Fail-closed. A canonical-name container is, BY CONSTRUCTION,
   * legacy state — never silently treated as a new-generation container.
   */
  private async discoverLegacy(
    taskId: string,
    fence?: HeldFence,
  ): Promise<ResolvedTask> {
    const canonical = this.canonicalName(taskId);
    const inspected = await this.inspectContainer(canonical, fence);
    if (inspected.kind === "unknown") return { kind: "unknown" };
    if (inspected.kind === "missing") {
      const q = await this.inspectContainer(
        this.legacyQuarantineName(taskId),
        fence,
      );
      if (q.kind === "unknown") return { kind: "unknown" };
      if (q.kind === "exists") {
        return {
          kind: "legacy",
          taskId,
          name: this.legacyQuarantineName(taskId),
          containerId: q.id,
          running: q.running,
          instanceLabel: q.instanceLabel,
          taskLabel: q.taskLabel,
          quarantined: true,
        };
      }
      return { kind: "absent" };
    }
    if (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) {
      return { kind: "conflict", reason: "labels" };
    }
    return {
      kind: "legacy",
      taskId,
      name: canonical,
      containerId: inspected.id,
      running: inspected.running,
      instanceLabel: inspected.instanceLabel,
      taskLabel: inspected.taskLabel,
      quarantined: false,
    };
  }

  /**
   * MIGRATION PATH (clearly marked): adopt a legacy canonical-name container.
   * The container is renamed (by immutable id) to a generation-scoped
   * provisional name and published as a FRESH epoch/generation mapping
   * (marked `legacyAdopted`) BEFORE any normal operation uses it.
   */
  private async adoptLegacy(
    taskId: string,
    legacy: Extract<ResolvedTask, { kind: "legacy" }>,
    fence: HeldFence,
  ): Promise<Extract<ResolvedTask, { kind: "bound" }>> {
    const generation = randomUUID();
    const provisional = this.provisionalName(taskId, generation);
    const renamed = await this.fencedDocker(
      fence,
      ["rename", legacy.containerId, provisional],
      this.opTimeout(30_000),
      20_000,
    );
    if (
      renamed.timedOut ||
      (renamed.code !== 0 && !/no such container/i.test(renamed.stderr))
    ) {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    // Re-verify by immutable id that the rename landed (observed provisional
    // name) before publishing.
    const inspected = await this.inspectContainer(legacy.containerId, fence);
    if (inspected.kind !== "exists" || inspected.name !== provisional) {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    const published = await this.publishMapping(
      taskId,
      fence,
      fence.epoch,
      generation,
      provisional,
      legacy.containerId,
      { legacyAdopted: true },
    );
    if (!published) throw new Error(WORKSPACE_UNDETERMINED);
    const leased = await this.writeLease(
      taskId,
      fence,
      fence.epoch,
      generation,
      provisional,
      legacy.containerId,
    );
    if (!leased) throw new Error(WORKSPACE_UNDETERMINED);
    await this.removeLegacyFiles(taskId);
    return {
      kind: "bound",
      taskId,
      epoch: fence.epoch,
      generation,
      instanceId: this.instanceId,
      name: provisional,
      containerId: legacy.containerId,
      running: legacy.running,
      legacyAdopted: true,
    };
  }

  /**
   * Read the LEGACY lease file (`<taskId>.lease`, old protocol schema). Used
   * only during legacy discovery/adoption. Absent/corrupt/unreadable are
   * discriminated; a corrupt or unreadable claim fails closed.
   */
  private async readLegacyLease(taskId: string): Promise<
    | { kind: "absent" }
    | { kind: "unreadable" }
    | { kind: "corrupt" }
    | {
        kind: "valid";
        instanceId: string;
        updatedAt: number;
        generation: string;
      }
  > {
    if (!this.leaseDir) return { kind: "absent" };
    const file = path.join(this.leaseDir, `${taskId}.lease`);
    let raw: string;
    try {
      raw = await this.fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { kind: "absent" };
      }
      return { kind: "unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "corrupt" };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { kind: "corrupt" };
    }
    const candidate = parsed as {
      instanceId?: unknown;
      updatedAt?: unknown;
      generation?: unknown;
    };
    if (
      typeof candidate.instanceId !== "string" ||
      candidate.instanceId.trim() === "" ||
      typeof candidate.updatedAt !== "number"
    ) {
      return { kind: "corrupt" };
    }
    const ts = candidate.updatedAt;
    if (
      !Number.isFinite(ts) ||
      ts < 946_684_800_000 ||
      ts > Date.now() + LEASE_FUTURE_SKEW_MS
    ) {
      return { kind: "corrupt" };
    }
    const generation =
      typeof candidate.generation === "string" ? candidate.generation : "";
    return {
      kind: "valid",
      instanceId: candidate.instanceId,
      updatedAt: ts,
      generation,
    };
  }

  /**
   * Read the versioned lease state for a task. Records are scanned as
   * first-class state; the current lease is the freshest record matching the
   * exact epoch/generation/container-id (when `current` is supplied).
   * Malformed/unreadable records and unknown recovery artifacts fail closed
   * (returned as `unreadable`).
   */
  private async readLease(
    taskId: string,
    current?: { epoch: number; generation: string; containerId: string },
  ): Promise<LeaseState> {
    if (!this.leaseDir) return { kind: "absent" };
    let records: LeaseRecord[];
    try {
      records = await this.scanRecords(
        this.leasesDirPath(taskId),
        (entry, raw) => {
          const r = parseLeaseRecord(raw);
          return r !== null && r.taskId === taskId ? r : null;
        },
      );
    } catch {
      return { kind: "unreadable" };
    }
    if (records.length === 0) return { kind: "absent" };
    if (current) {
      const matching = records.filter(
        (r) =>
          r.epoch === current.epoch &&
          r.generation === current.generation &&
          r.containerId === current.containerId,
      );
      if (matching.length === 0) return { kind: "absent" };
      let freshest = matching[0]!;
      for (const r of matching)
        if (r.updatedAt > freshest.updatedAt) freshest = r;
      return {
        kind: "valid",
        instanceId: freshest.instanceId,
        updatedAt: freshest.updatedAt,
        epoch: freshest.epoch,
        generation: freshest.generation,
        containerId: freshest.containerId,
        provisionalName: freshest.provisionalName,
        legacy: false,
      };
    }
    let highest = records[0]!;
    for (const r of records) if (r.epoch > highest.epoch) highest = r;
    return {
      kind: "valid",
      instanceId: highest.instanceId,
      updatedAt: highest.updatedAt,
      epoch: highest.epoch,
      generation: highest.generation,
      containerId: highest.containerId,
      provisionalName: highest.provisionalName,
      legacy: false,
    };
  }

  /**
   * Publish a versioned lease record. The authoritative mapping is resolved
   * first and an EXACT epoch/generation/container-id/provisional-name match
   * is required, so a stale lower-epoch lease can never replace or supersede
   * a higher-epoch lease (records are never overwritten). Returns false when
   * the claim could not be made durable.
   */
  private async writeLease(
    taskId: string,
    fence: HeldFence | undefined,
    epoch: number,
    generation: string,
    provisionalName: string,
    containerId: string,
  ): Promise<boolean> {
    if (!this.leaseDir) return false;
    const releaseAfter = !fence;
    const held: HeldFence | null = fence
      ? fence
      : await this.acquireTaskFence(taskId, "owner");
    try {
      if (!held || !held.active) return false;
      if (!(await this.checkFenceLive(held))) return false;
      // Resolve the authoritative mapping and require an exact match.
      const mapping = await this.readAuthoritativeMapping(taskId);
      if (mapping.kind !== "mapping") return false;
      const m = mapping.record;
      if (
        m.epoch !== epoch ||
        m.generation !== generation ||
        m.containerId !== containerId ||
        m.provisionalName !== provisionalName
      ) {
        return false;
      }
      const dir = this.leasesDirPath(taskId);
      await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const recordId = randomUUID();
      const tmp = path.join(dir, `${recordId}.json.tmp`);
      const final = path.join(dir, `${recordId}.json`);
      const payload = JSON.stringify({
        schemaVersion: 1,
        taskId,
        epoch,
        generation,
        instanceId: this.instanceId,
        provisionalName,
        containerId,
        updatedAt: Date.now(),
      });
      await this.fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      // Re-verify the fence IMMEDIATELY BEFORE publication.
      if (!(await this.checkFenceLive(held))) {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
        return false;
      }
      try {
        await this.fs.link(tmp, final);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          await this.fs.rm(tmp, { force: true }).catch(() => {});
          return false;
        }
      } finally {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
      }
      // Readback with a live fence.
      if (!(await this.checkFenceLive(held))) return false;
      const back = await this.readLease(taskId, {
        epoch,
        generation,
        containerId,
      });
      return (
        back.kind === "valid" &&
        !back.legacy &&
        back.instanceId === this.instanceId &&
        back.epoch === epoch &&
        back.generation === generation &&
        back.containerId === containerId
      );
    } catch {
      return false;
    } finally {
      if (releaseAfter && held) await held.release();
    }
  }

  /**
   * Retire records proven to belong to a superseded generation. Records are
   * immutable and non-overwriting, so the capture-verify step guards the
   * race between the read decision and the unlink; a capture that can no
   * longer be proven eligible is restored exclusively, and a restoration
   * failure (EIO/EPERM/ENOSPC) RETAINS the capture as recoverable, first-
   * class state that readers scan and a superseding cleanup retires.
   */
  private async retireMatchingRecords<
    T extends {
      epoch: number;
      taskId: string;
      generation: string;
      containerId: string;
      instanceId: string;
    },
  >(
    dir: string,
    parse: (raw: string) => T | null,
    taskId: string,
    eligible: (rec: T) => boolean,
  ): Promise<boolean> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      return false;
    }
    let any = false;
    for (const entry of entries) {
      const isCapture = /\.captured\.[^.]+\.tmp$/.test(entry);
      if (isCapture) {
        // A retained capture: retire it directly if its content is
        // superseded (it is already off the canonical path).
        let raw: string;
        try {
          raw = await this.fs.readFile(path.join(dir, entry), "utf8");
        } catch {
          continue;
        }
        const rec = parse(raw);
        if (rec !== null && rec.taskId === taskId && eligible(rec)) {
          await this.fs
            .rm(path.join(dir, entry), { force: true })
            .catch(() => {});
          any = true;
        }
        continue;
      }
      if (!entry.endsWith(".json")) continue;
      const target = path.join(dir, entry);
      let raw: string;
      try {
        raw = await this.fs.readFile(target, "utf8");
      } catch {
        continue;
      }
      const rec = parse(raw);
      if (rec === null || rec.taskId !== taskId) continue;
      if (!eligible(rec)) continue;
      const graveyard = path.join(dir, `${entry}.captured.${randomUUID()}.tmp`);
      try {
        await this.fs.rename(target, graveyard);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        continue;
      }
      let capturedRaw: string;
      try {
        capturedRaw = await this.fs.readFile(graveyard, "utf8");
      } catch {
        capturedRaw = "";
      }
      const captured = parse(capturedRaw);
      const stillEligible =
        captured !== null &&
        captured.taskId === taskId &&
        captured.epoch === rec.epoch &&
        captured.generation === rec.generation &&
        captured.containerId === rec.containerId &&
        captured.instanceId === rec.instanceId &&
        eligible(captured);
      if (stillEligible) {
        await this.fs.rm(graveyard, { force: true }).catch(() => {});
        any = true;
        continue;
      }
      // The captured record no longer qualifies: restore it exclusively.
      let restored = false;
      try {
        await this.fs.link(graveyard, target);
        restored = true;
      } catch (error) {
        restored = (error as NodeJS.ErrnoException)?.code === "EEXIST";
      }
      if (restored) {
        await this.fs.rm(graveyard, { force: true }).catch(() => {});
      }
      // else: the capture is RETAINED (recoverable; readers fail closed on
      // unknown artifacts but scan retained captures as records).
    }
    return any;
  }

  /**
   * Retire all task records proven to belong to a superseded (or destroyed)
   * generation. When `resolved` is undefined, everything for the task is
   * retired (an absent task). Never removes a record with an epoch greater
   * than the resolved generation's.
   */
  private async retireTaskRecords(
    taskId: string,
    fence: HeldFence | undefined,
    resolved?: { epoch: number; generation: string; containerId: string },
  ): Promise<void> {
    if (fence && !(await this.checkFenceLive(fence))) return;
    const upTo = resolved?.epoch;
    await this.retireMatchingRecords(
      this.mappingDirPath(taskId),
      parseMappingRecord,
      taskId,
      (rec) => upTo === undefined || rec.epoch <= upTo,
    );
    await this.retireMatchingRecords(
      this.leasesDirPath(taskId),
      parseLeaseRecord,
      taskId,
      (rec) =>
        upTo === undefined ||
        rec.epoch < upTo ||
        (resolved !== undefined &&
          rec.epoch === upTo &&
          rec.generation === resolved.generation &&
          rec.containerId === resolved.containerId),
    );
    await this.retireMatchingRecords(
      this.quarantineDirPath(taskId),
      parseQuarantineRecord,
      taskId,
      (rec) => upTo === undefined || rec.epoch <= upTo,
    );
  }

  /** Remove the legacy lease + legacy quarantine marker files (migration). */
  private async removeLegacyFiles(taskId: string): Promise<void> {
    if (!this.leaseDir) return;
    await this.fs
      .rm(path.join(this.leaseDir, `${taskId}.lease`), { force: true })
      .catch(() => {});
    await this.fs
      .rm(path.join(this.leaseDir, `${taskId}.quarantined`), { force: true })
      .catch(() => {});
  }

  /**
   * Read the durable quarantine state: versioned quarantine records (highest
   * epoch) plus the legacy `<taskId>.quarantined` marker (migration). Unknown
   * or malformed state fails closed.
   */
  private async readQuarantine(taskId: string): Promise<QuarantineState> {
    if (!this.leaseDir) return { kind: "absent" };
    let records: QuarantineRecord[];
    try {
      records = await this.scanRecords(
        this.quarantineDirPath(taskId),
        (entry, raw) => {
          const q = parseQuarantineRecord(raw);
          return q !== null && q.taskId === taskId ? q : null;
        },
      );
    } catch {
      return { kind: "unknown" };
    }
    if (records.length > 0) {
      let max = records[0]!;
      for (const r of records) if (r.epoch > max.epoch) max = r;
      const top = records.filter((r) => r.epoch === max.epoch);
      if (top.length !== 1) return { kind: "unknown" };
      return {
        kind: "quarantined",
        epoch: max.epoch,
        generation: max.generation,
        containerId: max.containerId,
        legacy: false,
      };
    }
    const markerPath = path.join(this.leaseDir, `${taskId}.quarantined`);
    try {
      await this.fs.readFile(markerPath, "utf8");
      return {
        kind: "quarantined",
        epoch: 0,
        generation: "",
        containerId: "",
        legacy: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return { kind: "unknown" };
      }
    }
    return { kind: "absent" };
  }

  /**
   * Does a quarantine marker block the CURRENT generation? A marker for a
   * strictly LOWER epoch is superseded and never blocks; a marker for the
   * same or a higher epoch (or, with no mapping, any marker) blocks
   * (fail closed). A legacy marker (epoch 0) blocks only when there is no
   * mapping yet (migration).
   */
  private quarantineBlocksTask(
    current:
      { epoch: number; generation: string; containerId: string } | undefined,
    q: QuarantineState,
  ): boolean {
    if (q.kind === "absent") return false;
    if (q.kind === "unknown") return true;
    if (q.legacy) return current === undefined;
    if (current === undefined) return true;
    return q.epoch >= current.epoch;
  }

  /**
   * Publish a non-overwriting, epoch-aware quarantine record. A stale
   * lower-epoch publication is refused when a higher-epoch marker exists.
   */
  private async writeQuarantineRecord(
    taskId: string,
    fence: HeldFence | undefined,
    epoch: number,
    generation: string,
    containerId: string,
  ): Promise<boolean> {
    if (!this.leaseDir || !fence || !(await this.checkFenceLive(fence))) {
      return false;
    }
    try {
      const dir = this.quarantineDirPath(taskId);
      await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const existing = await this.readQuarantine(taskId);
      if (existing.kind === "unknown") return false;
      if (
        existing.kind === "quarantined" &&
        !existing.legacy &&
        existing.epoch > epoch
      ) {
        return false;
      }
      const recordId = randomUUID();
      const tmp = path.join(dir, `${recordId}.json.tmp`);
      const final = path.join(dir, `${recordId}.json`);
      const payload = JSON.stringify({
        schemaVersion: 1,
        taskId,
        epoch,
        generation,
        instanceId: this.instanceId,
        containerId,
        quarantinedAt: Date.now(),
      });
      await this.fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      if (!(await this.checkFenceLive(fence))) {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
        return false;
      }
      try {
        await this.fs.link(tmp, final);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          await this.fs.rm(tmp, { force: true }).catch(() => {});
          return false;
        }
      } finally {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
      }
      if (!(await this.checkFenceLive(fence))) return false;
      const back = await this.readQuarantine(taskId);
      return (
        back.kind === "quarantined" &&
        !back.legacy &&
        back.epoch === epoch &&
        back.generation === generation &&
        back.containerId === containerId
      );
    } catch {
      return false;
    }
  }

  /** Retire quarantine records for a superseded/destroyed generation. */
  private async retireQuarantineRecords(
    taskId: string,
    fence: HeldFence | undefined,
    epoch: number,
    generation: string,
    containerId: string,
  ): Promise<void> {
    if (fence && !(await this.checkFenceLive(fence))) return;
    await this.retireMatchingRecords(
      this.quarantineDirPath(taskId),
      parseQuarantineRecord,
      taskId,
      (rec) =>
        rec.epoch < epoch ||
        (rec.epoch === epoch &&
          rec.generation === generation &&
          rec.containerId === containerId),
    );
  }

  /**
   * Allocate a durable, monotonically increasing fencing epoch. The
   * allocation is a non-overwriting `writeFile(..., { flag: "wx" })` of a
   * `<epoch>` claim file into `<leaseDir>/epochs/<taskId>/`, so concurrent
   * (or crashed) allocators can never reuse an epoch: the next epoch is
   * always `max(existing) + 1`. Malformed, conflicting, or unreadable epoch
   * state throws (fail closed).
   */
  private async allocateEpoch(taskId: string): Promise<number> {
    const dir = this.epochDirPath(taskId);
    await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    let entries: string[];
    try {
      entries = await this.fs.readdir(dir);
    } catch {
      throw new Error("epoch-unreadable");
    }
    let max = 0;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) throw new Error("epoch-malformed");
      const n = Number(entry);
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error("epoch-malformed");
      if (n > max) max = n;
    }
    for (;;) {
      const candidate = max + 1;
      const file = path.join(dir, String(candidate));
      try {
        await this.fs.writeFile(
          file,
          JSON.stringify({ epoch: candidate, allocatedAt: Date.now() }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          max = candidate;
          continue;
        }
        throw new Error("epoch-unavailable");
      }
    }
  }
  /**
   * Acquire the CROSS-INSTANCE per-task fence (an mkdir-based lock directory
   * under `<leaseDir>/.locks`) and, on success, allocate the DURABLE,
   * MONOTONIC fencing epoch bound to this acquisition (see allocateEpoch).
   * The token-based hold/renew/stale-break protocol is unchanged (see the
   * class documentation); the epoch is the ordering key layered on top of it.
   *
   * Returns a HeldFence that is active ONLY when the lock was acquired AND
   * an epoch was durably allocated. Every inactive outcome fails closed for
   * owner operations and skips for the reaper.
   */
  private async acquireTaskFence(
    taskId: string,
    role: "owner" | "reaper",
  ): Promise<HeldFence> {
    const lockDir = this.fencePath(taskId);
    const token = randomUUID();
    const tokenFile = path.join(lockDir, token);
    const waitMs =
      role === "reaper" ? this.fenceReapWaitMs : this.fenceOwnerWaitMs;
    const deadline = Date.now() + waitMs;
    const sleepMs = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    let sawContendedLock = false;
    let degradedRetries = 1;
    for (;;) {
      try {
        await this.fs.mkdir(path.join(this.leaseDir, ".locks"), {
          recursive: true,
          mode: 0o700,
        });
        await this.fs.mkdir(lockDir, { mode: 0o700 });
        await this.fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
        // Durable monotonic epoch, allocated while we hold the lock. A
        // failure here releases the fence and fails closed: the epoch is the
        // ordering key for everything downstream, so it must be durable.
        let epoch: number;
        try {
          epoch = await this.allocateEpoch(taskId);
        } catch {
          await this.fs.rm(tokenFile, { force: true }).catch(() => {});
          await this.fs.rmdir(lockDir).catch(() => {});
          return this.inactiveFence(taskId, lockDir, token, "unknown");
        }
        const heartbeat = setInterval(() => {
          void this.renewFence(fence);
        }, this.fenceHeartbeatMs);
        if (typeof heartbeat.unref === "function") heartbeat.unref();
        const fence: HeldFence = {
          taskId,
          token,
          epoch,
          active: true,
          lockDir,
          tokenFile,
          lost: false,
          heartbeat,
          release: async () => {
            if (fence.heartbeat) clearInterval(fence.heartbeat);
            await this.releaseTaskFence(fence);
          },
        };
        return fence;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST") {
          sawContendedLock = true;
          const broke = await this.breakStaleFence(lockDir);
          if (broke) {
            await sleepMs(30);
            continue;
          }
        } else if (
          code === "EROFS" ||
          code === "ENOSPC" ||
          code === "ENOTDIR"
        ) {
          if (degradedRetries <= 0 || Date.now() >= deadline) {
            return this.inactiveFence(taskId, lockDir, token, "unavailable");
          }
          degradedRetries -= 1;
          await sleepMs(100);
          continue;
        }
        if (Date.now() >= deadline) {
          return this.inactiveFence(
            taskId,
            lockDir,
            token,
            sawContendedLock ? "contention" : "unknown",
          );
        }
        await sleepMs(role === "reaper" ? Math.min(200, waitMs / 4) : 200);
      }
    }
  }

  private inactiveFence(
    taskId: string,
    lockDir: string,
    token: string,
    inactiveReason: "contention" | "unavailable" | "unknown",
  ): HeldFence {
    return {
      taskId,
      token,
      epoch: 0,
      active: false,
      inactiveReason,
      lockDir,
      tokenFile: path.join(lockDir, token),
      lost: false,
      release: async () => {},
    };
  }
  private async renewFence(fence: HeldFence): Promise<void> {
    if (!fence.active || fence.lost) return;
    try {
      const now = new Date();
      await this.fs.utimes(fence.tokenFile, now, now);
    } catch {
      // Token gone (we lost the fence) or the fs unavailable: stop
      // renewing and mark the fence LOST — a failed renewal makes the
      // entire fenced operation unusable.
      fence.lost = true;
      if (fence.heartbeat) clearInterval(fence.heartbeat);
    }
  }

  /**
   * Non-throwing probe: is this fence STILL held (token verifiably
   * present)? Marks the fence lost when it is not, so the loss is
   * sticky for the rest of the operation.
   */
  private async checkFenceLive(fence: HeldFence | undefined): Promise<boolean> {
    if (!fence || !fence.active || fence.lost) return false;
    try {
      await this.fs.lstat(fence.tokenFile);
      return true;
    } catch {
      fence.lost = true;
      return false;
    }
  }

  /**
   * Throwing form of checkFenceLive: the last check before a fenced
   * Docker call. IMPORTANT: this lstat is NOT itself the fencing — it
   * only narrows the window between a completed stale-break and the
   * in-flight call. The actual guarantees come from the token protocol:
   * a completed break removes a token path that NOBODY can re-create,
   * so once broken, every later check fails; and the breaker can never
   * remove a token that a live holder renewed (capture-verify), so a
   * passing check is meaningful for exactly this holder.
   */
  private async assertFenceLive(fence: HeldFence | undefined): Promise<void> {
    if (!fence || !fence.active) {
      // Inactive fences never reach operation bodies anymore; kept as
      // an unreachable-by-construction defensive check.
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (!(await this.checkFenceLive(fence))) {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
  }

  /**
   * Run a Docker command under a fence: the fence token is re-verified
   * immediately before the call, and a holder that lost its fence (a
   * stale-break the heartbeat could not prevent — a process frozen
   * longer than a renewal interval) NEVER issues the call. Every Docker
   * operation inside a fenced section — rm, rename, stop, start,
   * create, exec, inspect, cp — goes through here or through a
   * fencedDocker-backed helper, so ownership loss aborts every
   * operation class, not just the destructive ones.
   */
  private async fencedDocker(
    fence: HeldFence | undefined,
    args: readonly string[],
    timeoutMs: number,
    limitBytes: number,
    command: string = "docker",
    stdinPath?: string,
  ): Promise<DockerRunResult> {
    await this.assertFenceLive(fence);
    return this.docker(args, timeoutMs, limitBytes, command, stdinPath);
  }

  /** Test-only: remove every fence lock under this provider's lease dir. */
  async __testClearFences(): Promise<void> {
    if (!this.leaseDir) return;
    try {
      await this.fs.rm(path.join(this.leaseDir, ".locks"), {
        recursive: true,
        force: true,
      });
    } catch {
      // best effort
    }
  }

  /**
   * True when a lock DIRECTORY's mtime predates the lock TTL, read
   * TWICE with a gap: directory mtimes change on every structural
   * change (mkdir, token create/remove/rename), so a fresh mtime means
   * somebody is actively using the directory RIGHT NOW. Used only for
   * the EMPTY-directory shape (a crashed mid-acquire); a
   * token-bearing directory's staleness is judged by its TOKEN's mtime
   * (the holder renews the token, not the directory).
   */
  private async dirIsStaleTwiceRead(lockDir: string): Promise<boolean> {
    try {
      const first = await this.fs.lstat(lockDir);
      await new Promise((resolve) =>
        setTimeout(resolve, this.fenceStaleRecheckGapMs()),
      );
      const second = await this.fs.lstat(lockDir);
      const newest = Math.max(first.mtimeMs, second.mtimeMs);
      return Date.now() - newest > this.fenceLockTtlMs;
    } catch {
      return false;
    }
  }

  /** Gap for the twice-read staleness checks, scaled down for tiny TTLs. */
  private fenceStaleRecheckGapMs(): number {
    return Math.min(120, Math.max(5, Math.floor(this.fenceLockTtlMs / 10)));
  }

  /**
   * Break a STALE fence. Staleness is a property of the HOLDER's token
   * (a holder renews its token at TTL/3, so a token whose mtime is
   * older than the TTL proves the holder died or froze); the protocol
   * makes taking a live holder's token IMPOSSIBLE and losing one
   * fail-closed:
   *
   * 1. readdir the lock dir. Two shapes are recoverable — an EMPTY
   *    directory (an acquirer interrupted between mkdir and its token
   *    write, or a release interrupted after the token unlink) and a
   *    SINGLE-token directory (the normal dead-holder case). Anything
   *    else (2+ entries) is left alone.
   * 2. Empty dir: break it only when its mtime is stale TWICE-READ —
   *    every structural change (including another breaker's capture
   *    below) bumps the dir mtime, so a fresh mtime means the directory
   *    is in active use and must not be touched. The removal is a
   *    non-recursive rmdir: it fails (ENOTEMPTY) if a token appeared.
   * 3. Single token: pre-check the token's mtime; if it looks stale,
   *    CAPTURE it with an atomic rename to a unique graveyard path
   *    OUTSIDE the lock dir, then VERIFY the captured file: if its
   *    mtime is FRESH, the holder renewed between the pre-check and
   *    the capture — RESTORE the token (rename it back) and decline
   *    the break. Only a captured token that is still stale is
   *    deleted. This is the atomicity the naive "stat then rm" lacks:
   *    the rename captures exactly what is on disk NOW, and its mtime
   *    records every renewal that landed before the capture, so a
   *    renewal cannot slip between the check and the removal.
   * 4. After a successful capture of a truly-stale token, remove the
   *    now-EMPTY lock dir with a non-recursive rmdir: a peer that
   *    re-acquired in the window (mkdir + fresh token) makes the rmdir
   *    fail harmlessly, and the graveyard file is unlinked.
   *
   * Consequences: the old holder's token PATH can never re-exist, so
   * its next renewal fails with ENOENT (fence marked lost, operation
   * fails closed); a replacement holder's token has a different UUID
   * path and is never touched; two racing breakers serialize through
   * the dir-mtime freshness of the empty shape and the ENOTEMPTY
   * rmdir.
   */
  private async breakStaleFence(lockDir: string): Promise<boolean> {
    try {
      const entries = await this.fs.readdir(lockDir);
      if (entries.length === 0) {
        if (!(await this.dirIsStaleTwiceRead(lockDir))) return false;
        await this.fs.rmdir(lockDir, { retryDelay: 0, maxRetries: 0 });
        return true;
      }
      if (entries.length !== 1) return false;
      const tokenPath = path.join(lockDir, entries[0]!);
      // Cheap pre-check: an obviously fresh token is not worth
      // capturing (and capturing it would briefly expose a live holder
      // to a spurious ENOENT renewal — minimized by checking first).
      let before;
      try {
        before = await this.fs.lstat(tokenPath);
      } catch {
        return false; // vanished (holder released): the retry loop re-runs
      }
      if (Date.now() - before.mtimeMs <= this.fenceLockTtlMs) return false;
      // ATOMIC CAPTURE: rename the token out of the lock dir. The
      // graveyard path is a SIBLING of the lock dir (never inside it),
      // so the lock dir is empty the instant the capture lands.
      const graveyard = `${lockDir}.deadtoken.${randomUUID()}`;
      await this.fs.rename(tokenPath, graveyard);
      // VERIFY the captured file: its mtime reflects every renewal
      // that landed before the capture.
      const moved = await this.fs.lstat(graveyard);
      if (Date.now() - moved.mtimeMs <= this.fenceLockTtlMs) {
        // The holder renewed between the pre-check and the capture —
        // it is ALIVE. Restore the token; the lock is not stale.
        try {
          await this.fs.rename(graveyard, tokenPath);
        } catch {
          // The lock dir vanished while we held the token (the holder
          // released): drop the captured file — the holder's next
          // renewal fails closed, which is the safe direction for an
          // operation that was releasing anyway.
          await this.fs.rm(graveyard, {
            force: true,
            retryDelay: 0,
            maxRetries: 0,
          });
        }
        return false;
      }
      // Truly stale holder: remove the (now empty) lock dir. A peer
      // that re-acquired in the window left a fresh token inside, so
      // the non-recursive rmdir fails harmlessly and the break is
      // aborted (the graveyard file is still cleaned up).
      try {
        await this.fs.rmdir(lockDir, { retryDelay: 0, maxRetries: 0 });
      } catch {
        // Leave the peer's directory exactly as it is.
      }
      await this.fs.rm(graveyard, {
        force: true,
        retryDelay: 0,
        maxRetries: 0,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release a held fence: stop the heartbeat, remove OUR token, then
   * remove the lock directory ONLY with a non-recursive rmdir. The
   * rmdir succeeds solely when the directory is empty; if another
   * acquirer recreated/reclaimed it in the window between the token
   * removal and this call, rmdir fails (ENOTEMPTY/EEXIST) and the
   * replacement holder's directory and token are left untouched. The
   * heartbeat cannot interfere: it only ever touched our own token
   * path, and an in-flight renewal that lands after the token removal
   * fails with ENOENT (marking a fence that is being released as lost
   * — harmless, and never touching shared state).
   */
  private async releaseTaskFence(fence: HeldFence): Promise<void> {
    try {
      await this.fs.rm(fence.tokenFile, {
        force: true,
        retryDelay: 0,
        maxRetries: 0,
      });
      await this.fs.rmdir(fence.lockDir, { retryDelay: 0, maxRetries: 0 });
    } catch (error) {
      // ENOTEMPTY/EBUSY/EEXIST: another holder reclaimed the directory
      // between our token unlink and the rmdir — leave it. ENOENT:
      // a stale-breaker already removed the whole lock. Anything else:
      // best-effort; a leftover lock becomes stale after the TTL and is
      // broken by the next acquirer.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        code === "ENOTEMPTY" ||
        code === "EBUSY" ||
        code === "EEXIST" ||
        code === "ENOENT"
      ) {
        return;
      }
    }
  }

  /**
   * Run an OWNER operation: queued process-local FIRST (FIFO), and once
   * at the head of the queue it acquires the cross-instance per-task
   * fence for the body. This order (queue → fence) is deliberate:
   * - it cannot self-deadlock: a same-instance operation enqueued while
   *   a reaper is mid-removal queues BEHIND the reaper's own
   *   queue-entry and is observed by the reaper's in-queue activity
   *   tripwire (the same instance's reaper never reaches fence
   *   acquisition for a task with queued work);
   * - it is deadlock-free cross-instance: every holder blocks on queue
   *   locks before ever taking a fence, so the cross-process
   *   wait-for graph is one-role (owner/reaper waits on peer owner
   *   operations; peer operations wait on each other only via their
   *   own queues) — no process waits on a fence holder that is itself
   *   waiting on THIS process's queue.
   * The owner wait lasts at most one lock-TTL cycle (long enough to
   * break a stale lock). An inactive fence — live-peer contention, an
   * unusable coordination directory, or a local coordination failure —
   * fails the operation CLOSED; the body runs only under a fence this
   * instance verifiably holds, and the body's own Docker calls keep
   * re-asserting the fence token until the last one.
   */
  private async withOwnerTaskOperation<T>(
    taskId: string,
    fn: (fence: HeldFence) => Promise<T>,
    recordActivity: boolean = true,
  ): Promise<T> {
    return this.withTaskLock(
      taskId,
      async () => {
        const fence = await this.acquireTaskFence(taskId, "owner");
        if (!fence.active) {
          // EVERY inactive outcome fails closed — a live peer
          // (contention), a provably fleet-wide unusable coordination
          // directory (unavailable), or a local/transient filesystem
          // failure (unknown: this instance cannot know whether peers
          // can still fence, and proceeding would risk two holders —
          // e.g. two instances concurrently adopting the same
          // unlabeled container). Mutual exclusion is only ever claimed
          // when it was actually established. The reason distinguishes
          // the surfaced error, nothing more.
          throw new Error(
            fence.inactiveReason === "unavailable"
              ? `${WORKSPACE_UNDETERMINED} (coordination directory unavailable)`
              : fence.inactiveReason === "contention"
                ? `${WORKSPACE_UNDETERMINED} (peer holds the task fence)`
                : `${WORKSPACE_UNDETERMINED} (task fence coordination failure)`,
          );
        }
        try {
          return await fn(fence);
        } finally {
          await fence.release();
        }
      },
      recordActivity,
    );
  }

  /**
   * Run the reaper's destructive body: the cross-instance fence is
   * acquired INSIDE the reaper's per-task queue entry (queue → fence,
   * same order as owner operations), so the activity tripwire (an
   * operation enqueued on this instance) fires before any wait. A wait
   * that elapses (a peer operation is in flight) or an unusable
   * coordination directory SKIPS the body — the callback returns false
   * = "container left for a later interval", never a removal. The
   * reaper NEVER proceeds without an active fence, whatever the
   * acquisition failure was.
   */
  private async withReaperTaskOperation(
    taskId: string,
    fn: (fence: HeldFence, myTail: Promise<void>) => Promise<void>,
  ): Promise<boolean> {
    let ran = false;
    await this.withTaskLock(
      taskId,
      async (myTail) => {
        const fence = await this.acquireTaskFence(taskId, "reaper");
        if (!fence.active) {
          return;
        }
        try {
          await fn(fence, myTail);
          ran = true;
        } finally {
          await fence.release();
        }
      },
      false,
    );
    return ran;
  }

  /**
   * Stage the validation reaper script onto the root-owned `/reap` tmpfs.
   * Every step is a fixed-argv docker operation (a daemon-side `docker cp`
   * plus root `stat` execs on fixed paths; no shell anywhere), and the
   * result is verified before the provider continues:
   *
   * 1. `docker cp` of the host temp file (mode 0644, preserved by the
   *    copy) — the script lands root-owned `0644` on the mount: other-READ
   *    so the unprivileged reaper (the same uid as the validation tree)
   *    can read it, but no write path for that uid — no modify, replace,
   *    unlink, or shadowing. The mount itself is fresh (created with the
   *    container) and root-owned `0701`; nothing the source repository
   *    supplied can ever reach it, so there is no task-owned entry to
   *    clear (a root `rm` could not remove a task-owned entry from the
   *    sticky `/workspace` tmpfs without CAP_FOWNER — another reason the
   *    reaper does not live there).
   * 2. `stat` verification — the mount root must be `0 0 701` (root-owned,
   *    traversable but not listable/writable by the task uid) and the
   *    script `0 0 644 regular file`; any other observation fails
   *    creation.
   *
   * All steps are capability-free (the cp is a daemon-side operation; the
   * stats are root DAC reads under --cap-drop ALL). Runs before the git
   * baseline; the reaper path is outside /workspace, so the git baseline
   * never sees it.
   */
  private async installValidationReaper(
    taskId: string,
    ref: string,
    fence: HeldFence,
  ): Promise<void> {
    void taskId;
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const scriptPath = path.join(scratch, "validation-reap.mjs");
    try {
      await writeFile(scriptPath, VALIDATION_REAPER_SCRIPT, {
        encoding: "utf8",
        mode: 0o644,
      });
      // The cp and the verification execs are bound to the IMMUTABLE
      // container ID (`ref`) and re-assert the fence token first.
      const copied = await this.fencedDocker(
        fence,
        ["cp", scriptPath, `${ref}:/reap/validation-reap.mjs`],
        this.opTimeout(30_000),
        this.outputLimitBytes,
      );
      if (copied.code !== 0) {
        throw new Error("Could not stage the validation reaper");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    // Verify the staged result as root (fixed argv): the provider refuses
    // to continue if the reaper mount or script is not exactly what the
    // create-time flags and the copy above produce.
    const checkedDir = await this.execIn(
      ref,
      ["stat", "-c", "%u %g %a", "/reap"],
      this.opTimeout(15_000),
      20_000,
      fence,
      "root",
    );
    if (checkedDir.code !== 0 || checkedDir.stdout.trim() !== "0 0 701") {
      throw new Error("Could not verify the validation reaper directory");
    }
    const checkedScript = await this.execIn(
      ref,
      ["stat", "-c", "%u %g %a %F", "/reap/validation-reap.mjs"],
      this.opTimeout(15_000),
      20_000,
      fence,
      "root",
    );
    if (
      checkedScript.code !== 0 ||
      checkedScript.stdout.trim() !== "0 0 644 regular file"
    ) {
      throw new Error("Could not verify the validation reaper script");
    }
  }

  private async stageSource(
    taskId: string,
    sourceRoot: string,
    ref: string,
    fence: HeldFence,
  ): Promise<void> {
    void taskId;
    const staging = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-src-"));
    // The archive lives NEXT TO staging, never inside it, so it cannot
    // archive itself.
    const archive = `${staging}.tar`;
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
          // A source-supplied `.valmont` is a reserved provider path and
          // must never enter the container: the reaper no longer lives in
          // the workspace (it is on the /reap mount the source cannot
          // reach), and nothing must ever claim that name under
          // /workspace.
          if (
            relative === ".valmont" ||
            relative.startsWith(".valmont" + path.sep)
          ) {
            return false;
          }
          // Regular files and directories only: no symlinks (the container
          // must not receive task-supplied links for the in-container
          // `tar` to follow), no FIFOs/devices/sockets (tar members with
          // no in-container use).
          const info = await lstat(source);
          return info.isFile() || info.isDirectory();
        },
      });
      // Package-manager scratch ($HOME, TMPDIR) lives on the task tmpfs;
      // the image-layer copies are hidden under the mount, so stage fresh
      // ones as part of the workspace.
      await mkdir(path.join(staging, ".home"), { recursive: true });
      await mkdir(path.join(staging, ".tmp"), { recursive: true });
      // Ownership is fixed by WHO extracts, not by a later chown: archive
      // on the host, then extract in the container AS the unprivileged
      // user — the extracted tree (and every parent the extraction creates)
      // is that user's. No in-container chown is possible under
      // --cap-drop ALL, so none is attempted. `--` ends option parsing,
      // so a member can never be read as a tar option.
      const archived = await this.fencedDocker(
        fence,
        ["-cf", archive, "-C", staging, "--", "."],
        this.opTimeout(300_000),
        20_000,
        "tar",
      );
      if (archived.code !== 0) {
        throw new Error(
          `Could not archive workspace source: ${archived.stderr.trim() || archived.code}`,
        );
      }
      const extracted = await this.fencedDocker(
        fence,
        [
          "exec",
          "-i",
          "--user",
          this.user,
          "--workdir",
          "/workspace",
          ref,
          "tar",
          "-xf",
          "-",
          "-C",
          "/workspace",
        ],
        this.opTimeout(300_000),
        this.outputLimitBytes,
        "docker",
        archive,
      );
      if (extracted.code !== 0) {
        throw new Error(
          `Could not stage workspace source: ${extracted.stderr.trim() || extracted.code}`,
        );
      }
    } finally {
      await rm(archive, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async gitBaseline(
    taskId: string,
    ref: string,
    fence: HeldFence,
  ): Promise<void> {
    void taskId;
    const initialized = await this.execIn(
      ref,
      ["git", "init", "-q"],
      this.opTimeout(15_000),
      20_000,
      fence,
    );
    if (initialized.code !== 0) {
      throw new Error("Could not initialise workspace git");
    }
    // git init ran as the unprivileged user, so .git is already that
    // user's; the exclude file is staged with the same capability-free
    // mechanism as file writes — a host-built archive extracted as the
    // unprivileged user (no docker cp, no in-container chown).
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const archive = `${scratch}.tar`;
    try {
      const excludeDir = path.join(scratch, ".git", "info");
      await mkdir(excludeDir, { recursive: true });
      await writeFile(
        path.join(excludeDir, "exclude"),
        GIT_EXCLUDES.join("\n"),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      const archived = await this.fencedDocker(
        fence,
        ["-cf", archive, "-C", scratch, "--", ".git/info/exclude"],
        this.opTimeout(30_000),
        20_000,
        "tar",
      );
      if (archived.code !== 0) {
        throw new Error("Could not configure workspace git exclusions");
      }
      const extracted = await this.fencedDocker(
        fence,
        [
          "exec",
          "-i",
          "--user",
          this.user,
          "--workdir",
          "/workspace",
          ref,
          "tar",
          "-xf",
          "-",
          "-C",
          "/workspace",
        ],
        this.opTimeout(30_000),
        this.outputLimitBytes,
        "docker",
        archive,
      );
      if (extracted.code !== 0) {
        throw new Error("Could not configure workspace git exclusions");
      }
    } finally {
      await rm(archive, { force: true });
      await rm(scratch, { recursive: true, force: true });
    }
    const staged = await this.execIn(
      ref,
      ["git", "add", "-A"],
      this.opTimeout(15_000),
      20_000,
      fence,
    );
    if (staged.code !== 0)
      throw new Error("Could not stage workspace baseline");
    const committed = await this.execIn(
      ref,
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
      this.opTimeout(15_000),
      20_000,
      fence,
    );
    if (committed.code !== 0) {
      throw new Error("Could not commit workspace baseline");
    }
  }

  private async markUntrackedForDiff(
    container: TaskContainer,
    fence: HeldFence,
  ): Promise<void> {
    const result = await this.execIn(
      container.id,
      ["git", "add", "--intent-to-add", "--", "."],
      this.opTimeout(15_000),
      20_000,
      fence,
    );
    if (result.code !== 0) throw new Error("Could not prepare workspace diff");
  }

  /**
   * The type of a single in-container path component, as seen by the TASK
   * USER (the uid that will actually `cat`/`rm`/extract it — a root
   * stat would wrongly report EACCES on the task's own mode-0700
   * directories, which root without CAP_DAC_OVERRIDE cannot enter, while
   * the task user can). GNU `stat` without `-L` reports the component
   * itself, so a task-created symlink comes back as `symbolic link`
   * rather than its target's type.
   * Returns `null` ONLY when the component is genuinely missing: stat's
   * errno is classified from the text AFTER the final `': '` separator in
   * its error message (coreutils prints the operand — which is
   * untrusted and may itself contain "No such file or directory" — before
   * that separator, and the separator it appends is the last one), and
   * must exactly equal "No such file or directory". Any other failure —
   * permission (e.g. a task-created mode-000 directory), I/O, an
   * unparseable message — THROWS: a path that could not be verified must
   * never be treated as "missing" and used anyway.
   */
  private async statComponentKind(
    container: TaskContainer,
    componentPath: string,
    fence: HeldFence,
  ): Promise<string | null> {
    const checked = await this.execIn(
      container.id,
      ["stat", "-c", "%F", componentPath],
      this.opTimeout(15_000),
      20_000,
      fence,
    );
    if (checked.code !== 0) {
      const separator = checked.stderr.lastIndexOf("': ");
      const errnoText =
        separator === -1 ? null : checked.stderr.slice(separator + 3).trim();
      if (errnoText !== "No such file or directory") {
        throw new Error("Workspace path verification failed");
      }
      return null;
    }
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
    container: TaskContainer,
    absolute: string,
    fence: HeldFence,
  ): Promise<string | null> {
    const components = absolute.split("/").filter(Boolean);
    let targetKind: string | null = null;
    for (let i = 0; i < components.length; i += 1) {
      const component = `/${components.slice(0, i + 1).join("/")}`;
      const kind = await this.statComponentKind(container, component, fence);
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
   * Verify every EXISTING write destination ancestor (fixed-argv root
   * `stat`, no shell): a task-created symlink or a non-directory ancestor
   * is rejected before the `tar` extraction can follow or use it. Missing
   * ancestors are NOT created here — the in-container `tar` extraction
   * creates them itself, as the unprivileged user, and its archive
   * contains only the verified relative path (no symlinks, no host paths)
   * — so setup can neither follow a symlink nor escape /workspace. The
   * final target is checked last: an existing symlink would be followed by
   * the extraction (overwriting whatever it points to), so it is rejected
   * before the write.
   */
  private async prepareWriteParents(
    container: TaskContainer,
    absolute: string,
    fence: HeldFence,
  ): Promise<void> {
    const components = absolute.split("/").filter(Boolean);
    const directoryComponents = components.slice(0, -1);
    for (let i = 0; i < directoryComponents.length; i += 1) {
      const ancestor = `/${directoryComponents.slice(0, i + 1).join("/")}`;
      const kind = await this.statComponentKind(container, ancestor, fence);
      if (kind === "symbolic link") {
        throw new Error("Symlink path components are blocked");
      }
      if (kind === null) {
        // Missing: nothing below it can exist; the tar extraction creates
        // it (and the rest) as the unprivileged user.
        return;
      }
      if (kind !== "directory") {
        throw new Error("Invalid workspace path");
      }
    }
    // All existing ancestors are verified real directories; reject an
    // existing symlink (or directory) final target before the extraction
    // overwrites or follows it.
    const targetKind = await this.statComponentKind(container, absolute, fence);
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
    // No `..` components. The RAW relative path is also used host-side to
    // stage files (writeFile), and a `..` there escapes the operation
    // scratch directory even though the CONTAINER path resolves inside
    // /workspace (e.g. `../workspace/x` canonicalizes to
    // `/workspace/x` yet stages at `<tmp-parent>/workspace/x`). Rejecting
    // them keeps host staging, the tar member, and the container path in
    // lockstep for every operation.
    if (relativePath.split("/").includes("..")) {
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
    ref: string,
    argv: readonly string[],
    timeoutMs: number,
    limitBytes: number,
    fence?: HeldFence,
    user: string = this.user,
  ): Promise<DockerRunResult> {
    // `ref` is the IMMUTABLE container ID a gate or create step verified
    // (never the reusable task name): an old operation cannot exec into a
    // replacement container that re-used the name. Every exec re-asserts
    // the fence token first — after fence loss no exec, read, write, git,
    // or validation command runs at all.
    const result = await this.fencedDocker(
      fence,
      ["exec", "--user", user, "--workdir", "/workspace", ref, ...argv],
      timeoutMs,
      limitBytes,
    );
    // The container is gone (destroyed, or reaped by the TTL while this
    // operation was enqueued): surface the documented lifecycle error
    // instead of a confusing per-operation one. This is the clean failure
    // for the (documented) window in which an operation enqueues while a
    // successful TTL removal is in flight — the container it wanted no
    // longer exists, and the task can be re-created with create().
    if (result.code !== 0 && /no such container/i.test(result.stderr)) {
      throw new Error(WORKSPACE_UNAVAILABLE);
    }
    return result;
  }

  /**
   * Clamp a fixed Docker operation timeout to the validated fenced
   * command budget (half the fence TTL minus host overhead): no fixed
   * 15–60 s Docker timeout can outlive the fence that serializes it.
   */
  private opTimeout(defaultMs: number): number {
    return Math.min(defaultMs, this.maxFencedCommandMs);
  }

  /**
   * Remove ONE of the task's containers (the normal or the quarantine
   * name), checked: a failed rm throws. The removal is ID-BOUND: the
   * container is re-inspected under the fence right before the rm (an
   * unknown inspect fails CLOSED — no rm may follow it), and the rm
   * targets the IMMUTABLE container ID the inspect returned, so this
   * teardown can never remove a replacement container that merely
   * re-uses the task name. A not-found rm is fine (nothing to remove);
   * a container whose task label does not match this task is left for
   * its real owner.
   */
  /**
   * Remove ONE container by its IMMUTABLE id, checked: a failed rm throws
   * and a timed-out/unknown result fails closed (never authorized cleanup).
   */
  private async removeContainerById(
    taskId: string,
    containerId: string,
    fence?: HeldFence,
  ): Promise<void> {
    const inspected = await this.inspectContainer(containerId, fence);
    if (inspected.kind === "missing") return;
    if (inspected.kind === "unknown") {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) {
      throw new Error(WORKSPACE_UNAVAILABLE);
    }
    const removed = await this.fencedDocker(
      fence,
      ["rm", "-f", containerId],
      this.opTimeout(30_000),
      20_000,
    );
    if (
      removed.timedOut ||
      (removed.code !== 0 && !/no such container/i.test(removed.stderr))
    ) {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
  }

  /**
   * Remove any existing generation before a replacement create. Bound to the
   * immutable ids captured by the resolver; never touches a container it did
   * not resolve, and retires the superseded records.
   */
  private async removeExistingForReplacement(
    taskId: string,
    fence: HeldFence,
  ): Promise<void> {
    const resolved = await this.resolveTask(taskId, fence);
    switch (resolved.kind) {
      case "unknown":
        throw new Error(WORKSPACE_UNDETERMINED);
      case "conflict":
        throw new Error(
          resolved.reason === "foreign"
            ? WORKSPACE_OWNED
            : resolved.reason === "labels"
              ? WORKSPACE_UNAVAILABLE
              : WORKSPACE_UNDETERMINED,
        );
      case "absent":
      case "missing": {
        // No live mapping. Still clear any captured quarantine container (a
        // half-initialized create's survivor) so a replacement never orphans
        // it; then retire the stale records when the mapping is provably
        // gone.
        await this.removeCapturedQuarantine(taskId, fence);
        if (resolved.kind === "missing") {
          await this.retireTaskRecords(taskId, fence, undefined);
        }
        return;
      }
      case "legacy": {
        if (resolved.quarantined) {
          await this.removeContainerById(taskId, resolved.containerId, fence);
          await this.removeLegacyFiles(taskId);
          return;
        }
        // A live legacy container owned by another instance is never removed
        // by a replacement create (symmetrically with destroy()).
        if (
          this.classifyContainer(resolved.instanceLabel) === "foreign" &&
          resolved.running
        ) {
          throw new Error(WORKSPACE_OWNED);
        }
        if (this.classifyContainer(resolved.instanceLabel) === "unlabeled") {
          await this.assertNoForeignLegacyClaim(taskId, resolved.name);
        }
        await this.removeContainerById(taskId, resolved.containerId, fence);
        const legacyQ = await this.inspectContainer(
          this.legacyQuarantineName(taskId),
          fence,
        );
        if (legacyQ.kind === "exists") {
          await this.removeContainerById(taskId, legacyQ.id, fence);
        }
        await this.removeLegacyFiles(taskId);
        return;
      }
      case "bound": {
        // A live container owned by another instance is never removed by a
        // replacement create: the replacement is refused with the ownership
        // error (symmetrically with open()/destroy()).
        if (resolved.instanceId !== this.instanceId && resolved.running) {
          throw new Error(WORKSPACE_OWNED);
        }
        await this.removeContainerById(taskId, resolved.containerId, fence);
        await this.retireTaskRecords(taskId, fence, {
          epoch: resolved.epoch,
          generation: resolved.generation,
          containerId: resolved.containerId,
        });
        return;
      }
    }
  }

  /**
   * Remove a container captured by a durable quarantine record when no
   * authoritative mapping references it (a half-initialized create's
   * survivor). The capture names the immutable id, so the removal is bound
   * to exactly the container the failed create left behind. Unknown
   * quarantine state fails closed (a replacement must never proceed over an
   * unreadable capture).
   */
  private async removeCapturedQuarantine(
    taskId: string,
    fence: HeldFence,
  ): Promise<void> {
    const q = await this.readQuarantine(taskId);
    if (q.kind === "unknown") {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (q.kind !== "quarantined" || q.legacy || !q.containerId) return;
    await this.removeContainerById(taskId, q.containerId, fence);
    await this.retireQuarantineRecords(
      taskId,
      fence,
      q.epoch,
      q.generation,
      q.containerId,
    );
  }

  private async reapExpired(): Promise<void> {
    if (this.reaperRunning) return;
    this.reaperRunning = true;
    try {
      // Six columns: the container ID (the rm target), the task label, the
      // instance label, the generation label, the epoch label, and the name.
      const listed = await this.docker(
        [
          "ps",
          "-a",
          "--filter",
          "label=valmont.managed=true",
          "--format",
          '{{.ID}}\t{{.Label "valmont.task"}}\t{{.Label "valmont.instance"}}\t{{.Label "valmont.generation"}}\t{{.Label "valmont.epoch"}}\t{{.Names}}',
        ],
        30_000,
        this.psListLimitBytes,
      );
      if (listed.code !== 0 || listed.timedOut) return;
      if (listed.stdoutTruncated) {
        // A partial listing must NEVER be treated as complete: the truncated
        // suffix holds the OLDEST containers (the reaping candidates).
        return;
      }
      for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        const [id, task, instance, generation, epoch, nameRaw] =
          line.split("\t");
        if (!id || !task) continue;
        const name = (nameRaw ?? id).trim().replace(/^\//, "");
        if (!isValidTaskId(task)) continue;
        // Resolve the authoritative mapping (fail closed on unknown).
        const mapping = await this.readAuthoritativeMapping(task);
        if (mapping.kind === "unknown") continue;
        const legacyRow =
          generation === undefined ||
          generation === "" ||
          generation === NO_LABEL;
        if (mapping.kind === "mapping" && mapping.record.containerId === id) {
          await this.reapCanonical(
            task,
            id,
            name,
            instance,
            generation,
            epoch,
            mapping.record,
          );
        } else if (legacyRow) {
          await this.reapLegacyOrphan(task, id, name, instance);
        } else {
          await this.reapOrphan(
            task,
            id,
            name,
            instance,
            generation,
            epoch,
            mapping.kind === "mapping" ? mapping.record : undefined,
          );
        }
      }
    } finally {
      this.reaperRunning = false;
    }
  }

  /**
   * Reap the CANONICAL generation (the container the authoritative mapping
   * references). Bound to the immutable id after exact label/epoch/generation
   * verification; a lease never overrides a foreign immutable label.
   */
  private async reapCanonical(
    taskId: string,
    id: string,
    name: string,
    instance: string | undefined,
    generation: string | undefined,
    epoch: string | undefined,
    mapping: MappingRecord,
  ): Promise<void> {
    void name;
    void instance;
    void generation;
    void epoch;
    let routing: "mine" | "age" | "skip";
    if (this.classifyContainer(mapping.instanceId) === "mine") {
      routing = "mine";
    } else {
      // A foreign immutable instance label always wins over lease contents.
      const lease = await this.readLease(taskId, {
        epoch: mapping.epoch,
        generation: mapping.generation,
        containerId: mapping.containerId,
      });
      if (lease.kind === "corrupt" || lease.kind === "unreadable") {
        routing = "skip";
      } else if (
        lease.kind === "valid" &&
        Date.now() - lease.updatedAt <= this.leaseTtlMs
      ) {
        routing = "skip";
      } else {
        routing = "age";
      }
    }
    if (routing === "skip") return;
    const created = await this.docker(
      ["inspect", "--format", "{{.Created}}", id],
      15_000,
      20_000,
    );
    if (created.code !== 0 || created.timedOut) return;
    const createdMs = Date.parse(
      created.stdout.trim().replace(/(\.\d{1,3})\d*Z$/, "$1Z"),
    );
    if (!Number.isFinite(createdMs)) return;
    const lastActivity = this.taskActivity.get(taskId);
    let reference: number;
    if (routing === "mine") {
      reference = lastActivity ?? createdMs;
      if (lastActivity === undefined) {
        const ownLease = await this.readLease(taskId, {
          epoch: mapping.epoch,
          generation: mapping.generation,
          containerId: mapping.containerId,
        });
        if (
          ownLease.kind === "valid" &&
          ownLease.instanceId === this.instanceId
        ) {
          reference = Math.max(reference, ownLease.updatedAt);
        }
      }
    } else {
      reference = createdMs;
    }
    if (Date.now() - reference <= this.ttlMs) {
      if (routing === "mine") {
        await this.withReaperTaskOperation(taskId, async (fence) => {
          await this.writeLease(
            taskId,
            fence,
            mapping.epoch,
            mapping.generation,
            mapping.provisionalName,
            mapping.containerId,
          );
        });
      }
      return;
    }
    await this.withReaperTaskOperation(taskId, async (fence, myTail) => {
      const fresh = this.taskActivity.get(taskId);
      if (fresh !== undefined && Date.now() - fresh <= this.ttlMs) return;
      if (routing === "mine") {
        await this.writeLease(
          taskId,
          fence,
          mapping.epoch,
          mapping.generation,
          mapping.provisionalName,
          mapping.containerId,
        );
      }
      // IMMUTABLE-ID re-verification inside the fence, with the row's labels.
      const recheck = await this.inspectContainer(id, fence);
      if (recheck.kind !== "exists") {
        if (recheck.kind === "missing") {
          this.taskActivity.delete(taskId);
          await this.retireTaskRecords(taskId, fence, {
            epoch: mapping.epoch,
            generation: mapping.generation,
            containerId: mapping.containerId,
          });
        }
        return;
      }
      if (recheck.taskLabel !== taskId) return;
      if (mapping.legacyAdopted) {
        if (
          recheck.instanceLabel !== mapping.instanceId &&
          recheck.instanceLabel !== NO_LABEL &&
          recheck.instanceLabel !== ""
        ) {
          return;
        }
      } else {
        if (
          recheck.instanceLabel !== mapping.instanceId ||
          recheck.generationLabel !== mapping.generation ||
          recheck.epochLabel !== String(mapping.epoch)
        ) {
          return;
        }
      }
      if (routing === "age") {
        const leaseNow = await this.readLease(taskId, {
          epoch: mapping.epoch,
          generation: mapping.generation,
          containerId: mapping.containerId,
        });
        const freshNow =
          leaseNow.kind === "valid" &&
          Date.now() - leaseNow.updatedAt <= this.leaseTtlMs;
        if (
          leaseNow.kind === "corrupt" ||
          leaseNow.kind === "unreadable" ||
          freshNow
        ) {
          return;
        }
      }
      if (this.taskLocks.get(taskId) !== myTail) return;
      const removed = await this.fencedDocker(
        fence,
        ["rm", "-f", id],
        this.opTimeout(30_000),
        20_000,
      );
      if (
        !removed.timedOut &&
        (removed.code === 0 || /no such container/i.test(removed.stderr))
      ) {
        this.taskActivity.delete(taskId);
        await this.retireTaskRecords(taskId, fence, {
          epoch: mapping.epoch,
          generation: mapping.generation,
          containerId: mapping.containerId,
        });
      }
    });
  }

  /**
   * Reap a LEGACY canonical-name container (migration): honor the legacy
   * lease file; a fresh claim skips, a stale/absent claim ages out.
   */
  private async reapLegacyOrphan(
    taskId: string,
    id: string,
    name: string,
    instance: string | undefined,
  ): Promise<void> {
    void instance;
    // The legacy `-quarantined` name is unusable by definition: age-reap it.
    if (!name.endsWith(QUARANTINED_SUFFIX)) {
      const lease = await this.readLegacyLease(taskId);
      if (lease.kind === "corrupt" || lease.kind === "unreadable") return;
      if (
        lease.kind === "valid" &&
        Date.now() - lease.updatedAt <= this.leaseTtlMs
      ) {
        return;
      }
    }
    const created = await this.docker(
      ["inspect", "--format", "{{.Created}}", id],
      15_000,
      20_000,
    );
    if (created.code !== 0 || created.timedOut) return;
    const createdMs = Date.parse(
      created.stdout.trim().replace(/(\.\d{1,3})\d*Z$/, "$1Z"),
    );
    if (!Number.isFinite(createdMs)) return;
    if (Date.now() - createdMs <= this.ttlMs) return;
    await this.withReaperTaskOperation(taskId, async (fence, myTail) => {
      const recheck = await this.inspectContainer(id, fence);
      if (recheck.kind !== "exists") return;
      if (recheck.taskLabel !== taskId) return;
      if (this.taskLocks.get(taskId) !== myTail) return;
      const removed = await this.fencedDocker(
        fence,
        ["rm", "-f", id],
        this.opTimeout(30_000),
        20_000,
      );
      if (
        !removed.timedOut &&
        (removed.code === 0 || /no such container/i.test(removed.stderr))
      ) {
        this.taskActivity.delete(taskId);
      }
    });
  }

  /**
   * Reap an ORPHAN: a managed provisional container not referenced by the
   * authoritative mapping. Only after verifying by immutable id that its
   * labels match the listing, no authoritative mapping references it, its age
   * exceeds the TTL, the fence is held, and it is not a newer generation.
   */
  private async reapOrphan(
    taskId: string,
    id: string,
    name: string,
    instance: string | undefined,
    generation: string | undefined,
    epoch: string | undefined,
    mapping: MappingRecord | undefined,
  ): Promise<void> {
    void name;
    // A NEWER generation is never targeted: an orphan whose epoch is at
    // least the authoritative mapping's epoch is not a superseded orphan.
    const orphanEpoch =
      epoch !== undefined && /^\d+$/.test(epoch) ? Number(epoch) : 0;
    if (mapping && orphanEpoch > 0 && orphanEpoch >= mapping.epoch) return;
    const created = await this.docker(
      ["inspect", "--format", "{{.Created}}", id],
      15_000,
      20_000,
    );
    if (created.code !== 0 || created.timedOut) return;
    const createdMs = Date.parse(
      created.stdout.trim().replace(/(\.\d{1,3})\d*Z$/, "$1Z"),
    );
    if (!Number.isFinite(createdMs)) return;
    if (Date.now() - createdMs <= this.ttlMs) return;
    await this.withReaperTaskOperation(taskId, async (fence, myTail) => {
      const recheck = await this.inspectContainer(id, fence);
      if (recheck.kind !== "exists") return;
      if (recheck.taskLabel !== taskId) return;
      if (
        generation !== undefined &&
        generation !== "" &&
        recheck.generationLabel !== generation
      ) {
        return;
      }
      if (epoch !== undefined && epoch !== "" && recheck.epochLabel !== epoch) {
        return;
      }
      if (instance !== undefined && recheck.instanceLabel !== instance) return;
      const now = await this.readAuthoritativeMapping(taskId);
      if (now.kind === "unknown") return;
      if (now.kind === "mapping" && now.record.containerId === id) return;
      if (this.taskLocks.get(taskId) !== myTail) return;
      const removed = await this.fencedDocker(
        fence,
        ["rm", "-f", id],
        this.opTimeout(30_000),
        20_000,
      );
      if (
        !removed.timedOut &&
        (removed.code === 0 || /no such container/i.test(removed.stderr))
      ) {
        this.taskActivity.delete(taskId);
      }
    });
  }
  private docker(
    args: readonly string[],
    timeoutMs: number,
    limitBytes: number,
    command: string = "docker",
    stdinPath?: string,
  ): Promise<DockerRunResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(command, args, {
        stdio:
          stdinPath !== undefined
            ? ["pipe", "pipe", "pipe"]
            : ["ignore", "pipe", "pipe"],
        env: process.env,
        stdinPath,
      });
      if (stdinPath !== undefined) {
        // Stream the host-side archive into the container over the exec's
        // stdin — the only channel: no host path is ever visible inside.
        const ws = child.stdin;
        if (ws) {
          const stream = createReadStream(stdinPath);
          stream.on("data", (chunk) => {
            if (!ws.write(chunk)) stream.pause();
          });
          ws.on("drain", () => stream.resume());
          ws.on("error", () => stream.destroy());
          stream.on("error", () => ws.destroy());
          stream.on("end", () => ws.end());
        }
      }
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
          new Error(`${command} ${args[0] ?? "run"} failed: ${error.message}`),
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
