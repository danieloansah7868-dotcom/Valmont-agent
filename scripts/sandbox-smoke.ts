/**
 * Valmont sandbox smoke test — REAL Docker, REAL POSIX fencing.
 *
 * The unit suite (src/lib/workspace-docker.test.ts) proves the fencing
 * and fail-closed logic against a stateful fake Docker CLI. This script
 * proves it against reality:
 *
 *   1. A real sandbox image (sandbox/Dockerfile) created through the
 *      provider's real create path — tmpfs mounts, labels, tar staging,
 *      git baseline, the validation reaper — then driven through
 *      write/read/readForCommit/runValidation/destroy.
 *   2. Two provider instances on ONE daemon: the ownership matrix
 *      (a peer never opens/creates/destroys a live foreign task),
 *      atomic adoption of an unlabeled legacy container (exactly one
 *      concurrent adopter wins), the TTL reaper (age removal + fresh
 *      lease respected), and durable quarantine markers that block a
 *      fresh instance.
 *   3. Fence renewal observable on a real clock — deterministically: a
 *      validation whose command sleeps 10 s past one heartbeat interval
 *      (60 s command vs 50 s heartbeat at a 150 s TTL, inside the 70 s
 *      exec budget the constructor bound allows) keeps its token fresh
 *      (the token's mtime provably advances) while a peer's operation
 *      on the same task fails closed with the contention error.
 *   4. The MULTI-HOST topology: a second host (a docker:dind daemon,
 *      reached over TCP by a peer container running the same bundled
 *      provider) shares ONLY the lease volume with this host. Cross-host
 *      mutual exclusion (both directions), the crash-recovery stale-break
 *      (capture-verify-restore on the shared volume), and a full
 *      create/validate/destroy lifecycle on the second host — whose
 *      teardown must retire the shared lease file.
 *
 * What this still does NOT prove (documented in docs/SANDBOX-SMOKE.md):
 * genuinely concurrent multi-writer volume semantics of a specific NFS
 * offering, daemon-failure injection, and host-level kill races.
 *
 * Every Docker resource the run creates is suffixed with a unique run id
 * (image tags, network, the dind container, peer container names, the
 * provider instanceIds that become container labels), and the teardown
 * removes ONLY those — never anything that merely looks similar. The
 * dind daemon is reached on an ephemeral, daemon-allocated host port.
 *
 * Usage (requires a working `docker` and ~2 GB free for the images):
 *   npm run smoke:sandbox
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DockerWorkspaceProvider,
  type DockerWorkspaceOptions,
} from "@/lib/workspace-docker";

/**
 * Every Docker resource this run creates — image tags, the network,
 * the dind container, peer container names, the provider instanceIds
 * (which become `valmont.instance` labels) — is suffixed with a unique
 * run id, and the teardown removes ONLY those. A smoke run can never
 * collide with, or delete, resources it does not own (including a
 * concurrent or aborted smoke run, or a developer's real Valmont
 * containers, whatever labels they carry).
 */
const RUN_ID = randomUUID().replace(/-/g, "").slice(0, 10);
const SANDBOX_IMAGE = `valmont-sandbox:smoke-${RUN_ID}`;
const PEER_IMAGE = `valmont-smoke-peer:smoke-${RUN_ID}`;
const DIND_NETWORK = `valmont-smoke-net-${RUN_ID}`;
const DIND_NAME = `valmont-smoke-dind-${RUN_ID}`;
/** Extra label put on containers the harness itself creates by hand. */
const SMOKE_RUN_LABEL = `valmont.smoke-run=${RUN_ID}`;
/** The second host's provider instanceId (labels its dind containers). */
const PEER_INSTANCE_ID = `smoke-peer-${RUN_ID}`;
/** Run-scoped host provider instanceIds, registered by mkHost(). */
const hostInstanceIds = new Set<string>();
/** Names of peer containers started so far (removed in teardown). */
const peerContainerNames: string[] = [];
/** Set once the dind daemon container is running. */
let dindContainerId: string | null = null;
/** tcp://... endpoint of the dind daemon, once discovered. */
let dindHost = "";
/** A host provider instanceId scoped to this run. */
const hostId = (role: string) => {
  const instanceId = `smoke-${role}-${RUN_ID}`;
  hostInstanceIds.add(instanceId);
  return instanceId;
};

const log = (...args: unknown[]) => console.log(...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const check = (condition: boolean, what: string): void => {
  if (!condition) throw new Error(`assertion failed: ${what}`);
};

/** Run a command, capturing stdout; rejects with stderr on failure. */
const run = (
  command: string,
  args: readonly string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed:\n${String(stderr) || error.message}`,
            ),
          );
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });

const docker = (args: readonly string[], timeoutMs?: number) =>
  run("docker", args, timeoutMs);
const dockerOnDind = (args: readonly string[], timeoutMs?: number) => {
  if (!dindHost) {
    throw new Error("the dind daemon has not been started in this run");
  }
  return run("docker", ["-H", dindHost, ...args], timeoutMs);
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(100);
  }
};

interface FenceLike {
  active: boolean;
  release(): Promise<void>;
}
interface ProviderInternals {
  reapExpired(): Promise<void>;
  acquireTaskFence(
    taskId: string,
    role: "owner" | "reaper",
  ): Promise<FenceLike | null>;
}
const internals = (p: DockerWorkspaceProvider): ProviderInternals =>
  p as unknown as ProviderInternals;

/** Expect fn() to reject with a message matching `pattern`. */
const expectReject = async (
  fn: () => Promise<unknown>,
  pattern: RegExp,
  what: string,
): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(
        `${what}: expected a rejection matching ${pattern}, got ${JSON.stringify(message)}`,
      );
    }
    return message;
  }
  throw new Error(
    `${what}: expected a rejection matching ${pattern}, but it resolved`,
  );
};

let stepNumber = 0;
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  stepNumber += 1;
  const tag = `[${String(stepNumber).padStart(2, "0")}]`;
  log(`${tag} ${name}`);
  const started = Date.now();
  try {
    const value = await fn();
    log(`${tag} ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return value;
  } catch (error) {
    log(
      `${tag} FAILED (${((Date.now() - started) / 1000).toFixed(1)}s): ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
};

async function main(): Promise<void> {
  // ---------------------------------------------------------------- setup
  const nodeRequire = createRequire(import.meta.url);
  let esbuildEntry: string;
  try {
    esbuildEntry = nodeRequire.resolve("esbuild");
  } catch {
    throw new Error(
      "esbuild is not installed (it ships with the dev dependencies); run `npm ci` first",
    );
  }
  let dockerVersion: string;
  try {
    dockerVersion = (
      await docker(["version", "--format", "{{.Server.Version}}"])
    ).stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const cause = /ENOENT|not found/i.test(detail)
      ? "the `docker` CLI was not found"
      : `docker version failed: ${detail.split("\n").slice(1).join(" ").trim() || detail}`;
    throw new Error(
      `a working Docker daemon is required for the sandbox smoke test (${cause})`,
    );
  }
  log(
    `docker daemon ${dockerVersion}; esbuild ${path.dirname(esbuildEntry)}; run id ${RUN_ID}`,
  );

  const work = mkdtempSync(path.join(tmpdir(), "valmont-sandbox-smoke-"));
  const leaseDir = path.join(work, "leases");
  const srcBase = path.join(work, "src");
  const srcSlow = path.join(work, "src-slow");
  const peerDir = path.join(work, "peer");
  mkdirSync(leaseDir);
  mkdirSync(peerDir);

  const makeSource = async (dir: string, testScript: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        { name: "valmont-smoke", private: true, scripts: { test: testScript } },
        null,
        2,
      )}\n`,
    );
    await writeFile(path.join(dir, "test.js"), 'console.log("smoke-ok");\n');
  };
  await makeSource(srcBase, "node test.js");
  await makeSource(
    srcSlow,
    "node -e \"setTimeout(() => console.log('slow-ok'), 60000)\"",
  );

  const lockDirOf = (taskId: string) =>
    path.join(leaseDir, ".locks", `${taskId}.lock`);
  const tokenFileOf = (taskId: string): string | null => {
    const dir = lockDirOf(taskId);
    if (!existsSync(dir)) return null;
    const entries = readdirSync(dir).filter((entry) => !entry.startsWith("."));
    return entries.length === 1 ? path.join(dir, entries[0]!) : null;
  };
  const leaseFileOf = (taskId: string) =>
    path.join(leaseDir, `${taskId}.lease`);
  const markerFileOf = (taskId: string) =>
    path.join(leaseDir, `${taskId}.quarantined`);

  const containerIds = async (taskId: string): Promise<string[]> => {
    const { stdout } = await docker([
      "ps",
      "-aq",
      "--filter",
      `name=valmont-sandbox-${taskId}$`,
    ]);
    return stdout.split("\n").filter(Boolean);
  };
  const containerIdsOnDind = async (taskId: string): Promise<string[]> => {
    const { stdout } = await dockerOnDind([
      "ps",
      "-aq",
      "--filter",
      `name=valmont-sandbox-${taskId}$`,
    ]);
    return stdout.split("\n").filter(Boolean);
  };

  const mkHost = (extra: Partial<DockerWorkspaceOptions> = {}) => {
    if (extra.instanceId) {
      hostInstanceIds.add(extra.instanceId);
    }
    return new DockerWorkspaceProvider({
      image: SANDBOX_IMAGE,
      leaseDir,
      ...extra,
    });
  };

  /**
   * Run the SECOND-HOST peer (same bundled provider code) against the
   * dind daemon, sharing only the lease volume. Runs with the host uid
   * so both sides can read and write the same coordination files.
   */
  const peerRun = (args: readonly string[]) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    // Run-scoped name so a crashed run's peer container can be removed
    // precisely in the teardown (docker run --rm does not kill the
    // container when the client dies).
    const name = `valmont-smoke-peer-${RUN_ID}-${peerContainerNames.length + 1}`;
    peerContainerNames.push(name);
    return docker([
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      DIND_NETWORK,
      "-u",
      `${uid}:${gid}`,
      "-v",
      `${leaseDir}:/leases`,
      "-v",
      `${srcBase}:/src:ro`,
      "-e",
      `DOCKER_HOST=tcp://${DIND_NAME}:2375`,
      "-e",
      `SMOKE_PEER_IMAGE=${SANDBOX_IMAGE}`,
      "-e",
      `SMOKE_PEER_INSTANCE_ID=${PEER_INSTANCE_ID}`,
      PEER_IMAGE,
      ...args,
    ]);
  };

  const diagnostics = async () => {
    log(`\n--- diagnostics (run id ${RUN_ID}) ---`);
    try {
      const ps = await docker([
        "ps",
        "-a",
        "--filter",
        "label=valmont.managed=true",
      ]);
      log("host docker ps -a (all managed; read-only):\n" + ps.stdout);
    } catch {
      /* best effort */
    }
    try {
      const ps = await dockerOnDind(["ps", "-a"]);
      log("dind docker ps -a:\n" + ps.stdout);
    } catch {
      /* best effort */
    }
    try {
      const dindLogs = await docker(["logs", "--tail", "40", DIND_NAME]);
      log("dind logs (tail):\n" + dindLogs.stdout);
    } catch {
      /* best effort */
    }
    log(`work dir retained for inspection: ${work}`);
  };

  try {
    // ------------------------------------------------- images and daemons
    await step("build the sandbox image (sandbox/Dockerfile)", async () => {
      await docker([
        "build",
        "-t",
        SANDBOX_IMAGE,
        "-f",
        "sandbox/Dockerfile",
        "sandbox",
      ]);
    });

    await step(
      "bundle the provider and build the second-host peer image",
      async () => {
        const esbuild = await import("esbuild");
        await esbuild.build({
          entryPoints: ["src/lib/workspace-docker.ts"],
          bundle: true,
          platform: "node",
          format: "cjs",
          outfile: path.join(peerDir, "provider.cjs"),
          alias: { "@": "./src" },
          logLevel: "silent",
        });
        const scriptDir = path.dirname(new URL(import.meta.url).pathname);
        writeFileSync(
          path.join(peerDir, "peer-driver.cjs"),
          readFileSync(path.join(scriptDir, "sandbox-smoke-peer.cjs")),
        );
        writeFileSync(
          path.join(peerDir, "Dockerfile"),
          readFileSync(path.join(scriptDir, "sandbox-smoke-peer.Dockerfile")),
        );
        await docker(["build", "-t", PEER_IMAGE, peerDir]);
      },
    );

    await step(
      "start the second host's Docker daemon (docker:dind)",
      async () => {
        await docker(["network", "create", DIND_NETWORK]);
        // An EMPTY host port ("-p 127.0.0.1::2375") makes the daemon
        // pick a free ephemeral port itself: no fixed port to collide
        // with anything else running on this machine.
        dindContainerId = (
          await docker([
            "run",
            "-d",
            "--privileged",
            "--name",
            DIND_NAME,
            "--network",
            DIND_NETWORK,
            "-p",
            "127.0.0.1::2375",
            "-e",
            "DOCKER_TLS_CERTDIR=",
            "docker:27-dind",
          ])
        ).stdout.trim();
        const port = (await docker(["port", DIND_NAME, "2375"])).stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .find((line) => line.startsWith("127.0.0.1:"));
        if (!port) {
          throw new Error("could not discover the dind daemon's mapped port");
        }
        dindHost = `tcp://${port}`;
        log(`dind endpoint ${dindHost} (container ${DIND_NAME})`);
        await waitFor(
          async () => {
            try {
              await dockerOnDind([
                "version",
                "--format",
                "{{.Server.Version}}",
              ]);
              return true;
            } catch {
              return false;
            }
          },
          "the dind daemon to answer",
          60_000,
        );
        // The peer's lifecycle scenario needs the sandbox image on ITS
        // daemon too (its containers never exist on the host daemon).
        await dockerOnDind([
          "build",
          "-t",
          SANDBOX_IMAGE,
          "-f",
          "sandbox/Dockerfile",
          "sandbox",
        ]);
      },
    );

    // ------------------------------------------------------- scenarios
    await step("end-to-end lifecycle on the host daemon", async () => {
      const provider = mkHost({ instanceId: hostId("a") });
      const ws = await provider.create("taske2e", srcBase);
      await provider.writeFile(ws, "notes.txt", "hello from the smoke test\n");
      const note = await provider.readFile(ws, "notes.txt");
      check(
        note.includes("hello from the smoke test"),
        `readFile returned the written content (got ${JSON.stringify(note)})`,
      );
      const committed = await provider.readFileForCommit(ws, "package.json");
      check(
        committed.includes("valmont-smoke"),
        "readFileForCommit returned the staged package.json",
      );
      const result = await provider.runValidation(ws, "npm test");
      check(
        result.status === "passed" && result.exitCode === 0,
        `npm test validation passed (got ${result.status}/${result.exitCode}: ${result.output.slice(0, 300)})`,
      );
      check(
        result.output.includes("smoke-ok"),
        "the validation output contains the task's own output",
      );
      await provider.destroy("taske2e");
      check(
        (await containerIds("taske2e")).length === 0,
        "destroy removed the container",
      );
    });

    await step(
      "ownership matrix: a peer instance never touches a live task",
      async () => {
        const a = mkHost({ instanceId: hostId("a") });
        const b = mkHost({ instanceId: hostId("b") });
        await a.create("taskown", srcBase);
        await expectReject(
          () => b.open("taskown"),
          /owned by another/,
          "peer open",
        );
        await expectReject(
          () => b.create("taskown", srcBase),
          /owned by another/,
          "peer create",
        );
        await expectReject(
          () => b.destroy("taskown"),
          /owned by another/,
          "peer destroy",
        );
        check(
          (await containerIds("taskown")).length === 1,
          "the container survived every peer attempt",
        );
        await a.destroy("taskown");
      },
    );

    await step(
      "atomic adoption of an unlabeled legacy container (one winner)",
      async () => {
        const container = "valmont-sandbox-taskadopt";
        await docker([
          "create",
          "--name",
          container,
          "--label",
          "valmont.managed=true",
          "--label",
          "valmont.task=taskadopt",
          // Marks this container as created by THIS smoke run, so the
          // teardown can remove it precisely if the scenario dies.
          "--label",
          SMOKE_RUN_LABEL,
          SANDBOX_IMAGE,
        ]);
        await docker(["start", container]);
        const a = mkHost({ instanceId: hostId("a") });
        const b = mkHost({
          instanceId: hostId("b"),
          fenceOwnerWaitMs: 30_000,
        });
        const races = await Promise.allSettled([
          a.open("taskadopt"),
          b.open("taskadopt"),
        ]);
        const winners = races.filter((r) => r.status === "fulfilled");
        const losers = races.filter((r) => r.status === "rejected");
        check(
          winners.length === 1,
          `exactly one concurrent adopter won (${winners.length} did)`,
        );
        check(losers.length === 1, "exactly one concurrent adopter lost");
        const loser = losers[0];
        if (loser.status === "rejected") {
          check(
            /owned by another/.test(
              String(loser.reason?.message ?? loser.reason),
            ),
            `the losing adopter failed closed with the ownership error (got ${JSON.stringify(String(loser.reason?.message ?? loser.reason))})`,
          );
        }
        const winnerIndex = races.findIndex((r) => r.status === "fulfilled");
        const winner = winnerIndex === 0 ? a : b;
        await winner.destroy("taskadopt");
        check(
          (await containerIds("taskadopt")).length === 0,
          "the winner's destroy removed the adopted container",
        );
      },
    );

    await step(
      "TTL reaper: fresh foreign lease respected, abandoned task removed",
      async () => {
        const owner = mkHost({
          instanceId: hostId("r"),
          ttlMs: 4_000,
          reapIntervalMs: 3_600_000,
        });
        const peer = mkHost({ instanceId: hostId("b2") });
        await owner.create("taskreap", srcBase);
        // A peer instance sweeps while the owner's lease is fresh: skip.
        await internals(peer).reapExpired();
        check(
          (await containerIds("taskreap")).length === 1,
          "a fresh foreign lease was respected (no reap)",
        );
        // Abandoned: no activity for longer than the owner's TTL.
        await sleep(4_600);
        await internals(owner).reapExpired();
        check(
          (await containerIds("taskreap")).length === 0,
          "the abandoned task was reaped",
        );
        check(
          !existsSync(leaseFileOf("taskreap")),
          "the reaped task's lease was retired",
        );
      },
    );

    await step(
      "durable quarantine marker blocks a fresh instance until destroy",
      async () => {
        const a = mkHost({ instanceId: hostId("a") });
        await a.create("taskq", srcBase);
        // A marker written by "any instance" (the durable stop-fallback
        // state): simulate it by writing the same payload the provider
        // writes into the shared lease directory.
        writeFileSync(
          markerFileOf("taskq"),
          JSON.stringify({
            taskId: "taskq",
            instanceId: "some-other-instance",
            quarantinedAt: Date.now(),
          }),
        );
        const fresh = mkHost({ instanceId: hostId("c") });
        await expectReject(
          () => fresh.open("taskq"),
          /quarantined/,
          "fresh instance open",
        );
        await expectReject(
          () =>
            fresh.readFile({ id: "taskq", root: "/workspace" }, "package.json"),
          /quarantined/,
          "fresh instance handle op",
        );
        check(
          (await containerIds("taskq")).length === 1,
          "the quarantined container is untouched",
        );
        await a.destroy("taskq");
        check(!existsSync(markerFileOf("taskq")), "destroy cleared the marker");
        check(
          (await containerIds("taskq")).length === 0,
          "destroy removed the container",
        );
        await expectReject(
          () => fresh.open("taskq"),
          /unavailable/,
          "open after destroy",
        );
      },
    );

    await step(
      "fence renewal is observable on a real clock; a peer fails closed mid-op",
      async () => {
        // The timing is chosen so the renewal is DETERMINISTIC, not
        // incidental: with fenceLockTtlMs = 150 s the provider's renewal
        // heartbeat interval is max(25 ms, TTL/3) = 50 s, and the
        // validation command sleeps 60 s — comfortably (10 s) past one
        // heartbeat — while the 70 s exec budget (the constructor bound
        // is floor(150 s/2) - 2 s = 73 s) still contains it with ~9 s
        // to spare. The fence is therefore provably alive only because
        // the heartbeat renewed it, never because the op finished first.
        const a = mkHost({
          instanceId: hostId("a2"),
          fenceLockTtlMs: 150_000,
          timeoutMs: 70_000,
        });
        const b = mkHost({
          instanceId: hostId("b3"),
          fenceOwnerWaitMs: 1_500,
        });
        const ws = await a.create("taskrenew", srcSlow);
        const validation = a.runValidation(ws, "npm test");
        // If a step below throws first, the pending validation must not
        // surface as an unhandled rejection; awaiting it below still
        // reports its real outcome.
        validation.catch(() => undefined);
        await waitFor(
          () => tokenFileOf("taskrenew") !== null,
          "the validation op to take the fence",
        );
        const token = tokenFileOf("taskrenew")!;
        const mtimeBefore = lstatSync(token).mtimeMs;
        // While the long validation holds the fence, a peer operation on
        // the SAME task must fail closed (never run unfenced).
        await expectReject(
          () => b.create("taskrenew", srcSlow),
          /peer holds the task fence/,
          "peer create during the in-flight validation",
        );
        check(
          (await containerIds("taskrenew")).length === 1,
          "the in-flight task's container is untouched",
        );
        // The heartbeat must renew the token while the op runs. The poll
        // distinguishes the two outcomes instead of crashing: an mtime
        // advance means "renewed" (pass); the token disappearing first
        // means the operation already released the fence without any
        // renewal having landed — a deterministic failure of THIS
        // scenario's premise, reported as such.
        let renewed = false;
        await waitFor(
          () => {
            const current = tokenFileOf("taskrenew");
            if (current === null) {
              if (renewed) return true;
              throw new Error(
                "the validation released the fence before any heartbeat " +
                  "renewal was observed (the command did not outlive the " +
                  "heartbeat interval; the renewal was never proven)",
              );
            }
            renewed = lstatSync(current).mtimeMs > mtimeBefore + 5_000;
            return renewed;
          },
          "a fence renewal to land on the token",
          75_000,
        );
        check(renewed, "the token's mtime advanced (a real renewal landed)");
        const result = await validation;
        check(
          result.status === "passed" && result.output.includes("slow-ok"),
          `the long validation passed (${result.status}: ${result.output.slice(0, 200)})`,
        );
        await a.destroy("taskrenew");
      },
    );

    await step(
      "MULTI-HOST: a peer host's fence fails this host's op closed",
      async () => {
        const peerHold = peerRun(["hold", "taskxh", "9000"]);
        await waitFor(
          () => tokenFileOf("taskxh") !== null,
          "the peer host to take the fence through the shared volume",
        );
        const host = mkHost({
          instanceId: hostId("x"),
          fenceOwnerWaitMs: 1_500,
        });
        await expectReject(
          () => host.create("taskxh", srcBase),
          /peer holds the task fence/,
          "cross-host create while the peer holds the fence",
        );
        check(
          (await containerIds("taskxh")).length === 0,
          "no container was created for the failed cross-host op",
        );
        const peerOut = await peerHold;
        check(
          peerOut.stdout.includes("HELD") &&
            peerOut.stdout.includes("RELEASED"),
          `the peer held and released cleanly (${peerOut.stdout.trim()})`,
        );
        // Once the peer released, this host proceeds.
        await host.create("taskxh", srcBase);
        await host.destroy("taskxh");
      },
    );

    await step(
      "MULTI-HOST: this host's fence fails the peer's op closed",
      async () => {
        const host = mkHost({ instanceId: hostId("y") });
        const fence = await internals(host).acquireTaskFence("taskyh", "owner");
        check(fence?.active === true, "this host acquired the fence");
        const peerOut = await peerRun(["attempt", "taskyh"]);
        check(
          peerOut.stdout.includes("EXPECTED_CONTENTION"),
          `the peer failed closed with the contention error (${peerOut.stdout.trim()})`,
        );
        await fence!.release();
      },
    );

    await step(
      "MULTI-HOST: a stale peer token is broken and taken over safely",
      async () => {
        // The peer "crashes" in effect: its token goes stale on the
        // shared volume while it still believes it holds the fence.
        const peerHold = peerRun(["hold", "taskzh", "20000"]);
        await waitFor(
          () => tokenFileOf("taskzh") !== null,
          "the peer host to take the fence",
        );
        const token = tokenFileOf("taskzh")!;
        const stale = new Date(Date.now() - 60_000);
        await utimes(token, stale, stale);
        // This host must break the stale lock (capture-verify-restore on
        // the shared volume) and complete its operation.
        const host = mkHost({
          instanceId: hostId("z"),
          fenceOwnerWaitMs: 8_000,
        });
        await host.create("taskzh", srcBase);
        check(
          (await containerIds("taskzh")).length === 1,
          "this host created its container after the takeover",
        );
        await host.destroy("taskzh");
        const peerOut = await peerHold;
        check(
          peerOut.stdout.includes("RELEASED"),
          `the broken peer released harmlessly (${peerOut.stdout.trim()})`,
        );
      },
    );

    await step(
      "MULTI-HOST: full lifecycle on the peer's own daemon",
      async () => {
        const peerOut = await peerRun(["lifecycle", "taskph", "/src"]);
        check(
          peerOut.stdout.includes("LIFECYCLE_OK"),
          `the peer completed create/validate/destroy on its own daemon (${peerOut.stdout.trim()})`,
        );
        check(
          (await containerIds("taskph")).length === 0,
          "the peer's container never existed on the host daemon",
        );
        check(
          (await containerIdsOnDind("taskph")).length === 0,
          "the peer cleaned up its own daemon",
        );
        check(
          !existsSync(leaseFileOf("taskph")),
          "the peer's destroy retired the SHARED lease file",
        );
      },
    );

    log(`\nall ${stepNumber} smoke scenarios passed`);
    // Success: the lease dir's bind mounts are all gone (containers
    // removed), so the scratch tree can be cleaned. Failures keep it
    // for inspection (see diagnostics()).
    await rm(work, { recursive: true, force: true });
  } catch (error) {
    await diagnostics();
    throw error;
  } finally {
    // Teardown removes ONLY resources this run created, by construction:
    //
    // - provider-created containers are matched by the run-scoped
    //   `valmont.instance` labels of the instances mkHost() minted (the
    //   provider puts its instanceId on every container it creates), so
    //   unrelated Valmont containers — whatever their labels — are never
    //   touched;
    // - containers the harness itself created by hand carry the
    //   run-scoped `valmont.smoke-run` label;
    // - peer containers, the dind container, the network and the image
    //   tags all embed the unique RUN_ID.
    //
    // Every step is best-effort: a resource that never came into
    // existence (or already went away) makes the call fail, which is
    // swallowed.
    const rmByIds = async (args: readonly string[]) => {
      const ids = await docker(args)
        .then((r) => r.stdout.split("\n").filter(Boolean))
        .catch(() => [] as string[]);
      for (const id of ids) {
        await docker(["rm", "-f", id]).catch(() => undefined);
      }
    };
    for (const instanceId of hostInstanceIds) {
      await rmByIds([
        "ps",
        "-aq",
        "--filter",
        `label=valmont.instance=${instanceId}`,
      ]);
    }
    await rmByIds(["ps", "-aq", "--filter", `label=${SMOKE_RUN_LABEL}`]);
    for (const name of peerContainerNames) {
      await docker(["rm", "-f", name]).catch(() => undefined);
    }
    // Removing the dind container also destroys everything that ever
    // existed inside its daemon (the peer's containers and images).
    if (dindContainerId) {
      await docker(["rm", "-f", dindContainerId]).catch(() => undefined);
    } else {
      await docker(["rm", "-f", DIND_NAME]).catch(() => undefined);
    }
    await docker(["network", "rm", DIND_NETWORK]).catch(() => undefined);
    await docker(["rmi", "-f", SANDBOX_IMAGE]).catch(() => undefined);
    await docker(["rmi", "-f", PEER_IMAGE]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    `\nsandbox smoke test FAILED: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
