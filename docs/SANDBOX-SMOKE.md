# Sandbox smoke test (real Docker)

The Docker workspace provider's cross-instance fencing and fail-closed
behavior is specified and unit-tested in
[`src/lib/workspace-docker.test.ts`](../src/lib/workspace-docker.test.ts)
against a **stateful fake Docker CLI** — deterministic, fast, and able to
drive through race windows (delayed filesystem ops, mid-flight token
deletion, replacement holders) that a real daemon cannot be coaxed into.
The fake proves the _protocol_; it cannot prove that the real daemon, the
real sandbox image, and a real POSIX filesystem agree with it.

`npm run smoke:sandbox` closes that gap. It requires a working `docker`
(and roughly 2 GB of disk for the images) and runs ten scenarios:

| #   | Scenario                                     | What it proves against reality                                                                                                                                                                                              |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | End-to-end lifecycle                         | The real `sandbox/Dockerfile` image, create-time tmpfs mounts, labels, tar staging, the git baseline, the validation reaper, `npm test` inside the container, and a clean destroy.                                          |
| 2   | Ownership matrix (two instances, one daemon) | A second provider instance can never open, create over, or destroy a live foreign task.                                                                                                                                     |
| 3   | Atomic adoption of an unlabeled container    | Two instances racing to adopt a legacy (unlabeled) container: exactly one wins; the loser fails closed with the ownership error.                                                                                            |
| 4   | TTL reaper                                   | A fresh foreign lease is respected (no reap); an abandoned task (no activity past the owner's TTL) is removed and its lease retired.                                                                                        |
| 5   | Durable quarantine marker                    | A marker written by any instance blocks a fresh instance's `open`/handle ops until an explicit `destroy` clears it.                                                                                                         |
| 6   | Fence renewal + in-flight contention         | A validation whose command outlives `fenceLockTtlMs / 3`: the holder's token mtime verifiably advances (real `utimes` renewals) while a peer's operation on the same task fails closed with the contention error.           |
| 7   | Multi-host contention (peer → host)          | A second host — its own `docker:dind` daemon over TCP, its own provider instance, sharing **only** the lease volume — holds the fence; this host's create fails closed and creates nothing. After the release, it proceeds. |
| 8   | Multi-host contention (host → peer)          | The reverse direction: this host holds; the peer's operation fails closed.                                                                                                                                                  |
| 9   | Multi-host stale-break                       | The peer "crashes" (its token goes stale on the shared volume); this host breaks the lock via capture-verify-restore, completes its operation, and the broken peer's later release is harmless.                             |
| 10  | Multi-host lifecycle                         | The peer runs a full create → validate → destroy on its **own** daemon; the shared lease file is retired through the volume, and no container ever exists on the wrong daemon.                                              |

## How the multi-host topology works

```
┌─────────────── host (CI runner or laptop) ───────────────┐
│                                                           │
│  npm run smoke:sandbox                                    │
│   └─ provider instance(s) ──── docker CLI ──── host dockerd│
│         │                              │                 │
│         │  shared lease dir (bind mount, POSIX)           │
│         │                              │                 │
│   ┌─────┴──────────┐                   │  network         │
│   │ valmont-smoke-  │  DOCKER_HOST=tcp://…2375             │
│   │ peer container  │────── docker:dind (daemon B)        │
│   │ (same bundled   │                                    │
│   │  provider code) │                                    │
│   └─────────────────┘                                    │
└───────────────────────────────────────────────────────────┘
```

The peer container runs the **same production provider code**, bundled
with esbuild (`scripts/sandbox-smoke-peer.cjs` +
`scripts/sandbox-smoke-peer.Dockerfile`). The two "hosts" cannot see
each other's containers; the lease volume is their only shared state —
exactly the deployment assumption the fencing protocol makes.

## What this still does not prove

- **A specific network filesystem's semantics.** The shared volume here
  is a local bind mount (POSIX-consistent by construction). Production
  multi-host deployments must point `VALMONT_SANDBOX_LEASE_DIR` at a
  volume that really is POSIX-consistent for `mkdir`/`rename`/`utimes`
  (e.g. a shared block volume, not an eventually-consistent object store
  or a non-linearizable NFS export). No test on one machine can certify
  a third-party storage product.
- **Daemon-failure injection.** Timeouts, EIO mid-operation, and
  late-surfacing creates are covered by the unit suite's fake daemon,
  where they can be forced deterministically.
- **Host-level kill races** (SIGKILL between two syscalls). The token
  protocol is designed so every crash interleaving lands in an already
  tested state (stale token → broken by a peer; missing token → fence
  lost → operation fails closed), but only the interleavings the harness
  can produce are executed.

## Running it

```bash
npm ci                 # once; esbuild ships with the dev dependencies
npm run smoke:sandbox
```

The script is self-contained: it builds the sandbox and peer images,
starts the throwaway dind daemon, runs the scenarios, tears everything
down, and on failure dumps `docker ps -a` on both daemons, the dind
logs, and the retained scratch directory path.

### Isolation and cleanup

Every Docker resource a run creates is suffixed with a unique run id —
the image tags, the network, the dind container, the peer container
names, the provider instanceIds (which become `valmont.instance`
labels on the containers the provider creates), and the **task ids**
themselves. Under the generation/epoch lifecycle protocol the provider
never creates the canonical task-derived name — containers are
generation-scoped (`valmont-sandbox-<taskId>--g-<generation>`),
selected by the immutable `valmont.task` label, and tracked through
coordination records under `<leaseDir>/{epochs,mappings,leases,quarantines}/<taskId>/`
— but the task id still roots every artifact, so a fixed task id could
collide with an unrelated task's coordination state. Every scenario
therefore runs on `<task>-<run-id>` tasks (within the provider's
`TASK_ID` pattern), which scopes the derived container names, record
directories, lock
directories and quarantine records at once. The teardown removes
**only** resources carrying this run's identity: it never matches on
`valmont.managed=true` alone, so it cannot delete an unrelated Valmont
or developer container, and it cannot collide with (or clean up) a
concurrent or previously aborted smoke run. The dind daemon is reached
on an ephemeral host port allocated by the daemon itself
(`-p 127.0.0.1::2375`), so nothing on the machine needs to be free for
the smoke to run. The per-run image tags are removed in the teardown;
re-runs are still fast because the Docker layer cache, not the tag,
does the caching.

### CI status

The `sandbox-smoke` job in `.github/workflows/ci.yml` (checkout + Node 22

- `npm ci` + `npm run smoke:sandbox`, 25-minute timeout) runs on every
  push and pull request, alongside `validate` and `container`. The job
  was added by the repository owner (the automation token that pushes
  this branch cannot modify workflow files), and it is **green** — all
  twelve scenarios pass against the real daemon (~3 minutes).

Its first three runs each surfaced exactly the class of issue it
exists to catch — things a fake daemon cannot reproduce:

1. `--security-opt seccomp=default` is a profile _file path_, not a
   way to select the default profile; the real daemon refused the
   create. (Docker's built-in default seccomp profile applies when no
   seccomp option is passed.)
2. `docker cp` cannot write into a `--read-only` container — the
   daemon refuses on that flag alone (moby#43015), even onto writable
   tmpfs. The reaper is now staged by a host-built tar extracted
   in-container as root.
3. Fence semantics that the scenario harness itself had wrong
   (quarantine flag caching; staleness being judged by the _breaker's_
   TTL, default 20 min) — the provider behaved as designed each time;
   the scenarios now assert the documented behavior.

Anyone with Docker can also run it locally:
`npm ci && npm run smoke:sandbox`.
