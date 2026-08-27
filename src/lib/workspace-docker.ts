import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
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
 *   hundred bytes of lease files. Lease file I/O is best-effort: a
 *   failed write never fails an operation (degraded liveness
 *   detection), and a corrupt/torn lease file is treated as "cannot
 *   prove death" (strict — the task is left alone), never as "dead";
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
   * lock whose metadata is older than the TTL (a process that died
   * holding it) is broken by the next acquirer; same-host clock skew is
   * nil because the lock is host-local.
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
   * operations proceed even if the fence cannot be acquired because the
   * lease directory itself is unusable — the reaper fails closed in that
   * case (it cannot acquire the fence either), so no destructive race
   * opens.
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
 * `active` is false for a degraded fence (the lease directory is
 * unusable): owner operations proceed, the reaper skips.
 */
interface HeldFence {
  taskId: string;
  token: string;
  active: boolean;
  release: () => Promise<void>;
}

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
    this.instanceId = options.instanceId ?? randomUUID();
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
    // OWNERSHIP GATE BEFORE ANY DESTRUCTIVE CALL (under the cross-
    // instance fence, so no peer can change the result between this
    // probe and the rm below): a container may already exist under the
    // normal name (a previous attempt by this or another instance). The
    // label is verified (the name alone is not proof of which task the
    // container was created for), and a container owned by ANOTHER live
    // instance must never be rm'd here — removing it would destroy that
    // instance's live workspace. A quarantined-name container (any
    // owner) is not gated: it is unusable by definition.
    const existing = await this.inspectContainer(name);
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
      // container — so replacing it is safe. An unlabeled RUNNING
      // container that a peer ADOPTED concurrently is also foreign by
      // fence: adoption takes the same fence, so this create could not
      // have passed the gate while the peer's open held it — and the
      // rm below runs while THIS call still holds the fence, so a peer
      // adopting afterwards sees the container gone and fails cleanly.
      if (
        this.classifyContainer(existing.instanceLabel) === "foreign" &&
        existing.running
      ) {
        throw new Error(WORKSPACE_OWNED);
      }
    }
    // Note: a previous quarantine is NOT cleared here. Setup (start,
    // source staging, reaper installation, git baseline) must complete
    // first — if it fails and the container cannot be removed, the
    // container is half-initialized and MUST be quarantined, not left
    // reusable for a later open().
    // cleanupAll also removes a surviving QUARANTINED container renamed
    // by a previous quarantine — a replacement must not leave it behind
    // (it holds quota) and must start from a clean name.
    await this.cleanupAll(taskId);
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
      // `docker create` is INSIDE the setup coverage: a CLI-level failure
      // or timeout here is an UNCERTAIN side effect — the daemon may have
      // accepted the container, which then exists half-initialized under
      // the normal name. The catch below covers exactly that: remove the
      // container if it can be removed, QUARANTINE it if it cannot, so a
      // leaked half-initialized container is never openable — by this
      // instance or any other.
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
      // Setup failed — including the `docker create` call itself, whose
      // failure/timeout is an UNCERTAIN side effect (the daemon may hold
      // a half-initialized container under the normal name). Quarantine
      // UNCONDITIONALLY while the fence is still held: quarantineTask
      // removes the container if it can (best-effort) and otherwise
      // makes the quarantine durable (host marker + daemon rename +
      // checked stop fallback), so no instance can open a half-
      // initialized workspace. The previous behavior of skipping the
      // quarantine when the follow-up inspect itself failed is gone —
      // an UNKNOWN inspect result must never suppress the durable
      // marker. If the removal succeeded the marker/flag are cleared
      // again by quarantineTask's own cleanup path. The original setup
      // error wins.
      await this.quarantineTask(taskId, fence);
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
    await this.deleteQuarantineMarker(taskId);
    await this.writeLease(taskId, name, fence);
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
    const inspected = await this.inspectContainer(name);
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
          if (existing.kind === "unreadable") {
            // A claim we cannot read is a claim we cannot supersede —
            // fail closed.
            throw new Error(WORKSPACE_UNDETERMINED);
          }
          await this.writeLease(taskId, name, fence);
        }
        // RE-PROBE under the fence before handing out a handle: the
        // container and its name can only have changed behind another
        // fence holder, which cannot exist here, so this is defense in
        // depth (and it also catches a container stopped between the
        // two awaits).
        const claim = await this.inspectContainer(name);
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
    await this.gateHandleOperation(workspace.id, fence);
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
    await this.gateHandleOperation(workspace.id, fence);
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
    await this.gateHandleOperation(workspace.id, fence);
    if (isSensitivePath(relativePath)) {
      throw new Error("Writing sensitive paths is blocked");
    }
    const absolute = this.safeContainerPath(relativePath);
    await this.prepareWriteParents(workspace, absolute);
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
      const archived = await this.docker(
        ["-cf", archive, "-C", scratch, "--", relativePath],
        30_000,
        20_000,
        "tar",
      );
      if (archived.code !== 0) {
        throw new Error("Could not stage workspace file");
      }
      const extracted = await this.docker(
        [
          "exec",
          "-i",
          "--user",
          this.user,
          "--workdir",
          "/workspace",
          this.containerName(workspace.id),
          "tar",
          "-xf",
          "-",
          "-C",
          "/workspace",
        ],
        30_000,
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
    await this.gateHandleOperation(workspace.id, fence);
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
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.listChangedFilesCore(workspace, fence),
    );
  }

  private async listChangedFilesCore(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<ChangedFile[]> {
    await this.gateHandleOperation(workspace.id, fence);
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
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.gitDiffCore(workspace, fence),
    );
  }

  private async gitDiffCore(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<string> {
    await this.gateHandleOperation(workspace.id, fence);
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
    this.taskActivity.set(workspace.id, Date.now());
    return this.withOwnerTaskOperation(workspace.id, (fence) =>
      this.gitStatusCore(workspace, fence),
    );
  }

  private async gitStatusCore(
    workspace: WorkspaceHandle,
    fence: HeldFence,
  ): Promise<string> {
    await this.gateHandleOperation(workspace.id, fence);
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
    await this.gateHandleOperation(workspace.id, fence);
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
        workspace,
        ["timeout", "--signal=KILL", String(timeoutSeconds), ...executable],
        this.timeoutMs + 15_000,
        this.outputLimitBytes,
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
        await this.runReaperOrQuarantine(workspace.id, started, fence);
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
    await this.runReaperOrQuarantine(workspace.id, started, fence);
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
    taskId: string,
    started: number,
    fence: HeldFence,
  ): Promise<void> {
    const handle: WorkspaceHandle = { id: taskId, root: "/workspace" };
    let cleaned: DockerRunResult;
    try {
      cleaned = await this.execIn(
        handle,
        ["node", "/reap/validation-reap.mjs", String(started)],
        30_000,
        20_000,
      );
    } catch {
      await this.quarantineTask(taskId, fence);
      throw new Error("Could not complete validation cleanup");
    }
    if (cleaned.code !== 0) {
      await this.quarantineTask(taskId, fence);
      throw new Error("Could not complete validation cleanup");
    }
  }

  /**
   * Quarantine a task after a failed validation cleanup: mark it so every
   * later operation rejects with the quarantine error (see
   * quarantinedTasks), and destroy the container immediately —
   * best-effort: if the removal itself fails, the flag persists
   * (operations still reject) and the TTL reaper / operator is the
   * backstop for the container.
   */
  private async quarantineTask(
    taskId: string,
    fence?: HeldFence,
  ): Promise<void> {
    // The flag PERSISTS regardless of the cleanup outcome below: a
    // failed validation/create marks the TASK untrusted for this
    // instance; explicit destroy()/create() are the only operations
    // that clear it. (The old code dropped it on a successful immediate
    // removal — pointless, since there was no container left to open,
    // but keeping the flag set means a late open() racing this entry
    // rejects inside the same instance as well.)
    this.quarantinedTasks.add(taskId);
    // Publish the HOST-SIDE durable marker FIRST, before any docker
    // call: it is what blocks open() on a restarted or second instance
    // (same identity or different) when the daemon-side markers below
    // cannot be established.
    await this.writeQuarantineMarker(taskId);
    const normalName = this.containerName(taskId);
    const qName = this.quarantinedContainerName(taskId);
    // Best-effort removal first (the original behavior: the container
    // is destroyed immediately when the daemon cooperates). A FAILED
    // removal must throw nowhere — the durable-marker steps below are
    // the fail-closed path, and the caller's original error wins.
    const removed = await this.cleanupAll(taskId).then(
      () => true,
      () => false,
    );
    if (removed) {
      const normalProbe = await this.inspectContainer(normalName);
      const qProbe = await this.inspectContainer(qName);
      if (normalProbe.kind === "missing" && qProbe.kind === "missing") {
        // Nothing left under either name: retire the host marker. The
        // in-memory flag stays (the task itself is still quarantined
        // for this instance until explicit teardown/replacement). The
        // lease removal is generation-aware (never a replacement
        // owner's fresh lease — the fence serializes destroy/create,
        // and the token check is defense in depth).
        await this.deleteQuarantineMarker(taskId);
        this.taskActivity.delete(taskId);
        await this.deleteLease(taskId, normalName, fence);
        return;
      }
      if (qProbe.kind === "exists") {
        // A surviving RENAMED container (from a previous quarantine):
        // the daemon-side name carries the quarantine. The fresh
        // removal target did not exist, so fall through to the durable
        // handling below to keep the state coherent.
        await this.deleteQuarantineMarker(taskId);
        return;
      }
      // An UNKNOWN inspect, or a container still under the normal
      // name despite a "successful" cleanup (a daemon reporting
      // success loosely): fall through and make the durable marker —
      // fail closed.
    }
    // The container SURVIVED (or its state is uncertain): the in-memory
    // flag alone would be forgotten by a provider restart or a second
    // provider instance, whose open() would hand out this live,
    // untrusted container. So the quarantine is made DURABLE in the
    // daemon: the container is renamed to <name>-quarantined (see
    // QUARANTINED_SUFFIX). A rename is a supported Docker operation on
    // a running OR stopped container, the new name lives in the daemon
    // (surviving restarts and instance changes), and the container is
    // no longer reachable by its task name — every instance's open()
    // probes for the renamed name and rejects (see openCore). The
    // creation-time labels survive the rename, so the TTL reaper (any
    // instance) still lists and reaps it by its managed label.
    const renamed = await this.docker(
      ["rename", normalName, qName],
      30_000,
      20_000,
    );
    if (renamed.code === 0) {
      // The daemon-side marker now carries the quarantine durably; the
      // host marker is redundant and would only go stale.
      await this.deleteQuarantineMarker(taskId);
      return;
    }
    if (/no such container/i.test(renamed.stderr)) {
      // The old name is already gone: either a prior quarantine already
      // moved it (the renamed container is the durable marker) or
      // nothing remains. Verify under the fence which case we are in;
      // an UNKNOWN inspect result keeps the host marker (fail closed).
      const qProbe = await this.inspectContainer(qName);
      if (qProbe.kind === "exists") {
        await this.deleteQuarantineMarker(taskId);
        return;
      }
      if (qProbe.kind === "missing") {
        const normalProbe = await this.inspectContainer(normalName);
        if (normalProbe.kind === "missing") {
          // Nothing under either name: drop the host marker; the
          // in-memory flag persists (the task remains quarantined for
          // this instance until explicit teardown/replacement).
          await this.deleteQuarantineMarker(taskId);
          this.taskActivity.delete(taskId);
        }
        // "exists"/"unknown": keep the host marker — fail closed.
      }
      return;
    }
    // The rename failed for a reason other than "the original name is
    // already gone". The container KEEPS its normal name, so a
    // restarted or second provider could otherwise see a RUNNING
    // container under the task name and open it. Fail closed with a
    // second supported operation: STOP the container. A stopped
    // container reports Running=false, so EVERY instance's open()
    // rejects it without any process-local state, while destroy() and
    // the reaper can still `rm -f` it when the daemon cooperates.
    const stopped = await this.docker(["stop", normalName], 30_000, 20_000);
    if (stopped.code !== 0 && /no such container/i.test(stopped.stderr)) {
      // The container vanished between the rename attempt and the stop:
      // the reaper or another holder removed it. Confirm before
      // clearing; unknown results keep the marker.
      const probe = await this.inspectContainer(normalName);
      if (probe.kind === "missing") {
        const qProbe = await this.inspectContainer(qName);
        if (qProbe.kind === "missing") {
          await this.deleteQuarantineMarker(taskId);
          this.taskActivity.delete(taskId);
        }
      }
      return;
    }
    // The stop's exit code is NOT proof of the container's state: a
    // CLI-level timeout/transport failure reports nonzero (or the
    // process may report success ambiguously), and a daemon that
    // refused the rename may be unwell. CONFIRM the running state with
    // an inspect before deciding whether the host marker may be
    // retired: only a container that is definitively stopped (or gone)
    // is safe without the host-side marker; a still-RUNNING container,
    // or an UNKNOWN inspect result, keeps the host marker — open()
    // must keep rejecting it on every instance, including a restarted
    // provider with the SAME instance identity (which would otherwise
    // see its own RUNNING container and reopen it).
    const state = await this.inspectContainer(normalName);
    if (state.kind === "missing") {
      const qProbe = await this.inspectContainer(qName);
      if (qProbe.kind === "missing") {
        await this.deleteQuarantineMarker(taskId);
        this.taskActivity.delete(taskId);
      } else if (qProbe.kind === "exists") {
        await this.deleteQuarantineMarker(taskId);
      }
      // Unknown: keep host marker.
      return;
    }
    if (state.kind === "exists" && !state.running) {
      // Confirmed stopped: Running=false is the daemon-side,
      // cross-instance "do not use" state (openCore rejects stopped
      // containers regardless of owner — including a same-identity
      // restart). The host marker is retired; the TTL reaper removes
      // the stopped container by age.
      await this.deleteQuarantineMarker(taskId);
      return;
    }
    // state.kind === "unknown", or the container is confirmed RUNNING
    // after a failed/ambiguous stop: the host marker STAYS (it was
    // written above) and blocks every open() until an explicit
    // destroy()/create() or a successful later quarantine. The TTL
    // reaper is the backstop (it reaps quarantine-marked tasks by age).
  }

  private assertNotQuarantined(taskId: string): void {
    if (this.quarantinedTasks.has(taskId)) {
      throw new Error(QUARANTINE_ERROR);
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
  ): Promise<void> {
    this.assertNotQuarantined(taskId);
    const marker = await this.readQuarantineMarker(taskId);
    if (marker !== "absent") {
      this.quarantinedTasks.add(taskId);
      throw new Error(QUARANTINE_ERROR);
    }
    const inspected = await this.inspectContainer(this.containerName(taskId));
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
    void fence;
  }

  /**
   * Destroy the task container; its tmpfs workspace is removed with it. Call
   * when a task reaches a terminal state; the reaper is the backstop for
   * abandoned tasks. Also the explicit teardown that clears a quarantine
   * (see quarantinedTasks) — the flag persists if the removal fails.
   * cleanupAll removes the container under EITHER name, so a quarantined
   * (renamed) container is actually destroyed here, not orphaned.
   */
  async destroy(taskId: string): Promise<void> {
    if (!isValidTaskId(taskId)) throw new Error("Invalid task identifier");
    // recordActivity=false: destruction clears a workspace, so it must
    // never record liveness — neither enqueue nor completion may touch
    // activity or the lease (the old code deleted the lease and then
    // re-wrote it during completion refresh; the delete below is
    // generation-aware).
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
    const existing = await this.inspectContainer(name);
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
    }
    await this.cleanupAll(taskId);
    // The removal was checked (cleanupAll throws on a failed rm): the
    // task's container is gone under BOTH names, so its quarantine is
    // over too. Clear bookkeeping and the durable marker; the lease
    // deletion is generation-aware (names this instance AND this
    // container) so a replacement owner's fresh lease can never be
    // unlinked — and the fence additionally serializes this against any
    // concurrent create/open. destroy records no activity and refreshes
    // no lease: nothing must resurrect the workspace's liveness claim.
    this.quarantinedTasks.delete(taskId);
    this.taskActivity.delete(taskId);
    await this.deleteQuarantineMarker(taskId);
    await this.deleteLease(taskId, name, fence);
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
  private async inspectContainer(name: string): Promise<
    | { kind: "missing" }
    | { kind: "unknown" }
    | {
        kind: "exists";
        running: boolean;
        taskLabel: string;
        instanceLabel: string;
      }
  > {
    let result: DockerRunResult;
    try {
      result = await this.docker(
        [
          "inspect",
          "--format",
          '{{.State.Running}}|{{index .Config.Labels "valmont.task"}}|{{index .Config.Labels "valmont.instance"}}',
          name,
        ],
        15_000,
        this.outputLimitBytes,
      );
    } catch {
      // The CLI itself failed to spawn/report (transport): existence is
      // unknown.
      return { kind: "unknown" };
    }
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
    if (parts.length !== 3 || (parts[0] !== "true" && parts[0] !== "false")) {
      // An unparsable successful response is not proof of anything.
      return { kind: "unknown" };
    }
    return {
      kind: "exists",
      running: parts[0] === "true",
      taskLabel: parts[1] ?? "",
      instanceLabel: parts[2] ?? "",
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
   * Read this task's lease. The result is a DISCRIMINATED union:
   * - "absent": the file provably does not exist (ENOENT only — a missing
   *   leaseDir collapses to this as well);
   * - "unreadable": the file EXISTS but cannot be read (EACCES, EIO, a
   *   broken mount, ...) — ownership cannot be determined, so every
   *   destructive decision fails closed to "skip", NEVER to age-reap
   *   (an unreadable lease is not evidence the owner is gone);
   * - "corrupt": readable but semantically invalid (a torn write, wrong
   *   types, empty instance id, NaN/negative/insane/future-dated
   *   timestamp, or task/container identity that does not match) — also
   *   fail closed to "skip";
   * - "valid": a fully validated lease.
   * A lease that is unreadable or corrupt is NEVER treated as
   * "owner dead" — only "cannot prove liveness" (the strict side).
   */
  private async readLease(
    taskId: string,
    expectedContainerName?: string,
  ): Promise<
    | { kind: "absent" }
    | { kind: "unreadable" }
    | { kind: "corrupt" }
    | { kind: "valid"; instanceId: string; updatedAt: number }
  > {
    if (!this.leaseDir) return { kind: "absent" };
    let raw: string;
    try {
      raw = await readFile(this.leasePath(taskId), "utf8");
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
    const candidate = parsed as {
      instanceId?: unknown;
      updatedAt?: unknown;
      containerName?: unknown;
      taskId?: unknown;
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
    return {
      kind: "valid",
      instanceId: candidate.instanceId,
      updatedAt: ts,
    };
  }

  /**
   * Best-effort lease write (a liveness claim for this task, held by THIS
   * instance and the current container generation). Never throws: a
   * failed write must not fail the operation — it only degrades liveness
   * detection (at worst another instance treats the task as dead after
   * the lease TTL). The publication is atomic: a UNIQUE temp file name
   * (two concurrent writers — same or different instances — must not
   * share a temp name) is written then atomically renamed over the lease
   * path, so a crashed writer leaves either the previous lease or the
   * new one, never a torn file (a torn file reads as "corrupt" = strict,
   * never "dead"). Callers that already hold the cross-instance task
   * fence pass it so no re-entrant lock is attempted.
   */
  private async writeLease(
    taskId: string,
    containerName: string,
    fence?: HeldFence,
  ): Promise<void> {
    if (!this.leaseDir) return;
    const releaseAfter = !fence;
    const held: HeldFence | null = fence
      ? fence
      : await this.acquireTaskFence(taskId, "owner");
    try {
      // A null fence means the lease directory itself is unusable: the
      // write cannot land, and the reaper is degraded symmetrically (it
      // cannot acquire the fence either and skips all removals) — safe.
      if (!held) return;
      const payload = JSON.stringify({
        instanceId: this.instanceId,
        updatedAt: Date.now(),
        containerName,
        taskId,
      });
      await mkdir(this.leaseDir, { recursive: true });
      // Unique temporary name per write: instance + pid + random suffix.
      const tmp = path.join(
        this.leaseDir,
        `.${taskId}.lease.${this.instanceId.slice(0, 8)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.leasePath(taskId));
    } catch {
      // best-effort liveness signal; never fail the operation.
    } finally {
      if (releaseAfter && held) await held.release();
    }
  }

  /**
   * Best-effort, GENERATION-AWARE lease deletion. The lease is removed
   * only when it is absent/unreadable OR names THIS instance AND the
   * expected current container. A fresh lease written by a replacement
   * owner (another instance that created a new container between this
   * teardown's check and now — possible only when this call does not
   * hold the fence) is never deleted: the fencing in destroy/create
   * makes that state unreachable through the normal paths, and this
   * token check is the defense in depth. Unreadable leases stay in
   * place (failing closed rather than unlinking a state we could not
   * read).
   */
  private async deleteLease(
    taskId: string,
    expectedContainerName?: string,
    fence?: HeldFence,
  ): Promise<void> {
    if (!this.leaseDir) return;
    const releaseAfter = !fence;
    const held: HeldFence | null = fence
      ? fence
      : await this.acquireTaskFence(taskId, "reaper");
    try {
      if (!held) return;
      const lease = await this.readLease(taskId, expectedContainerName);
      if (lease.kind === "absent") return;
      if (lease.kind === "unreadable" || lease.kind === "corrupt") return;
      if (lease.instanceId !== this.instanceId) return;
      await rm(this.leasePath(taskId), { force: true });
    } catch {
      // best-effort
    } finally {
      if (releaseAfter && held) await held.release();
    }
  }

  /**
   * Best-effort write of the durable, host-side quarantine marker.
   * Atomic (unique temp + rename), mode 0600. Survives restarts of this
   * provider and is visible to every instance sharing the lease dir.
   */
  private async writeQuarantineMarker(taskId: string): Promise<void> {
    if (!this.leaseDir) return;
    try {
      await mkdir(this.leaseDir, { recursive: true });
      const payload = JSON.stringify({
        taskId,
        instanceId: this.instanceId,
        quarantinedAt: Date.now(),
      });
      const tmp = path.join(
        this.leaseDir,
        `.${taskId}.quarantined.${randomUUID()}.tmp`,
      );
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.quarantineMarkerPath(taskId));
    } catch {
      // best-effort: the daemon-side rename/stop markers carry the
      // quarantine where the host file cannot be written.
    }
  }

  /** Best-effort removal of the durable quarantine marker. */
  private async deleteQuarantineMarker(taskId: string): Promise<void> {
    if (!this.leaseDir) return;
    try {
      await rm(this.quarantineMarkerPath(taskId), { force: true });
    } catch {
      // best-effort
    }
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
      await readFile(this.quarantineMarkerPath(taskId), "utf8");
      return "quarantined";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return "absent";
      if (code === "EACCES" || code === "EISDIR") return "quarantined";
      return "unreadable";
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
   * identity). A lock whose directory is older than fenceLockTtlMs (a
   * process that DIED holding it — the mtime is read twice with a gap
   * to avoid breaking a lock being actively taken over by a peer) is
   * broken with an rmdir of the EMPTY lock directory; a non-empty lock
   * (a token file is present) can never be removed by anyone other
   * than its holder.
   *
   * Returns a released-or-null fence when the lease directory itself is
   * unusable (unwritable/unreadable leaseDir): owner operations proceed
   * best-effort in that degraded mode, while the reaper gets null too
   * and therefore skips every destructive action — no cross-instance
   * race can open.
   */
  private async acquireTaskFence(
    taskId: string,
    role: "owner" | "reaper",
  ): Promise<HeldFence | null> {
    if (!this.leaseDir) return null;
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
    for (;;) {
      try {
        // Atomic claim: mkdir on the lock path succeeds for exactly one
        // process on one host (the parent .locks directory is created
        // first, recursively and idempotently).
        await mkdir(path.join(this.leaseDir!, ".locks"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(lockDir, { mode: 0o700 });
        // We own it: write our token file so a stale-break can verify
        // the holder (and so the directory is never empty mid-hold).
        await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
        return {
          taskId,
          token,
          active: true,
          release: async () => {
            await this.releaseTaskFence(lockDir, tokenFile);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          // EROFS/EACCES/ENOENT(on leaseDir) — the coordination
          // directory itself is unusable. Callers fail safe.
          return null;
        }
        // Held by a peer (or a crashed one). Break the lock if it is
        // stale: directory mtime older than the TTL, read twice with a
        // short gap (a peer taking the lock over at that instant bumps
        // the mtime), AND no lock holder present by the time of the
        // removal (rmdir only succeeds when EMPTY, so removing a live
        // peer's token-bearing lock fails harmlessly).
        const stale = await this.fenceIsStale(lockDir);
        if (stale) {
          // The holder is presumed dead (mtime predates the lock TTL;
          // this host shares one clock and one filesystem with the
          // lease dir). Take over by removing the dead holder's token
          // and the lock directory: the token read FIRST proves the
          // same identity is still on disk before the rmdir, so a lock
          // a peer acquired at this exact instant (fresh directory
          // entry, fresh mtime) is never touched.
          const broke = await this.breakStaleFence(lockDir);
          if (broke) {
            await sleepMs(30);
            continue; // retry the mkdir immediately
          }
        }
        if (Date.now() >= deadline) {
          // The reaper treats this as "skip this container this
          // interval" (a holder means an operation is in flight);
          // owner operations have a wait longer than the lock TTL, so
          // reaching the deadline implies an unusable directory,
          // where proceeding best-effort is correct.
          return { taskId, token, active: false, release: async () => {} };
        }
        await sleepMs(role === "reaper" ? Math.min(200, waitMs / 4) : 200);
      }
    }
  }

  /**
   * Test-only: remove every fence lock under this provider's lease dir.
   * Production correctness never relies on it (stale locks break after
   * fenceLockTtlMs via the normal acquire loop); tests use it to keep
   * cross-instance scenarios deterministic when a prior assertion
   * aborted mid-operation.
   */
  async __testClearFences(): Promise<void> {
    if (!this.leaseDir) return;
    try {
      await rm(path.join(this.leaseDir, ".locks"), {
        recursive: true,
        force: true,
      });
    } catch {
      // best effort
    }
  }

  /** True when the fence directory's mtime predates the lock TTL (twice-read). */
  private async fenceIsStale(lockDir: string): Promise<boolean> {
    try {
      const first = await lstat(lockDir);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const second = await lstat(lockDir);
      const newest = Math.max(first.mtimeMs, second.mtimeMs);
      return Date.now() - newest > this.fenceLockTtlMs;
    } catch {
      return false;
    }
  }

  /**
   * Remove a stale fence: read the dead holder's token, then remove the
   * token file and lock DIRECTORY. The directory is only removed when it
   * contains exactly the single token expected from a dead holder (a
   * directory listing first guards against racing a fresh acquire, whose
   * token would differ — but whose directory mtime would by construction
   * be fresh and so fenceIsStale returned false). A failed cleanup
   * leaves the stale lock for the next sweep rather than erroring out.
   */
  private async breakStaleFence(lockDir: string): Promise<boolean> {
    try {
      const entries = await readdir(lockDir);
      if (entries.length !== 1) return false;
      const tokenPath = path.join(lockDir, entries[0]!);
      // Remove the dead holder's token file first, then the (now empty)
      // lock directory with a NON-RECURSIVE rmdir. If a peer re-acquired
      // in the window after the readdir, its fresh token makes the
      // directory non-empty: rmdir fails with ENOTEMPTY and the lock is
      // left for the retry loop (a recursive rm would sweep the peer's
      // fresh token — same double-holder hazard as releaseTaskFence).
      await rm(tokenPath, { force: true, retryDelay: 0, maxRetries: 0 });
      await rmdir(lockDir, { retryDelay: 0, maxRetries: 0 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release a held fence: remove our token, then remove the lock
   * directory ONLY with a non-recursive rmdir. The rmdir succeeds solely
   * when the directory is empty; if another acquirer recreated/reclaimed
   * it in the window between the token removal and this call, rmdir
   * fails (ENOTEMPTY/EEXIST) and the directory is left alone. A
   * recursive rm here was unsafe: between our token unlink and the
   * recursive removal, a waiter's mkdir could succeed and its fresh
   * token be swept away by our recursion — leaving the waiter believing
   * it holds the fence while another waiter then acquires the (now
   * recreated) lock, i.e. two simultaneous holders.
   */
  private async releaseTaskFence(
    lockDir: string,
    tokenFile: string,
  ): Promise<void> {
    try {
      await rm(tokenFile, { force: true, retryDelay: 0, maxRetries: 0 });
      await rmdir(lockDir, { retryDelay: 0, maxRetries: 0 });
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
   * break a stale lock). A degraded fence (coordination directory
   * unusable) still runs the body best-effort; the reaper is degraded
   * symmetrically and refuses every destructive action, so no
   * cross-instance race opens.
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
        const active: HeldFence = fence ?? {
          taskId,
          token: "degraded",
          active: false,
          release: async () => {},
        };
        try {
          return await fn(active);
        } finally {
          await fence?.release();
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
   * = "container left for a later interval", never a removal.
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
        if (!fence || !fence.active) {
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
    name: string,
  ): Promise<void> {
    const handle: WorkspaceHandle = { id: taskId, root: "/workspace" };
    const scratch = await mkdtemp(path.join(tmpdir(), "valmont-sandbox-file-"));
    const scriptPath = path.join(scratch, "validation-reap.mjs");
    try {
      await writeFile(scriptPath, VALIDATION_REAPER_SCRIPT, {
        encoding: "utf8",
        mode: 0o644,
      });
      const copied = await this.docker(
        ["cp", scriptPath, `${name}:/reap/validation-reap.mjs`],
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
    // to continue if the reaper mount or script is not exactly what the
    // create-time flags and the copy above produce.
    const checkedDir = await this.execIn(
      handle,
      ["stat", "-c", "%u %g %a", "/reap"],
      15_000,
      20_000,
      "root",
    );
    if (checkedDir.code !== 0 || checkedDir.stdout.trim() !== "0 0 701") {
      throw new Error("Could not verify the validation reaper directory");
    }
    const checkedScript = await this.execIn(
      handle,
      ["stat", "-c", "%u %g %a %F", "/reap/validation-reap.mjs"],
      15_000,
      20_000,
      "root",
    );
    if (
      checkedScript.code !== 0 ||
      checkedScript.stdout.trim() !== "0 0 644 regular file"
    ) {
      throw new Error("Could not verify the validation reaper script");
    }
  }

  private async stageSource(taskId: string, sourceRoot: string): Promise<void> {
    const name = this.containerName(taskId);
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
      const archived = await this.docker(
        ["-cf", archive, "-C", staging, "--", "."],
        300_000,
        20_000,
        "tar",
      );
      if (archived.code !== 0) {
        throw new Error(
          `Could not archive workspace source: ${archived.stderr.trim() || archived.code}`,
        );
      }
      const extracted = await this.docker(
        [
          "exec",
          "-i",
          "--user",
          this.user,
          "--workdir",
          "/workspace",
          name,
          "tar",
          "-xf",
          "-",
          "-C",
          "/workspace",
        ],
        300_000,
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
      const archived = await this.docker(
        ["-cf", archive, "-C", scratch, "--", ".git/info/exclude"],
        30_000,
        20_000,
        "tar",
      );
      if (archived.code !== 0) {
        throw new Error("Could not configure workspace git exclusions");
      }
      const extracted = await this.docker(
        [
          "exec",
          "-i",
          "--user",
          this.user,
          "--workdir",
          "/workspace",
          name,
          "tar",
          "-xf",
          "-",
          "-C",
          "/workspace",
        ],
        30_000,
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
    workspace: WorkspaceHandle,
    componentPath: string,
  ): Promise<string | null> {
    const checked = await this.execIn(
      workspace,
      ["stat", "-c", "%F", componentPath],
      15_000,
      20_000,
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
    workspace: WorkspaceHandle,
    argv: readonly string[],
    timeoutMs: number,
    limitBytes: number,
    user: string = this.user,
  ): Promise<DockerRunResult> {
    const result = await this.docker(
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

  /** Remove the task container (checked: a failed rm throws). */
  /**
   * Remove the task container (checked: a failed rm throws).
   */
  private async cleanup(taskId: string): Promise<void> {
    const removed = await this.docker(
      ["rm", "-f", this.containerName(taskId)],
      30_000,
      20_000,
    );
    // Check the result: reporting a removal as successful while the
    // container still exists would leak a quota-bound container (and, for
    // destroy(), lie about the workspace being gone). A not-found result
    // is fine — there is nothing to remove.
    if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
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
   * Throws if either removal fails for a reason other than not-found.
   */
  private async cleanupAll(taskId: string): Promise<void> {
    await this.cleanup(taskId);
    await this.removeQuarantinedContainer(taskId);
  }

  /** Remove a surviving quarantined container (checked; not-found is fine). */
  private async removeQuarantinedContainer(taskId: string): Promise<void> {
    const removed = await this.docker(
      ["rm", "-f", this.quarantinedContainerName(taskId)],
      30_000,
      20_000,
    );
    if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
      throw new Error(
        `Could not remove quarantined sandbox container: ${
          removed.stderr.trim() || removed.code
        }`,
      );
    }
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
      if (listed.code !== 0) return;
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
          // A managed container whose label is not a valid task identifier
          // (including the reserved quarantine suffix, which no valid task
          // may hold) has no queue to go through; remove it directly. The
          // result is checked: a failed removal must not be treated as
          // done — it simply leaves the container for the next interval
          // (there is no queue or activity record for an invalid label to
          // update). Either way the loop must NOT fall through to the
          // task-queue logic below, which assumes a valid task label.
          const removed = await this.docker(["rm", "-f", id], 30_000, 20_000);
          if (
            removed.code !== 0 &&
            !/no such container/i.test(removed.stderr)
          ) {
            // rm failed: the container is still present; retry next
            // interval.
          }
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
          // A host-side quarantine marker written by ANY instance makes
          // the container unusable by definition (it is the stop-fallback
          // state across instances and restarts): route by age.
          const marker = await this.readQuarantineMarker(task);
          if (marker === "quarantined") routing = "age";
          else if (marker === "unreadable") routing = "skip";
          else {
            const lease = await this.readLease(task, name);
            const leaseFresh =
              lease.kind === "valid" &&
              Date.now() - lease.updatedAt <= this.leaseTtlMs;
            if (leaseFresh && lease.instanceId === this.instanceId) {
              // My takeover claim on an unlabeled container: I operate on
              // it, so my activity record drives the decision.
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
        if (inspected.code !== 0) continue;
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
              await this.writeLease(task, name, fence);
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
          {
            const fresh = this.taskActivity.get(task);
            if (fresh !== undefined && Date.now() - fresh <= this.ttlMs) {
              return;
            }
            if (routing === "mine") {
              // Heartbeat under the fence: peer reapers (and peers'
              // age checks) serializing on the same fence see this
              // lease while holding it.
              await this.writeLease(task, name, fence);
            }
            if (routing === "age" && !quarantinedRow) {
              // Re-check liveness immediately before the destructive
              // call, INSIDE the fence: a live owner cannot have
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
              // A foreign host-side marker that appeared since routing
              // means a concurrent quarantine: the row was routed
              // "age" anyway (it is unusable), so removal proceeds —
              // same outcome its owner's destroy() would reach.
            }
            const still = await this.docker(
              ["inspect", "--format", "{{.State.Running}}", id],
              15_000,
              20_000,
            );
            if (still.code !== 0) {
              // Only "the container really does not exist" (the daemon
              // reports no such object) may drop the activity record. On
              // a TRANSIENT inspect failure the container may be alive
              // — and with the fence held throughout, no owner
              // operation is currently in flight regardless; the
              // conservative side is to leave the record for the next
              // interval.
              if (/no such object/i.test(still.stderr)) {
                this.taskActivity.delete(task);
                await this.deleteLease(task, name, fence);
                if (quarantinedRow) {
                  await this.deleteQuarantineMarker(task);
                }
              }
              return;
            }
            // Final in-process gate, checked immediately before the
            // destructive call: the queue tail changes on every
            // enqueue, so an unchanged tail proves no operation of
            // THIS provider queued after this removal took the lock
            // (cross-process ordering is the fence held above).
            if (this.taskLocks.get(task) !== myTail) return;
            const removed = await this.docker(["rm", "-f", id], 30_000, 20_000);
            if (
              removed.code === 0 ||
              /no such container/i.test(removed.stderr)
            ) {
              // The container is gone (or already was): the activity
              // record no longer pins anything, so it is dropped. The
              // lease deletion is GENERATION-AWARE: a stale lease of
              // the dead owner (or mine) is removed, but a fresh
              // foreign lease — which cannot have appeared while the
              // fence was held, but the token check protects the path
              // regardless — is never unlinked.
              this.taskActivity.delete(task);
              await this.deleteLease(task, name, fence);
              await this.deleteQuarantineMarker(task);
            }
            // A FAILED removal must NOT drop the activity record: the
            // container is still here; leave it for the next interval.
          }
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
