#!/usr/bin/env node
/*
 * Valmont sandbox smoke test — PEER DRIVER.
 *
 * This script runs INSIDE the `valmont-smoke-peer` container and plays
 * the role of a SECOND HOST: its own Docker daemon (docker:dind, reached
 * via DOCKER_HOST=tcp://...), its own provider instance
 * (instanceId "peer-host-b"), and — the only thing it shares with the
 * first host — the POSIX lease volume bind-mounted at /leases. That is
 * exactly the multi-host topology the fencing protocol is designed for:
 * two daemons that cannot see each other's containers, one shared,
 * POSIX-consistent coordination volume.
 *
 * The provider itself is the esbuild bundle of src/lib/workspace-docker.ts
 * (provider.cjs, built by scripts/sandbox-smoke.ts) — the same production
 * code the first host runs, not a reimplementation.
 *
 * Commands (argv):
 *   hold <taskId> <ms>   acquire the task fence, hold it for <ms>, release.
 *                        Prints HELD once the fence is verifiably held.
 *   attempt <taskId>     run destroy() while the OTHER host holds the
 *                        fence; expects the fail-closed contention error
 *                        ("peer holds the task fence") and exits 0 only
 *                        for that outcome.
 *   lifecycle <task> <sourceDir>
 *                        full create -> runValidation -> destroy cycle
 *                        against THIS host's daemon, exiting 0 only when
 *                        every step succeeded.
 *
 * Exit codes: 0 = expected outcome; non-zero = unexpected (the smoke
 * runner treats any non-zero exit as a failure and dumps diagnostics).
 */
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the peer image ships plain CommonJS (no bundler runs inside the container).
const { DockerWorkspaceProvider } = require("./provider.cjs");

/**
 * The lease volume is bind-mounted at /leases in the smoke topology;
 * the env override exists so the fencing mechanics can also be
 * exercised outside the container (two plain processes, one directory).
 */
const LEASE_DIR = process.env.SMOKE_PEER_LEASE_DIR || "/leases";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** TS `private` members exist at runtime on the bundled class. */
const internals = (provider) => provider;

async function hold(taskId, ms) {
  const provider = new DockerWorkspaceProvider({
    image: "valmont-sandbox:smoke",
    leaseDir: LEASE_DIR,
    instanceId: "peer-host-b",
  });
  const fence = await internals(provider).acquireTaskFence(taskId, "owner");
  if (!fence || !fence.active) {
    console.log(`HOLD_INACTIVE:${fence && fence.inactiveReason}`);
    process.exit(4);
  }
  console.log("HELD");
  process.stdout.write("");
  await sleep(ms);
  await fence.release();
  console.log("RELEASED");
  process.exit(0);
}

async function attempt(taskId) {
  const provider = new DockerWorkspaceProvider({
    image: "valmont-sandbox:smoke",
    leaseDir: LEASE_DIR,
    instanceId: "peer-host-b",
    // Short owner wait: the assertion is that the op FAILS CLOSED while a
    // peer verifiably holds the fence — not that it waits forever.
    fenceOwnerWaitMs: 2_000,
  });
  try {
    // destroy() takes the cross-instance fence first; with the other
    // host holding it, this must throw before any docker call runs.
    await provider.destroy(taskId);
    console.log("UNEXPECTED_SUCCESS");
    process.exit(6);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/peer holds the task fence/.test(message)) {
      console.log("EXPECTED_CONTENTION");
      process.exit(0);
    }
    console.log(`UNEXPECTED_ERROR:${message}`);
    process.exit(5);
  }
}

async function lifecycle(taskId, sourceRoot) {
  const provider = new DockerWorkspaceProvider({
    image: "valmont-sandbox:smoke",
    leaseDir: LEASE_DIR,
    instanceId: "peer-host-b",
  });
  const ws = await provider.create(taskId, sourceRoot);
  console.log(`CREATED:${ws.id}`);
  const result = await provider.runValidation(ws, "npm test");
  console.log(`VALIDATION:${result.status}:${result.exitCode}`);
  if (result.status !== "passed") {
    process.exit(7);
  }
  await provider.destroy(taskId);
  console.log("DESTROYED");
  console.log("LIFECYCLE_OK");
  process.exit(0);
}

async function main() {
  const [command, taskId, arg2] = process.argv.slice(2);
  try {
    if (command === "hold") {
      await hold(taskId, Number(arg2));
    } else if (command === "attempt") {
      await attempt(taskId);
    } else if (command === "lifecycle") {
      await lifecycle(taskId, arg2);
    } else {
      console.log(`UNKNOWN_COMMAND:${command}`);
      process.exit(2);
    }
  } catch (error) {
    console.log(`PEER_ERROR:${error && error.stack ? error.stack : error}`);
    process.exit(1);
  }
}

void main();
