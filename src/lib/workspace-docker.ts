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
 * ("Critical sandbox boundary") and docs/SECURITY.md:
 *
 * - one short-lived container per task (`valmont-sandbox-<taskId>`), destroyed
 *   with `destroy(taskId)`; a background reaper removes containers older than
 *   the configured TTL. The reaper's `docker ps` listing is never processed
 *   partially — a truncated listing is skipped for the next interval (the
 *   truncated suffix would hold the OLDEST containers, i.e. the reaping
 *   candidates), and a failed in-lock existence inspect drops the activity
 *   record only when the daemon reports "no such object";
 * - the only writable storage is a per-task, size-limited tmpfs at
 *   `/workspace` (kernel-enforced `ENOSPC` cap; destroyed with the container)
 *   plus a tiny root-owned `0701` tmpfs at `/reap` (the reaper script's
 *   mount, see below) — no host filesystem, no application container, no
 *   Docker socket, no cloud credentials, and no persistent named volume to
 *   leak;
 * - read-only root filesystem; package-manager scratch (`$HOME`, `TMPDIR`)
 *   lives on the task tmpfs (staged in by the provider), not on the host;
 * - the container runs as the unprivileged user from the start:
 *   `docker create --user <uid>:<gid>` plus `--init` (the runtime's tiny
 *   init reaps zombie children — `sleep infinity` would not), with
 *   `--cap-drop ALL`, no-new-privileges, and the default seccomp profile.
 *   `uid`/`gid` are the SINGLE source of truth for that identity: the
 *   create-time `--user`, every exec's `--user`, and the tmpfs mount
 *   ownership are all the same numeric pair, so they cannot disagree
 *   (a user NAME is deliberately not accepted — it would resolve against
 *   the image's /etc/passwd and could silently differ from the create
 *   uid, breaking the same-uid reaper and ownership assumptions). The
 *   consequence is enforced by construction: no in-container process —
 *   task code or provider setup exec — holds any capability, so every
 *   in-container operation must be capability-free (DAC/ownership-based).
 *   Ownership is therefore established by WHO extracts, not by a root
 *   `chown` (which `--cap-drop ALL` makes impossible): source and file
 *   content are extracted with `tar` run AS the unprivileged user (the
 *   extracted tree, and any parents it creates, are that user's), and the
 *   reaper script lands root-owned via `docker cp` (a root-privileged
 *   CLI operation on the daemon side, which needs no in-container
 *   capability);
 * - every file operation (read, write, delete) first verifies each path
 *   component with fixed-argv `stat` — a task-created symlink (ancestor or
 *   final target) or a non-directory ancestor is rejected before
 *   `cat`/`rm`/`tar` can follow it; a `stat` failure other than ENOENT
 *   (permission, I/O) fails the operation instead of being treated as
 *   "missing"; missing write parents are created by the `tar` extraction
 *   itself (as the unprivileged user), whose input archive is built
 *   host-side from the filtered staging tree — so setup can never follow a
 *   symlink or escape /workspace. Root setup execs are limited to fixed-argv
 *   `stat` verifications of the `/reap` reaper mount; arbitrary task code
 *   never runs as root;
 * - CPU, memory (with no swap), PID, and per-task storage quotas (the
 *   tmpfs mount is owned by the unprivileged user via its `uid=`/`gid=`
 *   mount options), plus a per-command wall-clock timeout
 *   (`timeout --signal=KILL` inside the container; exit 124 — or 137,
 *   128+SIGKILL, when the wrapper reports the killed child's status — maps
 *   to `timed_out`) with a CLI-level fallback kill. Note: with no swap,
 *   tmpfs residency counts against the memory quota, so size
 *   `VALMONT_SANDBOX_MEMORY_BYTES` and `VALMONT_SANDBOX_STORAGE_BYTES`
 *   together for larger tasks;
 * - every provider operation for a task is serialized by an in-provider
 *   per-task queue, so no two operations — and no stat-then-use sequence
 *   within one of them — can ever overlap on the same container; operations
 *   record activity when they are enqueued AND refresh it when they
 *   COMPLETE, so work that is merely waiting in the queue still counts as
 *   task activity for the TTL reaper, and a long-running operation (one
 *   that outlives its own enqueue timestamp) cannot be reaped the moment
 *   it finishes — the reaper waits behind it for the per-task lock, and by
 *   the time it runs the completion has refreshed the activity;
 * - cross-instance ownership: a per-task lock and an activity timestamp are
 *   PROCESS-LOCAL, so two provider instances sharing one Docker daemon
 *   could otherwise operate on, or TTL-reap, the same task concurrently
 *   (e.g. a second instance starts a legitimate `docker exec` while the
 *   first instance's validation reaper is still SIGKILLing "survivors" of
 *   it, or one instance's reaper removes a task the other is actively
 *   using). The provider therefore assigns every instance an identity
 *   (`instanceId`, default a per-process random UUID; configure it for a
 *   stable identity across restarts) and stamps every container it creates
 *   with the creation-time label `valmont.instance=<id>` (labels are set at
 *   creation and immutable after — a supported mechanism, no rename or
 *   label-update needed). Every open/create/destroy then RESOLVES OWNERSHIP
 *   of the existing container before acting: the instance named by the
 *   label is the owner; an unlabeled container has no live owner (every
 *   live instance stamps the label, so an unlabeled container predates
 *   this mechanism or its creator is gone) and is taken over; a container
 *   labeled with ANOTHER instance is operable only when that instance is
 *   provably dead. Concretely: OPERATIONS (open/create/destroy) are
 *   OWNER-ONLY — a foreign-labeled container is rejected with the
 *   ownership error, full stop (no lease consultation), so two instances
 *   can never operate on the same container concurrently. An unlabeled
 *   container (no live label-owner possible) IS adopted by the first
 *   instance that opens/creates it, claimed via a lease file. REAPING is
 *   SHARED, gated by a host-side LEASE: with `leaseDir` set, each
 *   instance writes a `<taskId>.lease` file (JSON: instanceId,
 *   updatedAt, containerName) on create, on adoption, on every operation
 *   enqueue/completion, and on every reaper sweep of a task it owns; the
 *   reaper refreshes it even for idle owned tasks, so the lease is a
 *   liveness signal for the INSTANCE, not the task. The reaper then:
 *   skips a foreign container whose owner's lease is fresh (the owner's
 *   own reaper handles it — reaping it here would destroy another
 *   instance's live workspace); reaps a foreign container whose lease is
 *   stale or absent by the container's AGE (the owner is provably gone —
 *   it would have refreshed on every operation and every sweep — and no
 *   activity record is shared across instances, so age is the only
 *   signal); and reaps quarantined-name containers by age regardless of
 *   owner (they are unusable by definition). Lease files are ALWAYS
 *   enabled (default `<os tmpdir>/valmont-sandbox-leases`; `leaseDir`
 *   overrides): without them the default config would either let one
 *   instance's reaper remove a task another live instance is using, or
 *   orphan every container after a restart — both are worse than a few
 *   hundred bytes of lease files. Lease READS are strict (a corrupt,
 *   torn, or unreadable lease is "cannot prove death" — never "dead"),
 *   and lease WRITES by a fenced owner must be durable: an owner whose
 *   claim cannot be written or read back while it holds an active fence
 *   fails closed, because a vanished claim routes foreign containers to
 *   age reaping;
 * - every operation that needs cross-instance ownership (which is every
 *   public operation: open/create/destroy and every handle operation)
 *   runs under a per-task FENCE — an mkdir-based lock directory under
 *   `<leaseDir>/.locks`, held for the operation's whole duration, with
 *   a TOKEN-based ownership protocol: the holder renews its own token
 *   file (utimes on a holder-private path) at max(25 ms, TTL/3), and a
 *   stale-break may only capture a token through an atomic
 *   rename-plus-verify that can never take a token a live holder
 *   renewed and can never touch a replacement holder's differently
 *   named token. A holder that loses its token (stale-broken after a
 *   freeze) has its next renewal fail with ENOENT: the fence is marked
 *   lost and EVERY subsequent Docker call of the operation — rm,
 *   rename, stop, start, create, exec, inspect, cp — fails closed with
 *   the undetermined error. An INACTIVE fence never runs the body:
 *   live-peer contention, a provably fleet-wide unusable coordination
 *   directory (EROFS/ENOSPC/ENOTDIR on the lock namespace), and a
 *   LOCAL/TRANSIENT coordination failure (EACCES, EIO, ENOENT, ESTALE,
 *   ...) all fail closed — a local failure must never let one provider
 *   proceed while another can still acquire the fence (two instances
 *   must never concurrently adopt the same unlabeled container).
 *   Destructive and handle operations are bound to the IMMUTABLE
 *   Docker container ID re-inspected under the fence, so an old
 *   operation can never target a replacement container that re-used
 *   the task name; the reaper likewise re-inspects by the ID from its
 *   `docker ps` row and re-verifies the labels in-fence before the rm;
 * - the quarantine marker name space is disjoint from the task name space:
 *   task identifiers ending in `-quarantined` are REJECTED at every public
 *   entry (see isValidTaskId), so a task's quarantine name can never equal
 *   another task's normal container name. In addition, open() verifies the
 *   container's `valmont.task` LABEL matches the requested task before
 *   handing out a handle — the NAME alone is never trusted (a rename that
 *   failed with "name already in use" can leave a foreign container under
 *   a name this instance expects to be its own);
 * - validation cleanup: after every validation run, a fixed exec of the
 *   provider-staged reaper script, AS THE UNPRIVILEGED USER (`node
 *   /reap/validation-reap.mjs <start-time>`), SIGKILLs every process that
 *   started during the validation — the validation tree is the same uid,
 *   so no `CAP_KILL` is needed under `--cap-drop ALL` — so no validation
 *   process or background child can outlive the validation and later race
 *   the workspace paths. The cleanup is fail-closed: the script exits
 *   non-zero if it cannot compute start times, cannot inspect or signal a
 *   bounded process, or its confirmation scan still finds a live one, and
 *   the provider reports the validation as an error in that case. The kill
 *   decision compares against the boundary MINUS a 2 s margin: the host
 *   captures the boundary before the exec starts, `btime` is
 *   second-truncated, and start times are jiffy-quantized, so a
 *   reconstructed start can appear up to ~1 s early — a child spawned
 *   immediately after the boundary can never be missed (see the script
 *   for the over-kill trade-off and the HZ assumption). (PID namespaces
 *   are deliberately not used: seccomp=default allows `unshare` only with
 *   the bare `--user` flag, so no namespace-based teardown is possible
 *   under the default profile.);
 * - a validation whose cleanup FAILS quarantines the task: the container
 *   is destroyed immediately (best-effort). If the removal succeeds the
 *   task's in-memory flag simply goes with it; if it FAILS, the flag
 *   persists AND the surviving container is RENAMED to
 *   `valmont-sandbox-<taskId>-quarantined` — the durable quarantine
 *   marker, held by the Docker daemon (container labels are immutable
 *   after creation, so a rename is the only supported persistent
 *   marker): `open()` probes that name on every task-name miss, so no
 *   provider instance (including one that restarted, or a second one)
 *   can ever hand out the untrusted container. If the RENAME itself fails
 *   for a reason other than "no such container" (the container then keeps
 *   its normal name), the provider does NOT fail open on an in-memory
 *   flag alone — it additionally STOPs the container (a supported,
 *   checked operation): a stopped container reports `Running=false`, so
 *   EVERY instance's open() rejects it without ever trusting process-
 *   local state, and destroy()/the reaper can still `rm -f` it later.
 *   Only if BOTH the rename and the stop fail (a daemon broken enough to
 *   refuse both) does the provider fall back to the flag plus the TTL
 *   reaper as the backstop — documented as the residual of an
 *   unrecoverable daemon. Every later operation
 *   rejects with "Task workspace is quarantined" until an explicit
 *   `destroy()` (or a `create()` replacement) succeeds — both remove the
 *   container under either name. Rationale: a surviving validation
 *   process would keep racing later path verification and file
 *   operations, and it predates any NEXT validation boundary, so no
 *   later cleanup would ever reach it. A failed create() setup that
 *   cannot remove its half-initialized container is quarantined the same
 *   way (the quarantine is cleared only when the replacement setup
 *   completes successfully). `docker create` itself is INSIDE that setup
 *   coverage: a CLI-level failure or timeout on create is an UNCERTAIN
 *   side effect (the daemon may have accepted the container), so the
 *   create call and every subsequent setup step share one try block whose
 *   catch removes the container if it can and QUARANTINES it if it
 *   cannot — a half-initialized container under the normal name must
 *   never be openable, by this instance or any other;
 * - the reaper script lives on a SECOND, root-owned `0701` tmpfs mounted
 *   at `/reap` (a separate mount point on the read-only rootfs), not in
 *   the task-writable workspace: the unprivileged user can traverse
 *   (`x`) and read the `0644` script, but has no write path to the file
 *   or its directory — and because `/reap` is a mount point, task code
 *   cannot rename it away, replace it, or shadow it with its own script
 *   (renaming a mount point fails with EBUSY; unmounting needs
 *   CAP_SYS_ADMIN, which the container does not have). The source
 *   repository cannot place anything there either: staging extracts only
 *   into `/workspace`, and a source-supplied `.valmont` entry is dropped
 *   host-side before staging. The staged script's ownership, mode, and
 *   type are verified with fixed-argv `stat` before the provider
 *   continues;
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
 * The sandbox image (sandbox/Dockerfile) is inert: its command is simply
 * `sleep infinity`, and the container runs as the unprivileged user from
 * create time (`--user uid:gid`, set by the provider and mirrored in
 * compose.sandbox.yaml) — there is no in-container user switch and
 * therefore nothing to escalate or drop. The image only supplies the
 * mount-point directories (`/workspace`, `/reap`) and the toolchain.
 * compose.sandbox.yaml mirrors these flags exactly and is the runtime
 * smoke-test target.
 * Selection in `createWorkspaceProvider()` is deliberately a follow-up
 * commit: enable it only after that smoke test has passed.
 */
export interface DockerWorkspaceOptions {
  image: string;
  /**
   * The uid the unprivileged user runs as — the SINGLE source of truth for
   * the container identity: create-time `--user`, every exec's `--user`,
   * and the tmpfs mount ownership are all this numeric pair, so they
   * cannot disagree. Must be > 0: root task code could rewrite the
   * root-owned reaper script and defeat the validation cleanup, so 0 is
   * rejected. A user NAME is deliberately not accepted: it would resolve
   * against the image's /etc/passwd and could silently differ from the
   * create uid (breaking the same-uid reaper and ownership assumptions).
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
   * This provider instance's identity (default: a random UUID per
   * process). Every container this instance creates is stamped with the
   * creation-time label `valmont.instance=<id>`, and open/create/destroy
   * resolve task ownership by that label plus the host-side leases below
   * (see the class documentation), so two instances sharing one daemon
   * cannot operate on the same task concurrently. Set a STABLE value for
   * a deployment that restarts (the same identity resumes its own tasks;
   * different live instances must use different values).
   */
  instanceId?: string;
  /**
   * Host-side directory holding per-task lease files
   * (`<taskId>.lease`, JSON `{instanceId, updatedAt, containerName}`).
   * A lease is a liveness claim: while another instance's lease for a
   * task is younger than `leaseTtlMs`, this instance's reaper skips the
   * task (the owner's own reaper handles it) and a corrupt lease fails
   * closed to "skip" as well; a stale or absent lease proves the owner
   * is gone, so the task is reaped by the container's age. Operations
   * (open/create/destroy) are owner-only regardless of the lease.
   * Default: `<os tmpdir>/valmont-sandbox-leases` — lease files are
   * ALWAYS enabled (see the constructor: without them the default
   * config is either cross-instance unsafe or leaks containers across
   * restarts). Point several provider processes on one host at a shared
   * directory (the default already is, on a single host). Lease file
   * I/O is best-effort and never fails an operation.
   */
  leaseDir?: string;
  /**
   * How long a lease counts as alive (default 10 minutes; should exceed
   * several reaper intervals). The owner refreshes its lease on create,
   * on takeover, and while it holds the cross-instance task fence for an
   * operation, so a task with any recent work keeps a fresh lease.
   */
  leaseTtlMs?: number;
  /**
   * TTL of the cross-instance per-task fence (an `mkdir`-based lock
   * directory under `<leaseDir>/.locks`, default 20 minutes — well past
   * the longest possible provider operation). Every public operation
   * holds the fence for its whole duration and the reaper only removes
   * a container while holding it, so an ownership decision and the
   * destructive rm it gates can never interleave across instances. A
   * lock whose holder's TOKEN has gone silent for longer than the TTL
   * (a process that died or froze holding it) is broken by the next
   * acquirer; same-host clock skew is nil because the lock is
   * host-local. The TTL is validated against the operation timeouts at
   * construction (see the constructor): every fenced Docker command must
   * fit in half the TTL (host overhead included), and the renewal
   * heartbeat interval must stay below the TTL.
   */
  fenceLockTtlMs?: number;
  /**
   * How long the reaper waits for the task fence before skipping the
   * container for this interval (default 15 seconds). A held fence means
   * an operation is in flight on another instance, so the reaper defers
   * — it never removes without the fence (fail closed).
   */
  fenceReapWaitMs?: number;
  /**
   * How long an owner operation waits for the task fence (default
   * fenceLockTtlMs + 30 s: long enough to break ONE stale lock). Owner
   * operations NEVER proceed without an active fence: a contended fence
   * (live peer) or a coordination failure (local filesystem error,
   * unusable coordination directory) fails closed with the undetermined
   * error — mutual exclusion is only ever claimed when it was actually
   * established.
   */
  fenceOwnerWaitMs?: number;
  /**
   * Output cap (bytes) for the TTL reaper's `docker ps` listing
   * (default 4 MiB — thousands of ~100-byte lines). A listing that
   * exceeds the cap is SKIPPED, never partially processed (see
   * reapExpired), so a small value can disable reaping but can never
   * make it skip the oldest containers.
   */
  psListLimitBytes?: number;
  allowedCommands?: Record<string, readonly [string, ...string[]]>;
  /** Test seam: replace the `docker` CLI invocation. */
  spawnOverride?: DockerSpawn;
  /**
   * TEST SEAM: per-function overrides for the filesystem operations the
   * coordination state (fences, leases, quarantine markers) uses. The
   * stateful fake-Docker test harness wraps these to inject delayed
   * lstat/utimes/rm/rename, token deletion, and replacement acquisition
   * at the exact points where the fencing protocol's race windows live.
   */
  fsOverride?: Partial<FenceFsSeam>;
}

export interface DockerSpawnOptions {
  stdio: ["pipe", "pipe", "pipe"] | ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  /**
   * When set, the file is streamed into the child's stdin (the child's
   * stdin is piped; otherwise it is ignored). The node spawn implementation
   * ignores the extra property.
   */
  stdinPath?: string;
}

export type DockerSpawn = (
  command: string,
  args: readonly string[],
  options: DockerSpawnOptions,
) => ChildProcess;

/**
 * A held cross-instance per-task fence (see acquireTaskFence).
 *
 * `active` is false when the fence is NOT held. Every inactive fence —
 * whatever its reason — fails closed: an owner operation may not run and
 * the reaper may not remove anything unless mutual exclusion was actually
 * established. `inactiveReason` distinguishes (for the surfaced error,
 * not for permission to proceed):
 * - "contention": a peer lock outlived the full wait window — the holder
 *   is alive and fencing;
 * - "unavailable": the coordination directory is unusable in a way that
 *   no process on this host can fence around (EROFS/ENOSPC/ENOTDIR on the
 *   lock namespace itself);
 * - "unknown": a local or transient filesystem failure (EACCES, EIO,
 *   ENOENT, ESTALE, ...) — this instance cannot know whether peers can
 *   still acquire the fence, so it must NEVER proceed as if the failure
 *   were fleet-wide.
 *
 * A held fence's ownership is recorded ONLY by its TOKEN FILE (a UUID
 * path inside the lock directory): the holder renews by `utimes` on that
 * holder-private path and loses the fence the moment that path is gone.
 * See acquireTaskFence for the protocol.
 */
interface HeldFence {
  taskId: string;
  token: string;
  active: boolean;
  inactiveReason?: "contention" | "unavailable" | "unknown";
  /** Directory of the held lock (the token file lives inside it). */
  lockDir: string;
  /** Holder-private path of this fence's ownership token. */
  tokenFile: string;
  /**
   * Set when a failed renewal or a failed live-check proved this holder
   * no longer owns the token. Once lost, a fence is unusable for the rest
   * of the operation: every fenced Docker call re-checks liveness and
   * fails closed (WORKSPACE_UNDETERMINED) after a loss.
   */
  lost: boolean;
  heartbeat?: NodeJS.Timeout;
  release: () => Promise<void>;
}

/**
 * A task's Docker container, BOUND to the immutable container identity a
 * gate or create step verified: `id` is the Docker container ID (stable
 * for the container's whole life, never reused by a replacement), `name`
 * is the task-derived name (reusable by a replacement). Destructive and
 * handle operations issue their Docker calls against `id` so an old
 * operation can never target a replacement container that merely re-used
 * the name.
 */
interface TaskContainer {
  taskId: string;
  name: string;
  id: string;
}

const nodeSpawn: DockerSpawn = (command, args, options) =>
  spawn(command, args, options);

/**
 * The filesystem operations the CROSS-INSTANCE COORDINATION state (fence
 * locks, leases, quarantine markers) runs through. Production always uses
 * the real `node:fs/promises` functions; `fsOverride` is a TEST SEAM that
 * lets the stateful fake-Docker harness inject delayed/observed/replayed
 * filesystem behaviour (delayed lstat/utimes/rm/rename, token deletion,
 * replacement acquisition, ...) exactly at the points where the fencing
 * protocol's race windows live. Host-side staging (source copies, tar
 * archives, scratch files) deliberately does NOT go through this seam —
 * only coordination state does.
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
 * than "no such object" (timeout, transport, permission, exit/parse
 * error), so the provider CANNOT tell whether the container exists. No
 * destructive action (`rm`, replacement) may follow this state — the
 * operation must be retried when the daemon is reachable.
 */
const WORKSPACE_UNDETERMINED = "Task workspace state could not be determined";

/**
 * How far in the FUTURE a lease/marker timestamp may read and still be
 * accepted as sane (host clock skew). A future-dated lease would read as
 * permanently fresh and disable age reaping, so anything beyond this is
 * treated as corrupt (fail closed to "skip"), never as a live claim.
 */
const LEASE_FUTURE_SKEW_MS = 60_000;

/**
 * Host-side overhead (process spawn, kill latency, pipe drain) budgeted
 * on top of every fenced Docker command's own timeout when the
 * configuration is validated: a command that is killed AT its timeout
 * still occupies the fence for a little longer, and the operation bound
 * (at most half the fence TTL per command) must account for it.
 */
const FENCE_HOST_OVERHEAD_MS = 2_000;

/** Smallest allowed budget for a single fenced Docker command. */
const MIN_FENCED_COMMAND_MS = 1_000;

/**
 * Floor for the fence renewal heartbeat interval. The interval is
 * max(this, TTL/3) so tiny TTLs (tests) still renew strictly inside the
 * TTL — the previous 1 s floor silently made a TTL of e.g. 300 ms
 * UNRENEWABLE (the first heartbeat fired after the lock was already
 * stale), which is exactly the misconfiguration the constructor now
 * rejects (the heartbeat interval must stay below the TTL).
 */
const MIN_FENCE_HEARTBEAT_MS = 25;

/**
 * The error for a task whose container exists but is OWNED by another live
 * provider instance (see the instance-ownership section of the class
 * documentation): open/create/destroy by a non-owner are rejected while the
 * owner's lease is fresh, so two instances can never operate on — or reap —
 * the same task concurrently.
 */
const WORKSPACE_OWNED = "Task workspace is owned by another provider instance";

/**
 * What a Go `{{index .Labels "..."}}` template renders for a MISSING label —
 * the fake daemon mirrors it, and the provider treats it (and the empty
 * string) as "no label of that kind".
 */
const NO_LABEL = "<no value>";

/**
 * Quarantined tasks reject every operation until explicit teardown. The
 * container (and everything in it) is untrusted after a failed validation
 * cleanup, so this is stricter than "unavailable": it persists even while
 * a removal of the container is still failing.
 */
const QUARANTINE_ERROR =
  "Task workspace is quarantined (validation cleanup failed); destroy the task";

/**
 * Suffix of the durable quarantine marker: a surviving (unremovable)
 * quarantined container is RENAMED to `<name>-quarantined`. Container
 * labels are immutable after creation in Docker (there is no supported
 * way to add one later — `docker container update` has no `--label`),
 * so a rename is the durable, daemon-side, cross-instance marker: the
 * container is no longer reachable by its task name, and every provider
 * instance probes for the renamed name in open() (see openCore). The
 * creation-time labels survive the rename, so the TTL reaper (any
 * instance) still lists and reaps the container by its managed label.
 */
const QUARANTINED_SUFFIX = "-quarantined";

/**
 * Task identifiers are validated against TASK_ID AND must not end with the
 * quarantine suffix. The reservation is what makes the two container-name
 * spaces DISJOINT: the normal name of task `<id>` is
 * `valmont-sandbox-<id>`, and the durable quarantine name of task `<id>` is
 * `valmont-sandbox-<id>-quarantined` (see QUARANTINED_SUFFIX). Without the
 * reservation, `foo-quarantined` is itself a valid TASK_ID, so task
 * `foo-quarantined`'s NORMAL container name would be byte-identical to
 * task `foo`'s QUARANTINED marker name — `open("foo-quarantined")` could be
 * handed `foo`'s quarantined container, and `cleanupAll("foo")` could
 * remove `foo-quarantined`'s live container. Rejecting any identifier that
 * ends in the suffix guarantees a normal name never ends in it, so no
 * normal name can ever equal a quarantine name (and vice versa). This is
 * enforced at every public entry point, so a quarantined task can never be
 * re-created under the reserved identifier.
 */
function isValidTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId) && !taskId.endsWith(QUARANTINED_SUFFIX);
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
    const name = this.containerName(taskId);
    // The NEW container's lease generation: a unique token stamped into
    // the lease so a teardown of an older container of the same task
    // (same name, possibly same stable instanceId) cannot unlink the
    // replacement's lease. It is generated BEFORE any destructive call
    // (a replacement removes the old container), so the claim for the
    // new generation exists in memory for the whole setup sequence.
    const generation = randomUUID();
    // Set when the `docker create` REQUEST itself failed in a way whose
    // side effect is uncertain (non-zero exit after a daemon-side accept,
    // a CLI timeout, a spawn/transport failure): the daemon may hold —
    // or may yet SURFACE, late — a half-initialized container under the
    // normal name. The quarantine below then RETAINS its durable
    // tombstone instead of retiring it on "missing" probes.
    let createSideEffectUncertain = false;
    // OWNERSHIP GATE BEFORE ANY DESTRUCTIVE CALL (under the cross-
    // instance fence, so no peer can change the result between this
    // probe and the rm below): a container may already exist under the
    // normal name (a previous attempt by this or another instance). The
    // label is verified (the name alone is not proof of which task the
    // container was created for), and a container owned by ANOTHER live
    // instance must never be rm'd here — removing it would destroy that
    // instance's live workspace. A quarantined-name container (any
    // owner) is not gated: it is unusable by definition.
    const existing = await this.inspectContainer(name, fence);
    if (existing.kind === "unknown") {
      // Fail CLOSED: an unknown inspect result must NEVER be followed
      // by an rm (the container may exist as a peer's live workspace).
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (existing.kind === "exists") {
      // A container labeled for a DIFFERENT task is never replaced
      // (the name alone is not proof of which task it was created for).
      if (existing.taskLabel !== NO_LABEL && existing.taskLabel !== taskId) {
        throw new Error(WORKSPACE_UNAVAILABLE);
      }
      // A RUNNING container owned by another live instance is that
      // instance's live workspace — never removed (the fence makes the
      // decision-to-removal window atomic across instances). A STOPPED
      // foreign container (e.g. the quarantine stop-fallback state) has
      // no possible live user — no operation can run in a stopped
      // container — so replacing it is safe.
      if (
        this.classifyContainer(existing.instanceLabel) === "foreign" &&
        existing.running
      ) {
        throw new Error(WORKSPACE_OWNED);
      }
      // UNLABELED RUNNING container: the legacy case, which open()
      // adopts via an ATOMIC in-fence lease claim. That claim is
      // persistent (a lease file), so create/destroy must honor it just
      // as open does: the fence alone only covers concurrently-held
      // operations, not a peer whose adoption completed and released.
      if (this.classifyContainer(existing.instanceLabel) === "unlabeled") {
        await this.assertNoForeignUnlabeledClaim(taskId, name);
      }
    }
    // Note: a previous quarantine is NOT cleared here. Setup (start,
    // source staging, reaper installation, git baseline) must complete
    // first — if it fails and the container cannot be removed, the
    // container is half-initialized and MUST be quarantined, not left
    // reusable for a later open(). The pre-cleanup below is therefore
    // INSIDE the same try as setup: if it fails (rm busy), the catch
    // quarantines the surviving existing container rather than letting
    // the create error out with no marker.
    const createArgs = [
      "create",
      "--name",
      name,
      // The container runs as the unprivileged user from the start (no
      // in-container setpriv/chown bootstrap — none of those would succeed
      // under --cap-drop ALL, which this container keeps by design).
      "--user",
      `${this.uid}:${this.gid}`,
      // tini (injected by the runtime) reaps zombie children of the
      // validation runs; the entrypoint itself (sleep) never waits().
      "--init",
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
      // commands execute repository tooling from /workspace. uid=/gid=
      // make the tmpfs root owned by the unprivileged user, so task code
      // can create top-level entries and the tar extraction (as that user)
      // can write into it without any in-container chown.
      "--tmpfs",
      `/workspace:rw,nosuid,nodev,size=${this.storageLimitBytes},uid=${this.uid},gid=${this.gid}`,
      // Second tmpfs: the reaper script's home. Root-owned 0701 — the
      // unprivileged user can traverse (x) and read the 0644 script, but
      // has no write path; and because it is a MOUNT POINT, task code
      // cannot rename it away, replace it, or plant a fake script at the
      // fixed reaper path (EBUSY on rename; unmount needs CAP_SYS_ADMIN).
      // The source can never place anything here (staging targets only
      // /workspace). size: only the script lives there.
      "--tmpfs",
      "/reap:rw,nosuid,nodev,mode=0701,size=1m",
      // Docker's /dev/shm is itself a writable tmpfs (64 MiB default).
      // Declare it explicitly — bounded, per-container, destroyed with
      // the task — so the writable-storage model is exactly these three
      // tmpfs mounts, and the smoke test can verify the size (df -m
      // /dev/shm → 64).
      "--tmpfs",
      "/dev/shm:rw,nosuid,nodev,mode=777,size=64m",
      "--label",
      "valmont.managed=true",
      "--label",
      `valmont.task=${taskId}`,
      // The instance-ownership stamp (see the cross-instance ownership
      // section of the class documentation): set at creation, immutable
      // after, and read by every instance — including this one after a
      // restart — when resolving who owns the container.
      "--label",
      `valmont.instance=${this.instanceId}`,
      "--restart",
      "no",
      "--stop-timeout",
      "5",
      this.image,
    ];
    try {
      // Pre-cleanup INSIDE the catch coverage: remove any previous
      // container (and a surviving QUARANTINED container renamed by a
      // previous quarantine — a replacement must not orphan it; it
      // holds quota). A failure here goes through the quarantine catch
      // below like every other setup failure. Each removal is bound to
      // the immutable container ID re-inspected under the fence.
      await this.cleanupAll(taskId, fence);
      // `docker create` is INSIDE the setup coverage: a CLI-level failure
      // or timeout here is an UNCERTAIN side effect — the daemon may have
      // accepted the container, which then exists half-initialized under
      // the normal name (and for a TIMED-OUT or transport-failed create
      // request the daemon may even register it LATE, after this call's
      // cleanup probes). The catch below covers exactly that: remove the
      // container if it can be removed, QUARANTINE it if it cannot, and
      // when the create request itself failed uncertainly RETAIN a
      // durable tombstone (see quarantineTask's retainTombstone) so a
      // late-created half-initialized container can never become
      // openable — by this instance or any other.
      const created = await this.fencedDocker(
        fence,
        createArgs,
        this.opTimeout(60_000),
        this.outputLimitBytes,
      );
      if (created.code !== 0 || created.timedOut) {
        createSideEffectUncertain = true;
        throw new Error(
          `Could not create sandbox container: ${created.stderr.trim() || created.code}`,
        );
      }
      // Bind every later setup step to the IMMUTABLE container ID the
      // daemon reported: `docker create` prints the new container's ID,
      // and start/exec/cp against that ID can never hit a replacement
      // container that re-used the task NAME.
      const newId = created.stdout.trim();
      if (!newId) {
        createSideEffectUncertain = true;
        throw new Error(
          "Could not create sandbox container: the daemon reported no container id",
        );
      }
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
      // failure/timeout is an UNCERTAIN side effect (the daemon may hold
      // a half-initialized container under the normal name, or may
      // register one late). Quarantine UNCONDITIONALLY while the fence is
      // still held: quarantineTask removes the container if it can
      // (best-effort) and otherwise makes the quarantine durable (host
      // marker + daemon rename + checked stop fallback), so no instance
      // can open a half-initialized workspace. When the create request
      // failed uncertainly the host marker is RETAINED even when the
      // probes see nothing under either name: Docker's API cannot prove
      // the daemon will not surface the container later, so the
      // quarantine stays durable until an explicit destroy()/create()
      // confirms the cleanup. The original setup error wins; a quarantine
      // that could not be made DURABLE is surfaced as the undetermined
      // error.
      const outcome = await this.quarantineTask(taskId, fence, {
        retainTombstone: createSideEffectUncertain,
      });
      if (outcome === "failed") {
        throw new Error(WORKSPACE_UNDETERMINED);
      }
      throw error;
    }
    // Setup completed fully: a previous quarantine (which trusted
    // nothing about the OLD container) no longer applies — the new
    // container is freshly stamped — and the flag/marker are cleared
    // only now. Claim the task with a fresh, GENERATION-STAMPED lease
    // (the liveness signal peer instances' reapers consult before
    // touching it): it names this instance and the new container, so a
    // racing teardown's generation-aware delete cannot remove it.
    this.quarantinedTasks.delete(taskId);
    await this.deleteQuarantineMarker(taskId, fence);
    const published = await this.writeLease(taskId, name, fence, generation);
    if (!published && fence.active) {
      // The setup fully succeeded, but the new container's liveness
      // claim is not durable on disk while the fence IS usable:
      // another instance's reaper could age-route a live container
      // whose claim vanished. Quarantine the ready container (the
      // task must never be reported openable without a durable claim)
      // and fail closed; the durable-marker write has the same lease
      // dir, so it will likely fail too, but the in-memory flag
      // protects this instance and an explicit retry recovers.
      await this.quarantineTask(taskId, fence);
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (!published) {
      // writeLease without an active fence cannot happen here anymore
      // (owner operations fail closed without one); kept defensively.
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    this.taskActivity.set(taskId, Date.now());
    return { id: taskId, root: "/workspace" };
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
    const name = this.containerName(taskId);
    // A durable quarantine marker written by ANY instance (host-side, in
    // the shared lease directory) blocks open even when the daemon-side
    // rename could not be completed: it survives this instance's own
    // restart and is visible to a second instance.
    const marked = await this.readQuarantineMarker(taskId);
    if (marked === "quarantined" || marked === "unreadable") {
      this.quarantinedTasks.add(taskId);
      throw new Error(QUARANTINE_ERROR);
    }
    const inspected = await this.inspectContainer(name, fence);
    if (inspected.kind === "unknown") {
      // Fail CLOSED: the daemon could not tell us whether a container
      // exists under this name, so handing out a handle (or deciding
      // the workspace is gone) could both be wrong.
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (inspected.kind === "exists") {
      // LABEL VERIFICATION before anything else: a container under this
      // task's name must have been created FOR this task. The name alone
      // is not proof — a rename that failed with "name already in use"
      // can leave a foreign container under a name this instance expects
      // to be its own, and (without the reserved-suffix check) a
      // quarantined container of another task could sit at exactly this
      // name. Handing out either of those would be a cross-task leak.
      // An UNLABELED container (taskLabel = "<no value>") is the legacy
      // case (created before this mechanism): it is provably not any
      // live instance's current task, so it is adopted (see below). A
      // container labeled for a DIFFERENT task is never handed out.
      if (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) {
        throw new Error(WORKSPACE_UNAVAILABLE);
      }
      // OWNERSHIP: a container stamped with ANOTHER instance is that
      // instance's live workspace (its lease may be stale if it is idle
      // — operating on it anyway would let our reaper SIGKILL its
      // processes and race its operations). Only the owning instance
      // operates on its own containers; an unlabeled container has no
      // live label-owner (every live instance stamps the label at
      // creation) and is adopted — the adoption is claimed via the
      // lease, since the label itself cannot be changed.
      if (this.classifyContainer(inspected.instanceLabel) === "foreign") {
        throw new Error(WORKSPACE_OWNED);
      }
      if (this.classifyContainer(inspected.instanceLabel) === "unlabeled") {
        // ATOMIC ADOPTION: the cross-instance fence is already held (see
        // withOwnerTaskOperation), so no peer instance can adopt the
        // same container concurrently. The claim is decided INSIDE the
        // fence by the lease (the only mutable ownership record, since
        // labels are immutable): a FRESH lease naming another instance
        // means a peer already adopted this container — treat it as
        // foreign and reject; absent/stale/corrupt states let THIS
        // instance claim (stale = the earlier adopter is gone and the
        // container is unlabeled again for all practical purposes).
        if (inspected.running) {
          const existing = await this.readLease(taskId, name);
          const fresh =
            existing.kind === "valid" &&
            Date.now() - existing.updatedAt <= this.leaseTtlMs;
          if (fresh && existing.instanceId !== this.instanceId) {
            throw new Error(WORKSPACE_OWNED);
          }
          if (existing.kind === "unreadable" || existing.kind === "corrupt") {
            // A claim we cannot read (permission/IO) or cannot parse
            // (torn/garbage) cannot prove the previous adopter is gone.
            // The reaper routes these to "skip" — adoption must fail
            // closed the same way, never claim over uncertainty.
            throw new Error(WORKSPACE_UNDETERMINED);
          }
          // Claim with THIS instance's lease generation (persisted in
          // the lease so a same-identity restart keeps one generation).
          // Claim with THIS instance's lease generation. A claim naming
          // THIS instance (a same-identity restart resuming its own
          // adoption) keeps its generation — one logical owner, one
          // generation; a claim left by a DIFFERENT (gone) adopter is
          // replaced with a FRESH generation, so the dead adopter's
          // in-flight teardown can never collide with ours by
          // generation, and read-backs unambiguously name the new
          // owner.
          const adoptionGeneration =
            existing.kind === "valid" &&
            existing.generation &&
            existing.instanceId === this.instanceId
              ? existing.generation
              : randomUUID();
          const claimed = await this.writeLease(
            taskId,
            name,
            fence,
            adoptionGeneration,
          );
          if (!claimed) {
            // No active fence (an inactive fence never reaches the body)
            // or no durable claim despite one: the adoption is unprovable
            // cross-instance — a peer's reaper could adopt the same
            // container behind our back. Fail closed.
            throw new Error(WORKSPACE_UNDETERMINED);
          }
        }
        // RE-PROBE under the fence before handing out a handle: the
        // container and its name can only have changed behind another
        // fence holder, which cannot exist here, so this is defense in
        // depth (and it also catches a container stopped between the
        // two awaits).
        const claim = await this.inspectContainer(name, fence);
        if (claim.kind === "unknown") throw new Error(WORKSPACE_UNDETERMINED);
        if (
          claim.kind === "missing" ||
          !claim.running ||
          this.classifyContainer(claim.instanceLabel) === "foreign" ||
          (claim.taskLabel !== NO_LABEL && claim.taskLabel !== taskId)
        ) {
          throw new Error(WORKSPACE_UNAVAILABLE);
        }
        this.taskActivity.set(taskId, Date.now());
        return { id: taskId, root: "/workspace" };
      }
      if (!inspected.running) {
        // A stopped container (e.g. left stopped by a quarantine's
        // rename-failure stop fallback) is unusable — open() reports the
        // plain lifecycle error; destroy() can still remove it. A
        // restarted provider with the SAME instance identity is blocked
        // by this exact check: no same-identity second process may
        // reopen a container that was stopped as the quarantine
        // fallback.
        throw new Error(WORKSPACE_UNAVAILABLE);
      }
      // LABELED MINE, running: the immutable label already proves this
      // container is ours, so the lease is only the LIVENESS claim.
      // Keep it durable AFTER the gate (never before — refreshing a
      // lease before the container ownership gate ran is what let an
      // instance whose container had been replaced poison the
      // replacement owner's liveness state): refresh a claim that names
      // this instance, and RE-ESTABLISH one that is absent, corrupt, or
      // unreadable, so a live owner is never left without a claim a
      // peer's reaper can see (an absent claim routes to age-reaping
      // once the fence is released).
      const lease = await this.readLease(taskId, name);
      if (
        lease.kind === "valid" &&
        lease.instanceId === this.instanceId &&
        lease.generation
      ) {
        const refreshed = await this.writeLease(
          taskId,
          name,
          fence,
          lease.generation,
        );
        if (!refreshed) throw new Error(WORKSPACE_UNDETERMINED);
      } else {
        // Absent/corrupt/unreadable (or a foreign leftover on a container
        // the immutable label proves is ours): (re-)establish the claim
        // with a FRESH generation — a teardown still holding the old
        // generation token must not be able to unlink the new claim.
        const claimed = await this.writeLease(
          taskId,
          name,
          fence,
          randomUUID(),
        );
        if (!claimed) throw new Error(WORKSPACE_UNDETERMINED);
      }
      this.taskActivity.set(taskId, Date.now());
      return { id: taskId, root: "/workspace" };
    }
    // No container under the task name. Before reporting "unavailable",
    // probe the durable quarantine marker: a surviving unremovable
    // container was RENAMED to <name>-quarantined (see
    // quarantineTask) — that state is in the daemon, so this instance
    // sees it even after a restart, and even when it is a SECOND
    // instance with no in-memory state.
    const quarantined = await this.inspectContainer(
      this.quarantinedContainerName(taskId),
      fence,
    );
    if (quarantined.kind === "unknown") throw new Error(WORKSPACE_UNDETERMINED);
    if (quarantined.kind === "exists") {
      this.quarantinedTasks.add(taskId);
      throw new Error(QUARANTINE_ERROR);
    }
    throw new Error(WORKSPACE_UNAVAILABLE);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
    const container = await this.gateHandleOperation(workspace.id, fence);
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
  private async runReaperOrQuarantine(
    container: TaskContainer,
    started: number,
    fence: HeldFence,
  ): Promise<void> {
    const taskId = container.taskId;
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
      const outcome = await this.quarantineTask(taskId, fence);
      throw new Error(
        outcome === "failed"
          ? WORKSPACE_UNDETERMINED
          : "Could not complete validation cleanup",
      );
    }
    if (cleaned.code !== 0) {
      const outcome = await this.quarantineTask(taskId, fence);
      throw new Error(
        outcome === "failed"
          ? WORKSPACE_UNDETERMINED
          : "Could not complete validation cleanup",
      );
    }
  }

  /**
   * Quarantine a task after a failed validation cleanup (or a failed
   * create setup): mark it so every later operation rejects with the
   * quarantine error, destroy the container immediately (best-effort),
   * and — when the container cannot be removed — make the quarantine
   * DURABLE across instances and restarts.
   *
   * FENCE-LOSS CONTRACT (the review-critical part): every Docker call
   * below re-asserts that this holder still owns its fence token
   * (fencedDocker/inspectContainer throw WORKSPACE_UNDETERMINED the
   * moment the token is gone), and the sequence is additionally gated
   * after each phase. Losing the fence STOPS the sequence: no rename, no
   * stop, no marker/lease retirement — the cleanup result is
   * "failed" (undetermined) and the host marker stays, because a
   * replacement holder may already have acquired the task and anything
   * we did by NAME from that point on could hit ITS container.
   *
   * `retainTombstone` (set by createCore when the `docker create`
   * REQUEST itself failed uncertainly — a timed-out or transport-failed
   * create the daemon may still surface LATE): the host marker is NOT
   * retired even when both names probe missing. Docker's API gives no
   * guarantee the daemon will not register the container after our
   * probe, so the durable tombstone stays until an explicit destroy()
   * (or the reaper, once the container actually appears) confirms the
   * cleanup. Returning "durable" is honest in that state: the marker
   * durably blocks every instance's open().
   *
   * "durable" is returned ONLY when some durable channel provably blocks
   * a reopen: the host marker (written and never contradicted), a
   * container renamed to the quarantine name, or a container confirmed
   * stopped (Running=false is daemon-side and cross-instance). A
   * missing-marker plus an unconfirmable container state returns
   * "failed".
   */
  private async quarantineTask(
    taskId: string,
    fence?: HeldFence,
    opts: { retainTombstone?: boolean } = {},
  ): Promise<"durable" | "failed"> {
    // The in-memory flag is set FIRST, before any docker call and
    // before touching the lease directory: it is per-process, requires
    // no I/O, and must protect THIS instance even when every durable
    // channel below fails (unwritable lease dir, failed rename, failed
    // stop). Explicit destroy()/create() are the only operations that
    // clear it.
    this.quarantinedTasks.add(taskId);
    // Publish the HOST-SIDE durable marker FIRST, before any docker
    // call: it is what blocks open() on a restarted or second instance
    // (same identity or different) when the daemon-side markers below
    // cannot be established.
    const markerDurable = await this.writeQuarantineMarker(taskId, fence);
    const normalName = this.containerName(taskId);
    const qName = this.quarantinedContainerName(taskId);
    // Best-effort removal first (the original behavior: the container is
    // destroyed immediately when the daemon cooperates). A FAILED
    // removal must throw nowhere — the durable-marker steps below are
    // the fail-closed path, and the caller's original error wins. Note
    // that cleanupAll throws WORKSPACE_UNDETERMINED when the fence was
    // lost mid-cleanup: that is exactly the gate below.
    const removed = await this.cleanupAll(taskId, fence).then(
      () => true,
      () => false,
    );
    // FENCE-LOSS GATE after the cleanup attempt: if the token is gone we
    // may already have been stale-broken and replaced. Stop here — no
    // rename, no stop, no marker retirement — and surface undetermined.
    if (fence && !(await this.checkFenceLive(fence))) {
      return "failed";
    }
    try {
      if (removed) {
        const normalProbe = await this.inspectContainer(normalName, fence);
        const qProbe = await this.inspectContainer(qName, fence);
        if (normalProbe.kind === "missing" && qProbe.kind === "missing") {
          // Nothing left under either name: retire the host marker
          // (unless a late daemon-side create may still surface — see
          // retainTombstone) and the task bookkeeping. The lease removal
          // is generation-aware (never a replacement owner's fresh
          // lease — and deleteLease re-verifies under the fence).
          if (!opts.retainTombstone) {
            await this.deleteQuarantineMarker(taskId, fence);
          } else if (!markerDurable) {
            // An uncertain create may still become visible daemon-side.
            // Without a persisted tombstone a restart could open it.
            return "failed";
          }
          this.taskActivity.delete(taskId);
          await this.deleteLease(taskId, normalName, fence);
          return "durable";
        }
        if (qProbe.kind === "exists") {
          // A surviving RENAMED container (from a previous quarantine):
          // the daemon-side name carries the quarantine durably.
          await this.deleteQuarantineMarker(taskId, fence);
          return "durable";
        }
        // An UNKNOWN inspect, or a container still under the normal
        // name despite a "successful" cleanup: fall through to the
        // durable-marker path below — fail closed.
      }
      // The container SURVIVED (or its state is uncertain): the in-memory
      // flag alone would be forgotten by a provider restart or a second
      // provider instance, whose open() would hand out this live,
      // untrusted container. Make the quarantine DURABLE in the daemon:
      // re-inspect under the fence and bind every later rename/stop to
      // the IMMUTABLE container ID seen now, so a container that merely
      // re-uses the task NAME (a replacement created behind a lost
      // fence) can never be renamed or stopped by this sequence.
      const probe = await this.inspectContainer(normalName, fence);
      if (probe.kind === "unknown") {
        // Cannot prove anything about the container: keep the host
        // marker (fail closed). Durable only if the marker itself is.
        return markerDurable ? "durable" : "failed";
      }
      if (probe.kind === "missing") {
        // Nothing under the normal name: either a prior quarantine
        // already moved the container, or nothing remains. Verify under
        // the fence; UNKNOWN results keep the host marker (fail closed).
        const qProbe = await this.inspectContainer(qName, fence);
        if (qProbe.kind === "exists") {
          await this.deleteQuarantineMarker(taskId, fence);
          return "durable";
        }
        if (qProbe.kind === "missing") {
          if (!opts.retainTombstone) {
            await this.deleteQuarantineMarker(taskId, fence);
          } else if (!markerDurable) {
            return "failed";
          }
          this.taskActivity.delete(taskId);
          return "durable";
        }
        // qProbe unknown: keep the host marker.
        return markerDurable ? "durable" : "failed";
      }
      // probe.kind === "exists" under the normal name. It is renamable/
      // stoppable ONLY if it is THIS task's container and not a live
      // foreign replacement (which the fence would normally prevent —
      // this binding is the defense in depth for a lost-then-replaced
      // window).
      if (probe.taskLabel !== NO_LABEL && probe.taskLabel !== taskId) {
        // A container created for a DIFFERENT task happens to sit under
        // this task's name: it is not this quarantine's target.
        return markerDurable ? "durable" : "failed";
      }
      if (
        this.classifyContainer(probe.instanceLabel) === "foreign" &&
        probe.running
      ) {
        // A live container owned by ANOTHER instance under this name: a
        // replacement this instance must not touch. The host marker (if
        // durable) blocks opens; otherwise report the failure.
        return markerDurable ? "durable" : "failed";
      }
      // Rename BY THE IMMUTABLE ID (never by name): the daemon-side
      // durable marker. A rename is supported on a running OR stopped
      // container, the new name lives in the daemon (surviving restarts
      // and instance changes), and the container is no longer reachable
      // by its task name — every instance's open() probes the renamed
      // name and rejects (see openCore). Creation-time labels survive
      // the rename, so the TTL reaper (any instance) still lists and
      // reaps the container by its managed label.
      const renamed = await this.fencedDocker(
        fence,
        ["rename", probe.id, qName],
        this.opTimeout(30_000),
        20_000,
      );
      if (!renamed.timedOut && renamed.code === 0) {
        // The daemon-side marker now carries the quarantine durably; the
        // host marker is redundant and would only go stale.
        await this.deleteQuarantineMarker(taskId, fence);
        return "durable";
      }
      if (!renamed.timedOut && /no such container/i.test(renamed.stderr)) {
        // The target vanished between the inspect and the rename (the
        // reaper or another holder removed it). Confirm under the fence
        // which case we are in; an UNKNOWN inspect result keeps the host
        // marker (fail closed), and a container that REAPPEARED under
        // either name also keeps it (the no-such response conflicts with
        // the later probe — never trust the no-such alone).
        const qProbe = await this.inspectContainer(qName, fence);
        if (qProbe.kind === "exists") {
          await this.deleteQuarantineMarker(taskId, fence);
          return "durable";
        }
        if (qProbe.kind === "missing") {
          const normalProbe = await this.inspectContainer(normalName, fence);
          if (normalProbe.kind === "missing") {
            // Nothing under either name: drop the host marker (unless a
            // late create may still surface); the in-memory flag
            // persists until explicit teardown/replacement.
            if (!opts.retainTombstone) {
              await this.deleteQuarantineMarker(taskId, fence);
            } else if (!markerDurable) {
              return "failed";
            }
            this.taskActivity.delete(taskId);
          }
          // exists/unknown under the normal name: keep the host marker —
          // fail closed.
        }
        return markerDurable || !opts.retainTombstone ? "durable" : "failed";
      }
      // The rename failed for a reason other than "the target is already
      // gone". The container KEEPS its normal name, so a restarted or
      // second provider could otherwise see a RUNNING container under
      // the task name and open it. Fail closed with a second supported
      // operation: STOP the container — still bound to the immutable ID.
      const stopped = await this.fencedDocker(
        fence,
        ["stop", probe.id],
        this.opTimeout(30_000),
        20_000,
      );
      if (
        !stopped.timedOut &&
        stopped.code !== 0 &&
        /no such container/i.test(stopped.stderr)
      ) {
        // The target vanished between the rename attempt and the stop:
        // confirm before clearing; unknown or conflicting results keep
        // the marker.
        const late = await this.inspectContainer(normalName, fence);
        if (late.kind === "missing") {
          const qProbe = await this.inspectContainer(qName, fence);
          if (qProbe.kind === "missing") {
            if (!opts.retainTombstone) {
              await this.deleteQuarantineMarker(taskId, fence);
            }
            this.taskActivity.delete(taskId);
          }
        }
        return "durable";
      }
      // The stop's exit code is NOT proof of the container's state: a
      // CLI-level timeout/transport failure reports nonzero, and a
      // daemon that refused the rename may be unwell. CONFIRM the state
      // by re-inspecting the IMMUTABLE ID before deciding whether the
      // host marker may be retired: only a container that is
      // definitively stopped (or gone) is safe without the host-side
      // marker; a still-RUNNING container, or an UNKNOWN result, keeps
      // the host marker — open() must keep rejecting it on every
      // instance, including a restarted provider with the SAME instance
      // identity (which would otherwise see its own RUNNING container
      // and reopen it).
      const state = await this.inspectContainer(probe.id, fence);
      if (state.kind === "missing") {
        const qProbe = await this.inspectContainer(qName, fence);
        if (qProbe.kind === "missing") {
          if (!opts.retainTombstone) {
            await this.deleteQuarantineMarker(taskId, fence);
          }
          this.taskActivity.delete(taskId);
        } else if (qProbe.kind === "exists") {
          await this.deleteQuarantineMarker(taskId, fence);
        }
        // Unknown: keep host marker.
        return "durable";
      }
      if (state.kind === "exists" && !state.running) {
        // Confirmed stopped: Running=false is the daemon-side,
        // cross-instance "do not use" state (openCore rejects stopped
        // containers regardless of owner — including a same-identity
        // restart). The host marker is retired; the TTL reaper removes
        // the stopped container by age.
        await this.deleteQuarantineMarker(taskId, fence);
        return "durable";
      }
      // state.kind === "unknown", or the container is confirmed RUNNING
      // after a failed/ambiguous stop: the host marker STAYS (it was
      // written above) and blocks every open() until an explicit
      // destroy()/create() or a successful later quarantine. The TTL
      // reaper is the backstop.
      if (markerDurable) return "durable";
      // The container could not be removed, renamed, confirmed stopped,
      // NOR marked with a durable host file: no durable channel blocks
      // a same-identity restart from reopening the live untrusted
      // container. Report the failure; the in-memory flag still blocks
      // this process (and the original validation/create error wins).
      return "failed";
    } catch {
      // A fence-loss assertion (or an unexpected coordination error)
      // fired mid-sequence: STOP — the sequence must not fall through
      // into rename/stop/marker retirement against a possibly
      // replacement-held container. The host marker (if durable) stays.
      return markerDurable ? "durable" : "failed";
    }
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
  private async assertNoForeignUnlabeledClaim(
    taskId: string,
    name: string,
  ): Promise<void> {
    const lease = await this.readLease(taskId, name);
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
   * Ownership gate for operations that RECEIVE a handle (read/write/exec/
   * git/validation). A handle is only handed out by open()/create(),
   * which gate ownership themselves — but a handle object is just an
   * id: a second provider instance could be handed one for a container
   * this instance does not own (or one that was quarantined/stopped
   * after the handle was created). Every such operation therefore
   * RE-VALIDATES the container state under the fence: quarantine marker
   * first, then a full combined inspect — running + this-instance label
   * required (an unlabeled legacy container must be open()'d/adopted
   * first, so a direct file op on one is rejected rather than claimed
   * implicitly). Unknown inspect results fail closed.
   */
  private async gateHandleOperation(
    taskId: string,
    fence: HeldFence,
  ): Promise<TaskContainer> {
    // A handle is just an id: validate it the same way create/open/
    // destroy do, so a forged or stale handle (including the reserved
    // quarantine suffix, which must never reach a container name) is
    // rejected before any docker call.
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    this.assertNotQuarantined(taskId);
    const marker = await this.readQuarantineMarker(taskId);
    if (marker !== "absent") {
      this.quarantinedTasks.add(taskId);
      throw new Error(QUARANTINE_ERROR);
    }
    const name = this.containerName(taskId);
    const inspected = await this.inspectContainer(name, fence);
    if (inspected.kind === "unknown") {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (inspected.kind === "missing") {
      throw new Error(WORKSPACE_UNAVAILABLE);
    }
    if (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) {
      throw new Error(WORKSPACE_UNAVAILABLE);
    }
    if (this.classifyContainer(inspected.instanceLabel) === "foreign") {
      throw new Error(WORKSPACE_OWNED);
    }
    if (!inspected.running) {
      throw new Error(WORKSPACE_UNAVAILABLE);
    }
    // An UNLABELED RUNNING container reaches here only after open()
    // adopted it and wrote THIS instance's lease claim (the adoption is
    // atomic under the fence). The claim is re-verified on EVERY handle
    // operation — and it is a HARD requirement: a handle operation never
    // adopts. Only open() establishes an adoption claim; a handle whose
    // claim is absent (deleted, or never written — a forged handle), or
    // stale-foreign (the earlier adopter is gone and the container is
    // unclaimed again) fails CLOSED: the caller must re-open(), which
    // adopts atomically under the fence, or the operation must fail.
    if (this.classifyContainer(inspected.instanceLabel) === "unlabeled") {
      const lease = await this.readLease(taskId, name);
      if (lease.kind === "valid" && lease.instanceId === this.instanceId) {
        // OUR claim, fresh or stale: we hold the fence right now, and a
        // peer re-adoption would have required the fence (its open()
        // writes the claim under the fence), so a claim still naming us
        // proves no peer took over since. Refresh it to re-prove
        // liveness cross-instance; a refresh that cannot be made durable
        // fails the operation closed (an unprovable claim is exactly
        // what another instance's re-adoption would erase).
        const refreshed = await this.writeLease(
          taskId,
          name,
          fence,
          lease.generation,
        );
        if (!refreshed) throw new Error(WORKSPACE_UNDETERMINED);
      } else if (
        lease.kind === "valid" &&
        Date.now() - lease.updatedAt <= this.leaseTtlMs
      ) {
        // A FRESH foreign claim: a peer adopted this container and is
        // alive.
        throw new Error(WORKSPACE_OWNED);
      } else {
        // absent / corrupt / unreadable / stale-foreign: an unlabeled
        // container with no provable claim of ours. Handle operations
        // NEVER claim implicitly — open() is the only adoption path.
        // Fail closed.
        throw new Error(WORKSPACE_UNDETERMINED);
      }
      return { taskId, name, id: inspected.id };
    }
    // LABELED MINE, running: the immutable creation-time label already
    // proves the container is ours (only this instance creates that
    // label, and labels never change), so the lease is purely the
    // liveness signal. Maintain it AFTER the gate — never before: an
    // instance whose container was replaced must not refresh a lease
    // describing a container it no longer owns (the old pre-gate
    // heartbeat could poison the replacement owner's liveness state).
    // A claim that names this instance is refreshed in place
    // (generation preserved); an absent, corrupt, or unreadable claim is
    // RE-ESTABLISHED under the fence with a fresh generation, so a live
    // owner never operates indefinitely without a claim another
    // instance's reaper can see (a vanished claim routes to age reaping
    // once the fence is released).
    const lease = await this.readLease(taskId, name);
    if (
      lease.kind === "valid" &&
      lease.instanceId === this.instanceId &&
      lease.generation
    ) {
      const refreshed = await this.writeLease(
        taskId,
        name,
        fence,
        lease.generation,
      );
      if (!refreshed) throw new Error(WORKSPACE_UNDETERMINED);
    } else {
      // absent / corrupt / unreadable / a foreign leftover on a
      // container the immutable label proves is ours: (re-)establish
      // the claim. A fresh generation is minted whenever the existing
      // claim does not name this instance, so a stale teardown holding
      // an older generation token can never unlink the new claim.
      const claimed = await this.writeLease(taskId, name, fence, randomUUID());
      if (!claimed) throw new Error(WORKSPACE_UNDETERMINED);
    }
    return { taskId, name, id: inspected.id };
  }

  /**
   * Destroy the task container; its tmpfs workspace is removed with it. Call
   * when a task reaches a terminal state; the reaper is the backstop for
   * abandoned tasks. Also the explicit teardown that clears a quarantine
   * (see quarantinedTasks) — the flag persists if the removal fails.
   * cleanupAll removes the container under EITHER name, so a quarantined
   * (renamed) container is actually destroyed here, not orphaned.
   *
   * destroy never refreshes or rewrites the lease: nothing may resurrect
   * the workspace's liveness claim, and the (generation-aware) lease
   * deletion at the end may only remove a lease that still describes
   * THIS teardown's container. A successful destroy reports success only
   * when the container is provably gone under both names, the fence was
   * never lost, and no replacement container or fresh replacement lease
   * appeared mid-teardown — anything ambiguous fails closed with the
   * undetermined error instead of lying about the workspace's state.
   */
  async destroy(taskId: string): Promise<void> {
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    // recordActivity=false: destruction clears a workspace, so it must
    // never record liveness — neither enqueue nor completion may touch
    // activity or the lease.
    return this.withOwnerTaskOperation(
      taskId,
      (fence) => this.destroyCore(taskId, fence),
      false,
    );
  }

  private async destroyCore(taskId: string, fence: HeldFence): Promise<void> {
    // The same ownership gate as open/create, applied BEFORE any rm and
    // under the cross-instance fence (the inspect → rm window is thus
    // atomic across provider instances): a normal-name container whose
    // task label differs, or that is stamped with another live instance,
    // must never be removed by this instance (it is another instance's
    // live workspace). A quarantined-name container is not gated: it is
    // unusable by definition, and destroy() is the explicit operation
    // that clears a quarantine.
    const name = this.containerName(taskId);
    const existing = await this.inspectContainer(name, fence);
    if (existing.kind === "unknown") {
      // Fail CLOSED: never run an rm when the container's existence
      // could not be determined. The quarantined-name container (if
      // any) is not reached either — defer the teardown until the
      // daemon is reachable again.
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (existing.kind === "exists") {
      // Same rules as create(): a container labeled for a different
      // task is never removed; a STOPPED foreign container (the
      // quarantine stop-fallback state, left behind by an instance
      // whose flag this process does not hold) has no possible live
      // user, so removing it is how that state gets cleaned up.
      if (existing.taskLabel !== NO_LABEL && existing.taskLabel !== taskId) {
        throw new Error(WORKSPACE_UNAVAILABLE);
      }
      if (
        this.classifyContainer(existing.instanceLabel) === "foreign" &&
        existing.running
      ) {
        throw new Error(WORKSPACE_OWNED);
      }
      // UNLABELED RUNNING container: honor a peer's persistent adoption
      // claim the same way create()/open() do.
      if (this.classifyContainer(existing.instanceLabel) === "unlabeled") {
        await this.assertNoForeignUnlabeledClaim(taskId, name);
      }
    }
    // The generation of the container THIS teardown was gating on (read
    // before the destructive calls, under the fence): the lease
    // deletion must target that generation only, never a replacement.
    const before = await this.readLease(taskId, name);
    const myGeneration =
      before.kind === "valid" ? before.generation : undefined;
    // Remove the container under EITHER name. Each removal re-inspects
    // under the fence and `rm -f`s by the IMMUTABLE container ID it
    // saw, so an old teardown can never remove a replacement container
    // that re-used the task name; every call re-asserts the fence token
    // first (a teardown that lost its fence throws before the rm).
    await this.cleanupAll(taskId, fence);
    // The removal was checked (cleanupAll throws on a failed rm), but
    // the whole sequence may have taken a while: re-assert the fence
    // BEFORE retiring any state — a stale-broken teardown must not
    // erase the bookkeeping of a lock it demonstrably lost (and the rm
    // above already ran only because the token was present at that
    // moment; this check narrows the loss window for the state
    // mutation that follows).
    await this.assertFenceLive(fence);
    // AMBIGUITY CHECK: with the fence continuously held, no peer could
    // have created a replacement under the task name — so a container
    // that EXISTS under the name now (or an inspect we cannot resolve)
    // means the teardown's outcome is ambiguous: do not retire the
    // quarantine marker, the lease, or report success.
    const after = await this.inspectContainer(name, fence);
    if (after.kind !== "missing") {
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    // The task's container is gone under BOTH names, so its quarantine
    // is over too. Clear bookkeeping and the durable marker; the lease
    // deletion is GENERATION-aware (instance AND the container
    // generation read above), so a replacement owner's fresh lease can
    // never be unlinked — deleteLease refuses to act when the fence is
    // inactive, re-verifies the captured lease file, and reports what
    // it left behind. destroy records no activity and refreshes no
    // lease: nothing must resurrect the workspace's liveness claim.
    this.quarantinedTasks.delete(taskId);
    this.taskActivity.delete(taskId);
    await this.deleteQuarantineMarker(taskId, fence);
    const leaseOutcome = await this.deleteLease(
      taskId,
      name,
      fence,
      myGeneration,
    );
    if (leaseOutcome === "valid-left") {
      // A live lease we could not prove deleted (a fresh replacement
      // claim, or a deletion the filesystem refused): reporting success
      // would leave the task's liveness state ambiguous. Fail closed —
      // an explicit retry resolves it once the lease is deletable.
      throw new Error(WORKSPACE_UNDETERMINED);
    }
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

  private containerName(taskId: string): string {
    return `valmont-sandbox-${taskId}`;
  }

  /**
   * The name a SURVIVING quarantined container is renamed to (see
   * quarantineTask): the durable, cross-instance quarantine marker.
   */
  private quarantinedContainerName(taskId: string): string {
    return `${this.containerName(taskId)}${QUARANTINED_SUFFIX}`;
  }

  /**
   * Inspect a container by name in ONE call, reading its Running state and
   * the two ownership labels (task + instance). The NAME alone is never
   * trusted for ownership: a rename that failed with "name already in use"
   * can leave a foreign container under a name this instance expects to be
   * its own, so the labels are authoritative. A missing label renders as
   * `<no value>` (NO_LABEL).
   *
   * The result is a DISCRIMINATED union, never a boolean: "missing"
   * (the daemon authoritatively reports no such object), "exists"
   * (running/label fields valid), or "unknown" (a timeout, transport,
   * permission, spawn, or parse failure — the caller MUST fail closed and
   * never run an `rm`: the container may well exist).
   */
  private async inspectContainer(
    name: string,
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
      }
  > {
    let result: DockerRunResult;
    try {
      // The combined probe reads the container's IMMUTABLE ID first:
      // callers bind their later rm/rename/stop/exec to that ID so an
      // old operation can never target a replacement container that
      // merely re-used the task NAME. `name` here may itself already be
      // an ID (the reaper inspects by the ID from its `docker ps` row).
      result = await this.fencedDocker(
        fence,
        [
          "inspect",
          "--format",
          '{{.Id}}|{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}',
          name,
        ],
        this.opTimeout(15_000),
        this.outputLimitBytes,
      );
    } catch {
      // The CLI itself failed to spawn/report (transport), or the fence
      // was lost: existence is unknown (or the caller already failed
      // closed).
      return { kind: "unknown" };
    }
    if (result.timedOut) return { kind: "unknown" };
    if (result.code !== 0) {
      // Docker reports a truly absent object as "No such object"/"No such
      // container" on stderr. Anything else (timeout, permission denied,
      // daemon error, ...) means we do NOT know whether the container
      // exists, and every caller fails closed on "unknown".
      if (/no such (object|container)/i.test(result.stderr)) {
        return { kind: "missing" };
      }
      return { kind: "unknown" };
    }
    const parts = result.stdout.trim().split("|");
    if (
      parts.length !== 4 ||
      (parts[1] !== "true" && parts[1] !== "false") ||
      !parts[0]
    ) {
      // An unparsable successful response is not proof of anything.
      return { kind: "unknown" };
    }
    return {
      kind: "exists",
      id: parts[0],
      running: parts[1] === "true",
      taskLabel: parts[2] ?? "",
      instanceLabel: parts[3] ?? "",
    };
  }

  /**
   * Classify a container's `valmont.instance` label relative to THIS
   * instance: "mine" (the label is this instanceId), "unlabeled" (no label
   * — the creator predates the mechanism or is gone; no live instance can
   * own it), or "foreign" (another live-or-dead instance created it).
   */
  private classifyContainer(
    instanceLabel: string,
  ): "mine" | "unlabeled" | "foreign" {
    if (instanceLabel === "" || instanceLabel === NO_LABEL) return "unlabeled";
    if (instanceLabel === this.instanceId) return "mine";
    return "foreign";
  }

  private leasePath(taskId: string): string {
    return path.join(this.leaseDir!, `${taskId}.lease`);
  }

  /** Path of the durable, host-side quarantine marker for a task. */
  private quarantineMarkerPath(taskId: string): string {
    return path.join(this.leaseDir!, `${taskId}.quarantined`);
  }

  /** Path of the cross-instance per-task fence lock directory. */
  private fencePath(taskId: string): string {
    return path.join(this.leaseDir!, ".locks", `${taskId}.lock`);
  }

  /**
   * Read a lease file at an explicit path (see readLease).
   */
  private async readLeaseFile(
    file: string,
    taskId: string,
    expectedContainerName?: string,
  ): Promise<
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
    let raw: string;
    try {
      raw = await this.fs.readFile(file, "utf8");
    } catch (error) {
      // ENOENT is the ONLY "no lease" signal. Every other failure
      // (EACCES, EIO, ENOTDIR, a failed mount, ...) means the lease
      // state is unknown — fail closed, do not infer owner absence.
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
    // A non-object payload (null, a number, a string, an array) is a
    // torn/garbage lease — corrupt, never an exception (the callers'
    // discriminated contract must hold).
    if (parsed === null || typeof parsed !== "object") {
      return { kind: "corrupt" };
    }
    const candidate = parsed as {
      instanceId?: unknown;
      updatedAt?: unknown;
      containerName?: unknown;
      taskId?: unknown;
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
      ts < 0 ||
      // Sane range: not before the year 2000 and not more than a small
      // future skew ahead of this host's clock (a far-future timestamp
      // would read as permanently fresh).
      ts < 946_684_800_000 ||
      ts > Date.now() + LEASE_FUTURE_SKEW_MS
    ) {
      return { kind: "corrupt" };
    }
    // Identity: the lease must describe the container the decision is
    // about (a stray/relocated file claiming a different container is
    // not a liveness signal for this one).
    if (
      typeof candidate.containerName !== "string" ||
      (expectedContainerName !== undefined &&
        candidate.containerName !== expectedContainerName)
    ) {
      return { kind: "corrupt" };
    }
    if (candidate.taskId !== undefined && candidate.taskId !== taskId) {
      return { kind: "corrupt" };
    }
    // generation: absent/non-string leases were written by an older
    // build — they are still valid liveness; treat the missing token as
    // a sentinel (a teardown that cannot prove its generation also
    // cannot delete the lease, which is the fail-closed direction).
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
   * Read this task's lease (see readLeaseFile for the discriminated
   * result and the validation rules). A lease that is unreadable or
   * corrupt is NEVER treated as "owner dead" — only "cannot prove
   * liveness" (the strict side).
   */
  private async readLease(
    taskId: string,
    expectedContainerName?: string,
  ): Promise<
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
    const canonical = await this.readLeaseFile(
      this.leasePath(taskId),
      taskId,
      expectedContainerName,
    );
    if (canonical.kind !== "absent") return canonical;
    // A capture left behind by a crash or an uncertain restore is still a
    // liveness claim. Never interpret a missing canonical path as owner
    // death while recoverable lease state exists in the same directory.
    try {
      const prefixA = `.${taskId}.lease.previous.`;
      const prefixB = `.${taskId}.lease.captured.`;
      const entries = await this.fs.readdir(this.leaseDir!);
      if (
        entries.some(
          (entry) =>
            (entry.startsWith(prefixA) || entry.startsWith(prefixB)) &&
            entry.endsWith(".tmp"),
        )
      ) {
        return { kind: "unreadable" };
      }
    } catch {
      return { kind: "unreadable" };
    }
    return canonical;
  }

  /**
   * Lease write (a liveness claim for this task, held by THIS instance
   * and the current container GENERATION). Atomic, non-overwriting
   * publication uses a UNIQUE temp file followed by an exclusive hard link:
   * a stale writer can never replace a successor's lease. The prior claim is
   * captured while fenced and restored only with the same exclusive link.
   * The fence token is re-verified immediately before publication: a holder
   * that lost its fence must not
   * stamp liveness onto a task a replacement holder may already own.
   * Returns false when the lease could not be made durable — callers
   * fail closed when they hold an active fence (another instance's
   * reaper must not age-reap a live container whose claim vanished).
   */
  private async writeLease(
    taskId: string,
    containerName: string,
    fence?: HeldFence,
    generation: string = "",
  ): Promise<boolean> {
    if (!this.leaseDir) return false;
    const releaseAfter = !fence;
    const held: HeldFence | null = fence
      ? fence
      : await this.acquireTaskFence(taskId, "owner");
    try {
      if (!held || !held.active) return false;
      if (!(await this.checkFenceLive(held))) return false;
      const payload = JSON.stringify({
        instanceId: this.instanceId,
        updatedAt: Date.now(),
        containerName,
        taskId,
        generation,
      });
      await this.fs.mkdir(this.leaseDir, { recursive: true });
      // Unique temporary name per write: instance + pid + random suffix.
      const tmp = path.join(
        this.leaseDir,
        `.${taskId}.lease.${this.instanceId.slice(0, 8)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await this.fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });

      // Never publish with rename(2): it unconditionally replaces an
      // existing destination, so a holder that loses its fence while an
      // fs operation is delayed could overwrite its successor's claim.
      // Move the old claim aside, re-check the fence, then use link(2) as
      // an atomic create-if-absent publication. If a successor publishes
      // first, link returns EEXIST and its lease is left byte-for-byte.
      const leasePath = this.leasePath(taskId);
      const previous = path.join(
        this.leaseDir,
        `.${taskId}.lease.previous.${randomUUID()}.tmp`,
      );
      let capturedPrevious = false;
      try {
        // Refuse special/non-file coordination entries rather than moving
        // them aside (directories cannot be restored with link()).
        try {
          if (!(await this.fs.lstat(leasePath)).isFile()) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
        await this.fs.rename(leasePath, previous);
        capturedPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      if (!(await this.checkFenceLive(held))) {
        let previousDisposable = false;
        if (capturedPrevious) {
          try {
            await this.fs.link(previous, leasePath);
            previousDisposable = true;
          } catch (error) {
            // Only EEXIST proves another canonical claim is authoritative.
            // On every other error retain the captured file; readLease()
            // recognizes it as recoverable fail-closed state.
            previousDisposable =
              (error as NodeJS.ErrnoException)?.code === "EEXIST";
          }
        }
        await this.fs.rm(tmp, { force: true }).catch(() => {});
        if (capturedPrevious && previousDisposable) {
          await this.fs.rm(previous, { force: true }).catch(() => {});
        }
        return false;
      }
      let previousDisposable = false;
      try {
        await this.fs.link(tmp, leasePath);
        previousDisposable = capturedPrevious;
      } catch {
        // Publication failed. Restore the captured claim exclusively; only
        // EEXIST proves a concurrent canonical claim superseded it.
        if (capturedPrevious) {
          try {
            await this.fs.link(previous, leasePath);
            previousDisposable = true;
          } catch (error) {
            previousDisposable =
              (error as NodeJS.ErrnoException)?.code === "EEXIST";
          }
        }
        return false;
      } finally {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
        if (capturedPrevious && previousDisposable) {
          await this.fs.rm(previous, { force: true }).catch(() => {});
        }
      }
      // READBACK: successful exclusive publication is not proof the claim
      // landed durably (it could have fallen on a dead mount). Only a
      // lease we can read back fresh, naming us, counts. A readback
      // failure is an unreadable-lease state, which every reaper path
      // treats as skip (fail closed).
      const back = await this.readLease(taskId, containerName);
      if (
        back.kind === "valid" &&
        back.instanceId === this.instanceId &&
        back.generation === generation
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (releaseAfter && held) await held.release();
    }
  }

  /**
   * GENERATION-AWARE lease deletion with an atomic capture-verify step.
   * The lease is removed only when, under an ACTIVE fence that this
   * holder has not lost:
   * - the file is capturable by an atomic rename to a unique graveyard
   *   path (so the deletion decision and the capture cannot interleave
   *   with a writer: the captured file is exactly what was on disk),
   * - the CAPTURED file parses as a lease naming THIS instance, the
   *   expected container, and (when the caller knows it) the expected
   *   GENERATION — the generation of the container the caller removed.
   *   If the captured file does NOT match (the lease changed between
   *   the caller's read and this capture — the race the review
   *   requires a test for), the captured file is RESTORED to the lease
   *   path (when it is free) and nothing is deleted: a replacement
   *   owner's lease survives a stale teardown by construction.
   *
   * Outcomes:
   * - "deleted": the matching lease was captured and unlinked;
   * - "absent": there was nothing to delete;
   * - "corrupt-left": the lease is unreadable/corrupt garbage and is
   *   left in place (never unlinked: it cannot be proven to be ours,
   *   and it can never act as a live claim);
   * - "valid-left": a VALID lease was left in place — it did not match
   *   (a fresh replacement claim, a generation mismatch, or the
   *   capture/restore could not be proven). Callers that must not
   *   report success over an ambiguous liveness state (destroy) fail
   *   closed on this.
   *
   * The call REFUSES to act when the supplied fence is inactive or
   * degraded, and when no fence is supplied it acquires one itself —
   * refusing on any inactive outcome: an unfenced deletion cannot be
   * serialized against writers and might unlink a replacement's claim.
   */
  private async deleteLease(
    taskId: string,
    expectedContainerName?: string,
    fence?: HeldFence,
    expectedGeneration?: string,
  ): Promise<"deleted" | "absent" | "corrupt-left" | "valid-left"> {
    if (!this.leaseDir) return "absent";
    // Refuse when the supplied fence is inactive/degraded (or lost).
    if (fence && !(await this.checkFenceLive(fence))) return "valid-left";
    const releaseAfter = !fence;
    const held: HeldFence | null = fence
      ? fence
      : await this.acquireTaskFence(taskId, "reaper");
    try {
      if (!held || !held.active) return "valid-left";
      if (!(await this.checkFenceLive(held))) return "valid-left";
      const leasePath = this.leasePath(taskId);
      // ATOMIC CAPTURE: rename the lease path away. The graveyard is a
      // sibling temp file; the lease path is empty the instant the
      // rename lands, and the captured file is exactly the bytes that
      // were there.
      const graveyard = path.join(
        this.leaseDir,
        `.${taskId}.lease.captured.${randomUUID()}.tmp`,
      );
      try {
        await this.fs.rename(leasePath, graveyard);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return "absent";
        }
        // The capture failed for an unknown reason (EACCES, EIO, ...):
        // the lease's fate is unknown — leave everything in place and
        // report it (the strict direction: a valid lease that we could
        // not prove deleted).
        return "valid-left";
      }
      const captured = await this.readLeaseFile(
        graveyard,
        taskId,
        expectedContainerName,
      );
      const matches =
        captured.kind === "valid" &&
        captured.instanceId === this.instanceId &&
        (expectedGeneration === undefined ||
          expectedGeneration === "" ||
          captured.generation === expectedGeneration);
      if (!matches) {
        // The lease CHANGED between the caller's read and the capture
        // (or never matched): restore the captured file unless a newer
        // lease already appeared at the path (in which case the newer
        // one stays and the captured one dies in the graveyard — the
        // path never ends up empty while a live claim exists).
        let capturedDisposable = false;
        try {
          // Exclusive restore: unlike rename(), link() cannot overwrite a
          // replacement lease that appeared after the capture.
          await this.fs.link(graveyard, leasePath);
          capturedDisposable = true;
        } catch (error) {
          // Only EEXIST proves a replacement canonical lease exists. For
          // EIO/EPERM/ENOSPC/etc. retain the recoverable capture so readers
          // continue to fail closed instead of inferring lease absence.
          capturedDisposable =
            (error as NodeJS.ErrnoException)?.code === "EEXIST";
        }
        if (capturedDisposable) {
          await this.fs.rm(graveyard, { force: true });
        }
        return captured.kind === "valid" ? "valid-left" : "corrupt-left";
      }
      // A matching (or garbage-but-ours-unprovable) capture: unlink it.
      // Corrupt/unreadable captures were already filtered by `matches`
      // into the restore branch — only a validated matching lease (or a
      // corrupt one naming nobody, which readLeaseFile reported as
      // corrupt and `matches` rejected) reaches here, so the unlink
      // never destroys an unverified claim.
      await this.fs.rm(graveyard, { force: true });
      return "deleted";
    } catch {
      // Unknown failure mid-deletion: report the strict outcome (the
      // lease may or may not still exist).
      return "valid-left";
    } finally {
      if (releaseAfter && held) await held.release();
    }
  }

  /**
   * Best-effort write of the durable, host-side quarantine marker.
   * Atomic (unique temp + rename), mode 0600. Survives restarts of this
   * provider and is visible to every instance sharing the lease dir.
   */
  private async writeQuarantineMarker(
    taskId: string,
    fence?: HeldFence,
  ): Promise<boolean> {
    if (!this.leaseDir || !fence || !(await this.checkFenceLive(fence))) {
      return false;
    }
    try {
      await this.fs.mkdir(this.leaseDir, { recursive: true });
      const payload = JSON.stringify({
        taskId,
        instanceId: this.instanceId,
        fenceToken: fence.token,
        quarantinedAt: Date.now(),
      });
      const tmp = path.join(
        this.leaseDir,
        `.${taskId}.quarantined.${randomUUID()}.tmp`,
      );
      await this.fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      const markerPath = this.quarantineMarkerPath(taskId);
      try {
        // Exclusive publication cannot overwrite a replacement marker.
        await this.fs.link(tmp, markerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      } finally {
        await this.fs.rm(tmp, { force: true }).catch(() => {});
      }
      // Only a positively readable marker proves restart durability.
      const verify = await this.readQuarantineMarker(taskId);
      return verify === "quarantined";
    } catch {
      return false;
    }
  }

  /**
   * Fence-aware marker retirement. The canonical marker is first captured
   * to a unique recoverable path; after capture the fence is checked again.
   * A lost holder restores exclusively and can never unlink a replacement
   * marker. Unknown restoration failures retain the capture, which marker
   * reads treat as quarantined.
   */
  private async deleteQuarantineMarker(
    taskId: string,
    fence?: HeldFence,
  ): Promise<void> {
    if (!this.leaseDir || !fence || !(await this.checkFenceLive(fence))) return;
    const markerPath = this.quarantineMarkerPath(taskId);
    const captured = path.join(
      this.leaseDir,
      `.${taskId}.quarantined.captured.${randomUUID()}.tmp`,
    );
    try {
      await this.fs.rename(markerPath, captured);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      return;
    }
    if (!(await this.checkFenceLive(fence))) {
      let disposable = false;
      try {
        await this.fs.link(captured, markerPath);
        disposable = true;
      } catch (error) {
        disposable = (error as NodeJS.ErrnoException)?.code === "EEXIST";
      }
      if (disposable)
        await this.fs.rm(captured, { force: true }).catch(() => {});
      return;
    }
    // A replacement cannot publish until this holder loses the fence. Since
    // the canonical marker was captured before the successful live check,
    // this removal targets only the pre-existing marker; a replacement marker
    // published afterward occupies the distinct canonical path.
    await this.fs.rm(captured, { force: true }).catch(() => {});
  }

  /**
   * Read the durable quarantine marker. "quarantined" = a present marker
   * (unreadable content also blocks open — fail closed); "absent" =
   * ENOENT or no lease dir; "unreadable" = a directory/permission error
   * on the path itself (also fail closed for callers).
   */
  private async readQuarantineMarker(
    taskId: string,
  ): Promise<"quarantined" | "absent" | "unreadable"> {
    if (!this.leaseDir) return "absent";
    try {
      await this.fs.readFile(this.quarantineMarkerPath(taskId), "utf8");
      return "quarantined";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") return "unreadable";
      // A capture retained after a crash or uncertain restore is itself a
      // durable quarantine channel even while the canonical path is absent.
      try {
        const prefix = `.${taskId}.quarantined.captured.`;
        const entries = await this.fs.readdir(this.leaseDir);
        if (
          entries.some(
            (entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"),
          )
        ) {
          return "quarantined";
        }
      } catch {
        return "unreadable";
      }
      return "absent";
    }
  }

  /**
   * Acquire the CROSS-INSTANCE per-task fence: an exclusive lock
   * DIRECTORY under the (host-shared) lease directory, taken atomically
   * with `mkdir` (POSIX: mkdir succeeds for exactly one process; EEXIST
   * means a peer holds it). Every public provider operation holds it
   * for the operation's whole duration and the TTL reaper only removes
   * a container while holding it, so the ownership decision and the
   * destructive rm it gates can never interleave across provider
   * instances (or across two processes configured with the same stable
   * identity).
   *
   * PROTOCOL (token-based; see HeldFence, renewFence, breakStaleFence):
   * - ACQUIRE: mkdir the lock dir, then write a UUID token file inside.
   *   The token file's path is holder-private: only its holder ever
   *   creates or touches it, and nobody can re-create it after it is
   *   removed.
   * - HOLD/RENEW: the holder `utimes` its OWN TOKEN (never the shared
   *   lock directory) every heartbeatMs (max(25 ms, TTL/3), always
   *   below the TTL — validated at construction).
   * - STALE-BREAK: a breaker may only take a token whose mtime is older
   *   than the TTL, and only through an ATOMIC CAPTURE (rename to a
   *   graveyard sibling) plus a VERIFICATION of the captured file: a
   *   token that was renewed before the capture is RESTORED and the
   *   break declines. A live holder therefore cannot be broken out of
   *   its lock, and a broken holder's next renewal fails with ENOENT —
   *   the fence is marked lost and every subsequent fenced Docker call
   *   fails closed. There is no interleaving where the holder renews
   *   successfully AND the breaker takes over.
   * - RELEASE: remove our own token, then rmdir the lock dir only when
   *   it is empty (a replacement acquirer's token makes the rmdir fail
   *   harmlessly). The heartbeat only ever touched our own token path,
   *   so release cannot race it into shared state.
   * - EVENT-LOOP PAUSES / DELAYED FS: a holder frozen past the TTL is
   *   legitimately breakable (that is the TTL's purpose); on resume,
   *   the first thing any of its fenced Docker calls does is re-verify
   *   the token (assertFenceLive), which fails — the operation aborts
   *   rather than touching a container a replacement may hold.
   *
   * Returns a HeldFence that is active ONLY when the lock was actually
   * acquired. Every inactive outcome fails closed for owner operations
   * and skips for the reaper; `inactiveReason` distinguishes (for the
   * error surface) a live peer (contention), a provably fleet-wide
   * unusable lock namespace (unavailable: EROFS/ENOSPC/ENOTDIR on the
   * mkdir itself), and a local/transient failure (unknown: EACCES,
   * EIO, ENOENT, ESTALE, ... — this instance cannot know whether peers
   * can still fence, so it must never proceed as if the failure were
   * shared).
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
    // True once any attempt has SEEN the lock directory exist (held by a
    // peer): it distinguishes a PEER that kept the lock for the whole
    // wait (alive and fencing — fail closed as contention) from a
    // coordination directory that never worked at all.
    let sawContendedLock = false;
    let degradedRetries = 1;
    for (;;) {
      try {
        // Atomic claim: mkdir on the lock path succeeds for exactly one
        // process on one host (the parent .locks directory is created
        // first, recursively and idempotently).
        await this.fs.mkdir(path.join(this.leaseDir, ".locks"), {
          recursive: true,
          mode: 0o700,
        });
        await this.fs.mkdir(lockDir, { mode: 0o700 });
        // We own it: write our token file. The token is the ONLY
        // ownership record — a holder-private path (its UUID name is
        // known to nobody else) that this holder renews with utimes and
        // that no peer can ever re-create, so "my token file exists" is
        // the liveness proof and its disappearance is the loss proof.
        await this.fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
        // RENEWAL HEARTBEAT: the holder keeps its OWN TOKEN's mtime
        // fresh (utimes on the holder-private path — never on the lock
        // directory, which is shared state a stale holder must not
        // touch). A stale-breaker judges staleness by the TOKEN's mtime,
        // and its capture-verify protocol (breakStaleFence) can never
        // remove a token that was renewed before the capture — so a
        // live holder cannot be broken out of its lock, and a holder
        // that WAS broken fails its next renewal with ENOENT and marks
        // the fence lost (the whole operation then fails closed).
        const heartbeat = setInterval(() => {
          void this.renewFence(fence);
        }, this.fenceHeartbeatMs);
        if (typeof heartbeat.unref === "function") heartbeat.unref();
        const fence: HeldFence = {
          taskId,
          token,
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
          // Held by a peer (or a crashed one). breakStaleFence recovers
          // BOTH stale shapes and PROVES it did not take a live
          // holder's token (see its protocol); when it declines, the
          // lock is live and we simply wait.
          const broke = await this.breakStaleFence(lockDir);
          if (broke) {
            await sleepMs(30);
            continue; // retry the mkdir immediately
          }
        } else if (
          code === "EROFS" ||
          code === "ENOSPC" ||
          code === "ENOTDIR"
        ) {
          // The lock NAMESPACE itself cannot take entries: a read-only
          // mount, a full filesystem, or a non-directory where the lock
          // dir must live. No process on this host can create a lock
          // here, so this is the one COORDINATION-DIRECTORY-UNAVAILABLE
          // condition that is genuinely fleet-wide. Retry ONCE after a
          // short wait (ENOSPC can clear); then report unavailable —
          // which FAILS CLOSED exactly like every other inactive
          // outcome (it is only distinguished for the error surface).
          if (degradedRetries <= 0 || Date.now() >= deadline) {
            return this.inactiveFence(taskId, lockDir, token, "unavailable");
          }
          degradedRetries -= 1;
          await sleepMs(100);
          continue;
        }
        // ANY OTHER filesystem error — EACCES (this process may simply
        // lack write permission while peers do NOT), EIO, ENOENT,
        // ESTALE, a vanished parent, ... — is a LOCAL or TRANSIENT
        // failure. It must NEVER be read as "the coordination directory
        // is degraded for the whole fleet, proceed": one provider
        // proceeding while another can still acquire the fence is
        // exactly the two-holders hazard. Wait out the deadline and
        // fail closed with the unknown reason.
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
      active: false,
      inactiveReason,
      lockDir,
      tokenFile: path.join(lockDir, token),
      lost: false,
      release: async () => {},
    };
  }

  /**
   * Fence renewal heartbeat: bump OUR OWN token file's mtime so no peer
   * judges it stale. This is a single operation on a holder-private path
   * — never on the shared lock directory — so:
   * - a holder that was stale-broken (its token was captured and
   *   removed) fails with ENOENT and stops renewing: the fence is
   *   marked LOST and the whole fenced operation fails closed;
   * - a renewal that raced the breaker's capture either landed BEFORE
   *   the capture (the breaker's verification then sees a fresh token,
   *   RESTORES it, and declines to break — we still own the fence) or
   *   fails with ENOENT (we correctly detect the loss). There is no
   *   interleaving in which the holder renews successfully AND the
   *   breaker takes over;
   * - the delayed/event-loop-paused case is covered by the same token
   *   check: a utimes that lands after a completed break can only hit a
   *   path that no longer exists.
   * A FAILED renewal (any error — token gone, or the filesystem
   * unavailable) makes the fence unusable for the rest of the
   * operation: `lost` is sticky and every later fenced Docker call
   * fails closed.
   */
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
  private async removeTaskContainer(
    taskId: string,
    which: "normal" | "quarantined",
    fence?: HeldFence,
  ): Promise<void> {
    const name =
      which === "normal"
        ? this.containerName(taskId)
        : this.quarantinedContainerName(taskId);
    const inspected = await this.inspectContainer(name, fence);
    if (inspected.kind === "missing") return;
    if (inspected.kind === "unknown") {
      // Fail CLOSED: an unknown inspect must NEVER be followed by an rm.
      throw new Error(WORKSPACE_UNDETERMINED);
    }
    if (inspected.taskLabel !== NO_LABEL && inspected.taskLabel !== taskId) {
      // A container for a DIFFERENT task happens to sit under this name:
      // it is not this task's container and must never be removed here.
      throw new Error(WORKSPACE_UNAVAILABLE);
    }
    const removed = await this.fencedDocker(
      fence,
      ["rm", "-f", inspected.id],
      this.opTimeout(30_000),
      20_000,
    );
    // Check the result: reporting a removal as successful while the
    // container still exists would leak a quota-bound container (and, for
    // destroy(), lie about the workspace being gone). A not-found result
    // is fine — there is nothing to remove.
    if (
      removed.timedOut ||
      (removed.code !== 0 && !/no such container/i.test(removed.stderr))
    ) {
      throw new Error(
        `Could not remove sandbox container: ${
          removed.stderr.trim() || removed.code
        }`,
      );
    }
  }

  /**
   * Remove the task container under EITHER name it may hold: the normal
   * name, or the durable quarantine name a surviving unremovable
   * container was renamed to (see quarantineTask). destroy() and
   * create()'s replacement both go through this, so a quarantined
   * container is actually removed — not just orphaned — by its task.
   * Each removal is fence-asserted and ID-bound (see
   * removeTaskContainer); a failure of either throws.
   */
  private async cleanupAll(taskId: string, fence?: HeldFence): Promise<void> {
    await this.removeTaskContainer(taskId, "normal", fence);
    await this.removeTaskContainer(taskId, "quarantined", fence);
  }

  private async reapExpired(): Promise<void> {
    if (this.reaperRunning) return;
    this.reaperRunning = true;
    try {
      // Four columns: the container ID (the rm target), the task label,
      // the INSTANCE label (ownership, see the class documentation), and
      // the name (carries the quarantine marker). The instance column is
      // what lets this instance SKIP containers a live foreign instance
      // owns — reaping them here would remove a task another instance is
      // using. (A missing label renders as "<no value>" — Go template
      // behavior the fake daemon mirrors.)
      const listed = await this.docker(
        [
          "ps",
          "-a",
          "--filter",
          "label=valmont.managed=true",
          "--format",
          '{{.ID}}\t{{.Label "valmont.task"}}\t{{.Label "valmont.instance"}}\t{{.Names}}',
        ],
        30_000,
        this.psListLimitBytes,
      );
      if (listed.code !== 0 || listed.timedOut) return;
      if (listed.stdoutTruncated) {
        // A partial listing must NEVER be treated as complete:
        // `docker ps -a` lists the NEWEST containers first, so the
        // truncated suffix holds the OLDEST ones — exactly the
        // candidates most in need of reaping. Skip this interval and
        // retry with the full listing; if the container count
        // persistently exceeds the cap, that is itself visible
        // (containers piling up) and the cap must be raised —
        // partially reaping would look healthy while skipping the
        // oldest containers indefinitely.
        return;
      }
      for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        const [id, task, instance, nameRaw] = line.split("\t");
        if (!id || !task) continue;
        // `docker ps` renders `.Names` with a leading "/". The 2-column
        // listing shape (id \t task) — what tests inject — carries no
        // instance or name column; its id IS the name.
        const name = (nameRaw ?? id).trim().replace(/^\//, "");
        if (!isValidTaskId(task)) {
          // A managed container whose `valmont.task` label is not a valid
          // task identifier (a legacy/foreign label, or the reserved
          // quarantine suffix, or label text that is not even a safe
          // path component). We CANNOT key any bookkeeping by that
          // label — the per-task queue, the lease file, and the
          // quarantine marker are all keyed by the task id, and an
          // arbitrary label must never reach a filesystem path. The
          // container is therefore NEVER removed directly: "the task
          // label is now considered invalid" is not evidence that a
          // potentially live legacy/foreign container is dead, and the
          // old direct `rm -f` here was exactly that fallacy. It stays
          // for the operator (or a later, labeled replacement under a
          // valid task id); the conservative leak is the fail-closed
          // direction.
          continue;
        }
        // OWNERSHIP ROUTING (see the cross-instance ownership section of
        // the class documentation). "mine": this instance's activity
        // record (plus my own lease) drives the TTL decision.
        // "age": the container is not this instance's — it is a
        // quarantined container (unusable by definition: no live user, no
        // activity of any instance could make it useful) or its owner is
        // provably gone (stale/absent lease, or unlabeled with no live
        // claim) — the only available abandonment signal is the
        // container's age. "skip": a LIVE foreign instance owns it (fresh
        // lease) — removing it would destroy another instance's live
        // workspace; the owner's own reaper handles it. A CORRUPT or
        // UNREADABLE lease fails closed to "skip" (the owner may still be
        // alive; an unreadable lease is never evidence of absence).
        let routing: "mine" | "age" | "skip";
        const quarantinedRow = name.endsWith(QUARANTINED_SUFFIX);
        if (quarantinedRow) {
          routing = "age";
        } else if (instance === undefined) {
          routing = "mine";
        } else if (this.classifyContainer(instance) === "mine") {
          routing = "mine";
        } else {
          // An immutable FOREIGN instance label always wins over lease
          // contents. A stale lease naming this process must never turn a
          // replacement container owned by another instance into "mine".
          // The sole exception is a positively verified quarantine marker:
          // quarantined containers are unusable and intentionally age-routed.
          const marker = await this.readQuarantineMarker(task);
          if (marker === "quarantined") routing = "age";
          else if (marker === "unreadable") routing = "skip";
          else {
            const lease = await this.readLease(task, name);
            const leaseFresh =
              lease.kind === "valid" &&
              Date.now() - lease.updatedAt <= this.leaseTtlMs;
            if (
              this.classifyContainer(instance) === "foreign" &&
              lease.kind === "valid" &&
              lease.instanceId === this.instanceId
            ) {
              // A local lease cannot override a foreign immutable label.
              // This is replacement ambiguity, so skip without heartbeat.
              routing = "skip";
            } else if (
              lease.kind === "valid" &&
              lease.instanceId === this.instanceId
            ) {
              // MY claim on an unlabeled container — fresh OR STALE: I
              // am the adopter (a peer's re-adoption would have had to
              // take the fence and re-stamped the lease with ITS id), so
              // my activity record (and my own lease, for a restarted
              // adopter) drives the TTL decision. A stale claim of mine
              // must NOT flip the routing to "age": a live-but-idle
              // adopter with fresh process-local activity would then be
              // reaped by its own reaper.
              routing = "mine";
            } else if (
              lease.kind === "corrupt" ||
              lease.kind === "unreadable" ||
              leaseFresh
            ) {
              routing = "skip";
            } else {
              routing = "age";
            }
          }
        }
        if (routing === "skip") {
          // Leave it to the owning instance's reaper (never touch its
          // lease file either).
          continue;
        }
        const inspected = await this.docker(
          ["inspect", "--format", "{{.Created}}", id],
          15_000,
          20_000,
        );
        if (inspected.code !== 0 || inspected.timedOut) continue;
        const normalized = inspected.stdout
          .trim()
          .replace(/(\.\d{1,3})\d*Z$/, "$1Z");
        const created = Date.parse(normalized);
        if (!Number.isFinite(created)) continue;
        const lastActivity = this.taskActivity.get(task);
        // Abandoned = no provider operation for longer than the TTL. When
        // no activity is recorded (e.g. the provider process restarted),
        // fall back to the container's age — or, for my own containers,
        // my lease freshness (a restarted provider's own leases still
        // keep the container alive and get refreshed by idle sweeps).
        // For a taken-over (non-mine) container there is NO shared
        // activity across instances, so the age alone is the signal.
        let reference: number;
        if (routing === "mine") {
          reference = lastActivity ?? created;
          if (lastActivity === undefined) {
            const ownLease = await this.readLease(task, name);
            if (
              ownLease.kind === "valid" &&
              ownLease.instanceId === this.instanceId
            ) {
              reference = Math.max(reference, ownLease.updatedAt);
            }
          }
        } else {
          reference = created;
        }
        if (Date.now() - reference <= this.ttlMs) {
          // Not yet old enough. For my own containers, still refresh the
          // liveness claim (idle-owner heartbeats) — under the fence, so
          // it can never interleave with another instance's destructive
          // decision. A reaper that cannot acquire the fence simply
          // skips the heartbeat (fail closed: it also skips removals).
          if (routing === "mine") {
            await this.withReaperTaskOperation(task, async (fence) => {
              const prev = await this.readLease(task, name);
              const gen = prev.kind === "valid" ? prev.generation : "";
              await this.writeLease(task, name, fence, gen);
            });
          }
          continue;
        }
        // DESTRUCTIVE PATH: the per-task queue is entered first (so an
        // operation enqueued on THIS instance trips the activity check
        // below before any wait), and the cross-instance fence is
        // acquired at the queue head (a reaper that cannot get it skips
        // this interval — fail closed; a held fence means an owner
        // operation is in flight), held for the whole check-and-rm
        // sequence, so no instance can change ownership, refresh its
        // lease, or replace the container between the liveness check
        // and the rm.
        await this.withReaperTaskOperation(task, async (fence, myTail) => {
          const fresh = this.taskActivity.get(task);
          if (fresh !== undefined && Date.now() - fresh <= this.ttlMs) {
            return;
          }
          if (routing === "mine") {
            // Heartbeat under the fence: peer reapers (and peers'
            // age checks) serializing on the same fence see this
            // lease while holding it. Preserve the existing
            // generation (a heartbeat never mints a new generation).
            const prev = await this.readLease(task, name);
            const gen = prev.kind === "valid" ? prev.generation : "";
            await this.writeLease(task, name, fence, gen);
          }
          // OWNERSHIP + IDENTITY RE-CHECK, INSIDE THE FENCE, bound to
          // the row's IMMUTABLE container ID: this is what closes the
          // ps → inspect → rm replacement window. The inspect targets
          // the ID (never the reusable name) and the row's labels must
          // still match what `docker ps` reported — a replacement
          // container created under the same task name has a DIFFERENT
          // id, so either the inspect misses (missing/unknown: skip)
          // or the labels disagree (skip). The rm below can therefore
          // only ever hit the exact container this sweep decided on.
          const recheck = await this.inspectContainer(id, fence);
          if (recheck.kind !== "exists") {
            // missing (already gone) or unknown (daemon state
            // unknown — fail closed): nothing to remove here. Only a
            // definitive no-such-object may drop the bookkeeping; an
            // UNKNOWN result leaves everything for the next interval.
            if (recheck.kind === "missing") {
              this.taskActivity.delete(task);
              const goneLease = await this.readLease(task, name);
              await this.deleteLease(
                task,
                name,
                fence,
                goneLease.kind === "valid" ? goneLease.generation : undefined,
              );
              if (quarantinedRow) {
                await this.deleteQuarantineMarker(task, fence);
              }
            }
            return;
          }
          if (
            (recheck.taskLabel !== NO_LABEL && recheck.taskLabel !== task) ||
            (instance !== undefined && recheck.instanceLabel !== instance)
          ) {
            // The id no longer describes the row we routed on (a
            // replacement under the same name, or a label change the
            // API cannot produce): do not touch it. (Rows without an
            // instance column — the 2-column injected shape — cannot
            // compare the instance label; the immutable-ID inspect
            // already binds the identity there.)
            return;
          }
          let expectedGeneration: string | undefined;
          if (routing === "age" && !quarantinedRow) {
            // Re-check liveness immediately before the destructive
            // call, INSIDE THE FENCE: a live owner cannot have
            // refreshed its lease while this sweep waited (its write
            // is also gated by the fence), so this recheck has no
            // TOCTOU window left. A quarantined row is exempt: the
            // container is unusable by definition.
            const leaseNow = await this.readLease(task, name);
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
            expectedGeneration =
              leaseNow.kind === "valid" ? leaseNow.generation : undefined;
            // A foreign host-side marker that appeared since routing
            // means a concurrent quarantine: the row was routed
            // "age" anyway (it is unusable), so removal proceeds —
            // same outcome its owner's destroy() would reach.
          } else {
            const leaseNow = await this.readLease(task, name);
            expectedGeneration =
              leaseNow.kind === "valid" ? leaseNow.generation : undefined;
          }
          // Final in-process gate, checked immediately before the
          // destructive call: the queue tail changes on every
          // enqueue, so an unchanged tail proves no operation of
          // THIS provider queued after this removal took the lock
          // (cross-process ordering is the fence held above).
          if (this.taskLocks.get(task) !== myTail) return;
          // FENCE RE-VALIDATION immediately before the destructive rm:
          // fencedDocker re-asserts the token (a reaper that lost its
          // fence to a stale-break throws here and NEVER removes), and
          // the rm targets the immutable ID re-inspected above.
          const removed = await this.fencedDocker(
            fence,
            ["rm", "-f", recheck.id],
            this.opTimeout(30_000),
            20_000,
          );
          if (
            !removed.timedOut &&
            (removed.code === 0 || /no such container/i.test(removed.stderr))
          ) {
            // The container is gone (or already was): the activity
            // record no longer pins anything, so it is dropped. The
            // lease deletion is GENERATION-AWARE (the generation read
            // IN THIS FENCE is the expectation, so a lease that
            // changed between the read and the deletion attempt — the
            // replacement-owner race — is captured, verified, and
            // RESTORED rather than unlinked). The marker is dropped
            // only while the fence is still live.
            this.taskActivity.delete(task);
            await this.deleteLease(task, name, fence, expectedGeneration);
            if (await this.checkFenceLive(fence)) {
              await this.deleteQuarantineMarker(task, fence);
            }
          }
          // A FAILED removal must NOT drop the activity record: the
          // container is still here; leave it for the next interval.
        });
      }
    } finally {
      this.reaperRunning = false;
    }
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
