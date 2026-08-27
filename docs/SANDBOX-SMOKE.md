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

CI runs it on every push and pull request (the `sandbox-smoke` job in
`.github/workflows/ci.yml`). The script is self-contained: it builds the
sandbox and peer images, starts the throwaway dind daemon, runs the
scenarios, tears everything down (images are kept for fast re-runs), and
on failure dumps `docker ps -a` on both daemons, the dind logs, and the
retained scratch directory path.
