import { EventEmitter } from "node:events";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "@/lib/security";
import { DockerWorkspaceProvider, type DockerSpawn } from "./workspace-docker";

interface Scripted {
  code: number;
  stdout?: string;
  stderr?: string;
}

type Handler = (argv: readonly string[]) => Scripted | undefined;

/**
 * Records every docker CLI invocation and lets tests script responses, so the
 * provider's container hardening can be asserted without a Docker daemon.
 */
class FakeDocker {
  readonly calls: string[][] = [];
  private readonly handlers: Handler[] = [];
  /** Simulated CLI latency, so overlapping operations would interleave. */
  private readonly delayMs: number;
  private inFlightCount = 0;
  /** Highest number of concurrently in-flight docker invocations. */
  maxInFlight = 0;

  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  onMatch(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  spawn(_command: string, args: readonly string[]) {
    this.calls.push([...args]);
    let result: Scripted = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "exec" && args[6] === "stat" && args[7] === "-c") {
      // Default: a plausible healthy workspace — directory components are
      // real directories, and a component that looks like a file (a dot in
      // its name) is a regular file. Tests override via onMatch to simulate
      // missing, symlinked, or otherwise unsafe path components.
      const target = args[args.length - 1] ?? "";
      const kind = target.includes(".") ? "regular file" : "directory";
      if (args[8] === "%u %g %a") {
        // Reaper-staging verification: a fresh root-only directory.
        result = { code: 0, stdout: "0 0 700\n" };
      } else if (args[8] === "%u %g %a %F") {
        // Reaper-staging verification: the root-owned script.
        result = { code: 0, stdout: "0 0 600 regular file\n" };
      } else {
        result = { code: 0, stdout: `${kind}\n` };
      }
    }
    for (const handler of this.handlers) {
      const scripted = handler(args);
      if (scripted) {
        result = scripted;
        break;
      }
    }
    const proc = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    this.inFlightCount += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlightCount);
    setImmediate(async () => {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      stdout.emit("data", Buffer.from(result.stdout ?? ""));
      stderr.emit("data", Buffer.from(result.stderr ?? ""));
      this.inFlightCount -= 1;
      proc.emit("close", result.code, null);
    });
    const child = {
      stdout,
      stderr,
      pid: 4242,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "close" || event === "error") proc.on(event, listener);
        return this;
      },
      kill: () => true,
    };
    return child as unknown as ChildProcess;
  }
}

function makeProvider(
  fake: FakeDocker,
  extra: Partial<ConstructorParameters<typeof DockerWorkspaceProvider>[0]> = {},
): DockerWorkspaceProvider {
  return new DockerWorkspaceProvider({
    image: "valmont-sandbox:local",
    reapIntervalMs: 0,
    spawnOverride: fake.spawn.bind(fake) as unknown as DockerSpawn,
    ...extra,
  });
}

function callFor(
  fake: FakeDocker,
  predicate: (argv: string[]) => boolean,
): string[] {
  const call = fake.calls.find(predicate);
  if (!call) throw new Error("expected docker call not found");
  return call;
}

const TASK = "task-1";
const NAME = `valmont-sandbox-${TASK}`;
const HANDLE = { id: TASK, root: "/workspace" };

async function makeSource(root: string): Promise<string> {
  const source = await mkdtemp(path.join(tmpdir(), root));
  await writeFile(path.join(source, "README.md"), "# hello\n");
  return source;
}

describe("DockerWorkspaceProvider", () => {
  it("rejects invalid task identifiers without invoking docker", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    await expect(provider.create("bad id", "/tmp/src")).rejects.toThrow(
      "Invalid task identifier",
    );
    await expect(provider.create("ab", "/tmp/src")).rejects.toThrow(
      "Invalid task identifier",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("creates one hardened, credential-free container per task", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    const handle = await provider.create(TASK, source);
    expect(handle).toEqual({ id: TASK, root: "/workspace" });

    const create = callFor(fake, (argv) => argv[0] === "create");
    // Containment: read-only rootfs, dropped capabilities, no-new-privileges,
    // default seccomp, default-deny network.
    expect(create).toContain("--read-only");
    expect(create).toContain("--cap-drop");
    expect(create).toContain("ALL");
    expect(create).toContain("no-new-privileges:true");
    expect(create).toContain("seccomp=default");
    expect(create[create.indexOf("--network") + 1]).toBe("none");
    // Quotas: CPU, memory (swap pinned to memory, i.e. no swap), PIDs.
    expect(create[create.indexOf("--cpus") + 1]).toBe("2");
    expect(create[create.indexOf("--memory") + 1]).toBe("2147483648");
    expect(create[create.indexOf("--memory-swap") + 1]).toBe("2147483648");
    expect(create[create.indexOf("--pids-limit") + 1]).toBe("256");
    // The only writable storage is the per-task size-limited tmpfs: the
    // kernel enforces the cap (ENOSPC) and it dies with the container.
    const tmpfsFlags = create.filter((flag) => flag === "--tmpfs");
    expect(tmpfsFlags).toHaveLength(1);
    expect(create[create.indexOf("--tmpfs") + 1]).toBe(
      "/workspace:rw,nosuid,nodev,size=2147483648",
    );
    expect(create).not.toContain("-v");
    // No named volumes anywhere in the lifecycle.
    expect(fake.calls.some((argv) => argv[0] === "volume")).toBe(false);
    // Labels for the TTL reaper; the image is the final create argument.
    expect(create).toContain("valmont.managed=true");
    expect(create).toContain(`valmont.task=${TASK}`);
    expect(create.at(-1)).toBe("valmont-sandbox:local");
    // No environment variables ever enter the container: credentials cannot.
    expect(create).not.toContain("-e");
    expect(create).not.toContain("--env");

    // Task execs run as the unprivileged user; root is limited to the fixed
    // chown setup ops that follow each docker cp.
    const execs = fake.calls.filter((argv) => argv[0] === "exec");
    expect(execs.length).toBeGreaterThanOrEqual(3);
    for (const exec of execs) {
      // Root is limited to fixed-argv setup ops (chown, mkdir, and the
      // reaper staging's rm/stat on the fixed /workspace/.valmont paths);
      // everything else is node.
      if (
        exec[6] === "chown" ||
        exec[6] === "mkdir" ||
        (exec[6] === "rm" && exec.at(-1) === "/workspace/.valmont") ||
        (exec[6] === "stat" && exec.at(-1) === "/workspace/.valmont") ||
        (exec[6] === "stat" &&
          exec.at(-1) === "/workspace/.valmont/validation-reap.mjs")
      ) {
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
      } else {
        expect(exec.slice(1, 3)).toEqual(["--user", "node"]);
      }
    }
    // Staging: docker cp (no --chown support) lands root-owned files, then
    // one controlled root chown -R fixes ownership before any task code runs.
    const stagingCp = fake.calls.findIndex((argv) => argv[0] === "cp");
    const stagingChown = fake.calls.findIndex(
      (argv) =>
        argv[0] === "exec" && argv.includes("chown") && argv.includes("-R"),
    );
    expect(stagingCp).toBeGreaterThan(-1);
    expect(stagingChown).toBeGreaterThan(stagingCp);
    expect(fake.calls[stagingChown]).toEqual([
      "exec",
      "--user",
      "root",
      "--workdir",
      "/workspace",
      NAME,
      "chown",
      "-R",
      "node:node",
      "/workspace",
    ]);
    // The git exclude copy also gets a root chown of the fixed path.
    expect(
      fake.calls.some(
        (argv) =>
          argv[0] === "exec" &&
          argv.slice(6).join(" ") ===
            "chown node:node /workspace/.git/info/exclude",
      ),
    ).toBe(true);
    // The validation reaper is staged into a root-only directory AFTER the
    // staging chown (so it stays root-owned 0600, unreadable and undeletable
    // by task code) and before the git baseline (.valmont/ is git-excluded).
    const mkdirValmont = fake.calls.findIndex(
      (argv) => argv[0] === "exec" && argv[6] === "mkdir",
    );
    const cpReaper = fake.calls.findIndex(
      (argv) =>
        argv[0] === "cp" &&
        argv.at(-1) === `${NAME}:/workspace/.valmont/validation-reap.mjs`,
    );
    expect(fake.calls[mkdirValmont]).toEqual([
      "exec",
      "--user",
      "root",
      "--workdir",
      "/workspace",
      NAME,
      "mkdir",
      "-m",
      "0700",
      "/workspace/.valmont",
    ]);
    expect(cpReaper).toBeGreaterThan(mkdirValmont);
    expect(cpReaper).toBeGreaterThan(stagingChown);
    // A source repository may supply its own `.valmont` entry — it is
    // removed (root, exact fixed argv) before the directory is created:
    // `mkdir -m` only applies its mode to a directory it creates itself,
    // and a supplied symlink would redirect the root-only script into
    // task-writable territory.
    const rmValmont = fake.calls.findIndex(
      (argv) =>
        argv[0] === "exec" &&
        argv.slice(6).join(" ") === "rm -rf -- /workspace/.valmont",
    );
    expect(rmValmont).toBeGreaterThan(-1);
    expect(stagingChown).toBeLessThan(rmValmont);
    expect(rmValmont).toBeLessThan(mkdirValmont);
    // The staged result is verified (root, fixed argv) before the provider
    // continues: the directory and the script must be exactly what the
    // steps above produce.
    const statDir = fake.calls.findIndex(
      (argv) =>
        argv[0] === "exec" &&
        argv.slice(6).join(" ") === "stat -c %u %g %a /workspace/.valmont",
    );
    const statScript = fake.calls.findIndex(
      (argv) =>
        argv[0] === "exec" &&
        argv.slice(6).join(" ") ===
          "stat -c %u %g %a %F /workspace/.valmont/validation-reap.mjs",
    );
    expect(statDir).toBeGreaterThan(cpReaper);
    expect(statScript).toBeGreaterThan(statDir);
    // No chown ever re-owns the reaper script or its directory.
    expect(
      fake.calls.some(
        (argv) =>
          argv[0] === "exec" &&
          argv.includes("chown") &&
          argv.some((token) => token.includes("/workspace/.valmont")),
      ),
    ).toBe(false);
    expect(
      fake.calls.some((argv) => argv[0] === "exec" && argv.includes("commit")),
    ).toBe(true);
  });

  it("runs arbitrary task code only as the unprivileged user", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await provider.create(TASK, source);
    await provider.writeFile(HANDLE, "src/new.txt", "x");
    await provider.runValidation(HANDLE, "npm test");
    const execs = fake.calls.filter((argv) => argv[0] === "exec");
    expect(execs.length).toBeGreaterThan(0);
    for (const exec of execs) {
      const command = exec.slice(6);
      if (command[0] === "chown") {
        // Controlled setup op: root, fixed binary, fixed unprivileged owner.
        // The only permitted flag is -R (recursive staging), and every token
        // must come from the fixed vocabulary — no untrusted content.
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
        expect(command.slice(1).includes("node:node")).toBe(true);
        expect(
          command.every(
            (token) =>
              token === "chown" ||
              token === "-R" ||
              token === "node:node" ||
              token.startsWith("/workspace"),
          ),
        ).toBe(true);
      } else if (command[0] === "mkdir") {
        // Setup: either create missing write parents (-p) or the root-only
        // reaper directory (-m 0700). Always root, always a fixed
        // /workspace path — no untrusted content.
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
        const tokens = command.slice(1);
        if (tokens[0] === "-p") {
          expect(tokens[1].startsWith("/workspace")).toBe(true);
        } else {
          expect(tokens).toEqual(["-m", "0700", "/workspace/.valmont"]);
        }
      } else if (
        command[0] === "rm" &&
        command.slice(1).join(" ") === "-rf -- /workspace/.valmont"
      ) {
        // Source-supplied .valmont removal: root, exact fixed argv, fixed
        // path — nothing else may ever be removed by root.
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
      } else if (command[0] === "stat") {
        // Root setup: path-component verification (-c %F) or the
        // reaper-staging verification (fixed format, fixed path).
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
        expect(command.slice(1, 2)).toEqual(["-c"]);
        if (command[2] === "%u %g %a") {
          expect(command[3]).toBe("/workspace/.valmont");
        } else if (command[2] === "%u %g %a %F") {
          expect(command[3]).toBe("/workspace/.valmont/validation-reap.mjs");
        } else {
          expect(command[2]).toBe("%F");
          expect(command[3].startsWith("/workspace")).toBe(true);
        }
      } else if (
        command[0] === "node" &&
        command[1] === "/workspace/.valmont/validation-reap.mjs"
      ) {
        // Post-validation cleanup: root, fixed script path, and a numeric
        // start-time boundary — nothing else may ever run as root.
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
        expect(Number.isInteger(Number(command[2]))).toBe(true);
      } else {
        // Arbitrary task code (git, cat, rm, timeout+validation): never root.
        expect(exec.slice(1, 3)).toEqual(["--user", "node"]);
      }
    }
  });

  it("serializes overlapping operations for the same task", async () => {
    const fake = new FakeDocker(5);
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await provider.create(TASK, source);
    await Promise.all([
      provider.readFile(HANDLE, "notes.md"),
      provider.writeFile(HANDLE, "src/x.txt", "x"),
      provider.deleteFile(HANDLE, "notes.md"),
      provider.runValidation(HANDLE, "npm test"),
    ]);
    // Per-task serialization: no docker invocation from one operation can
    // overlap a docker invocation from another operation on the same task.
    expect(fake.maxInFlight).toBe(1);
  });

  it("lets operations for different tasks proceed concurrently", async () => {
    const fake = new FakeDocker(5);
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await Promise.all([
      provider.create("task-a", source),
      provider.create("task-b", source),
    ]);
    // The queue is per task: different tasks are not serialized against
    // each other.
    expect(fake.maxInFlight).toBeGreaterThan(1);
  });

  it("reaps an abandoned container through the task queue", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "ps") {
        return { code: 0, stdout: "cid-abandoned\ttask-old\n" };
      }
      if (argv[0] === "inspect" && argv.includes("{{.Created}}")) {
        return { code: 0, stdout: `${OLD}\n` };
      }
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
        return { code: 0, stdout: "true\n" };
      }
      return undefined;
    });
    const provider = makeProvider(fake, { ttlMs: 60_000 });
    // No recorded activity for this task (e.g. the provider process
    // restarted): the container's age is the only signal, and it is far
    // older than the TTL.
    await (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    expect(fake.calls).toContainEqual(["rm", "-f", "cid-abandoned"]);
  });

  it("does not reap a container whose task still has fresh activity", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "ps") return { code: 0, stdout: `cid-live\t${TASK}\n` };
      if (argv[0] === "inspect" && argv.includes("{{.Created}}")) {
        return { code: 0, stdout: `${OLD}\n` };
      }
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
        return { code: 0, stdout: "true\n" };
      }
      return undefined;
    });
    const provider = makeProvider(fake, { ttlMs: 60_000 });
    const source = await makeSource("valmont-src-");
    await provider.create(TASK, source); // records fresh activity
    await (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    // Old by age but active by its last operation: the reaper must not have
    // removed its container (create's own startup cleanup is unrelated).
    expect(
      fake.calls.some(
        (argv) =>
          argv[0] === "rm" && argv[1] === "-f" && argv[2] === "cid-live",
      ),
    ).toBe(false);
  });

  it("waits on the per-task lock and re-checks activity before removal", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "ps") return { code: 0, stdout: `cid-locked\t${TASK}\n` };
      if (argv[0] === "inspect" && argv.includes("{{.Created}}")) {
        return { code: 0, stdout: `${OLD}\n` };
      }
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
        return { code: 0, stdout: "true\n" };
      }
      return undefined;
    });
    const provider = makeProvider(fake, { ttlMs: 60_000 });
    const state = provider as unknown as {
      taskLocks: Map<string, Promise<unknown>>;
      taskActivity: Map<string, number>;
    };
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    // A task the outer check calls abandoned (stale activity record), while
    // an operation still holds its queue slot (simulated with a manual gate).
    state.taskActivity.set(TASK, Date.now() - 120_000);
    state.taskLocks.set(TASK, gate);
    const reaping = (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The outer check fired, but removal must not bypass the per-task lock:
    // no rm while the gate (the in-flight operation) is held.
    expect(
      fake.calls.some((argv) => argv[0] === "rm" && argv[2] === "cid-locked"),
    ).toBe(false);
    // The operation recorded fresh activity at start; by the time the
    // reaper acquires the lock, the in-lock re-check must abort the removal.
    state.taskActivity.set(TASK, Date.now());
    releaseGate();
    await reaping;
    expect(
      fake.calls.some((argv) => argv[0] === "rm" && argv[2] === "cid-locked"),
    ).toBe(false);
  });

  it("defers removal when an operation queues while the reaper holds the lock", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    let queueLateOperation: () => void = () => undefined;
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "ps") return { code: 0, stdout: `cid-race\t${TASK}\n` };
      if (argv[0] === "inspect" && argv.includes("{{.Created}}")) {
        return { code: 0, stdout: `${OLD}\n` };
      }
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
        // A new operation enqueues exactly while the reaper is inside its
        // locked existence check: its withTaskLock call records activity
        // and changes the task's queue tail.
        queueLateOperation();
        return { code: 0, stdout: "true\n" };
      }
      return undefined;
    });
    const provider = makeProvider(fake, { ttlMs: 60_000 });
    queueLateOperation = () => {
      void provider.writeFile(HANDLE, "late.txt", "late");
    };
    const state = provider as unknown as { taskActivity: Map<string, number> };
    // Stale at the outer check — from here on only the queue-tail gate
    // protects the container.
    state.taskActivity.set(TASK, Date.now() - 120_000);
    await (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    // The reaper must have deferred: the newly queued operation is what
    // the container exists for, so no rm may have run.
    expect(
      fake.calls.some(
        (argv) =>
          argv[0] === "rm" && argv[1] === "-f" && argv[2] === "cid-race",
      ),
    ).toBe(false);
  });

  it("destroys the container when the git baseline fails", async () => {
    const fake = new FakeDocker().onMatch((argv) =>
      argv[0] === "exec" && argv.includes("commit")
        ? { code: 128, stderr: "boom" }
        : undefined,
    );
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await expect(provider.create(TASK, source)).rejects.toThrow();
    expect(
      fake.calls.some(
        (argv) =>
          argv[0] === "rm" && argv.includes("-f") && argv.includes(NAME),
      ),
    ).toBe(true);
    expect(fake.calls.some((argv) => argv[0] === "volume")).toBe(false);
  });

  it("opens a running workspace and reports unavailable ones", async () => {
    const running = new FakeDocker().onMatch((argv) =>
      argv[0] === "inspect" ? { code: 0, stdout: "true\n" } : undefined,
    );
    expect(await makeProvider(running).open(TASK)).toEqual(HANDLE);

    const missing = new FakeDocker().onMatch((argv) =>
      argv[0] === "inspect" ? { code: 1, stderr: "No such object" } : undefined,
    );
    await expect(makeProvider(missing).open(TASK)).rejects.toThrow(
      "Task workspace is unavailable",
    );
  });

  it("rejects traversal, absolute, and sensitive paths before any docker call", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    await expect(provider.readFile(HANDLE, "../../etc/passwd")).rejects.toThrow(
      "Invalid workspace path",
    );
    await expect(provider.readFile(HANDLE, "/etc/passwd")).rejects.toThrow(
      "Invalid workspace path",
    );
    await expect(provider.readFile(HANDLE, ".env.local")).rejects.toThrow(
      "Sensitive paths are blocked",
    );
    await expect(provider.writeFile(HANDLE, "../x", "y")).rejects.toThrow(
      "Invalid workspace path",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("reads files with a direct cat argv and redacts secrets", async () => {
    const raw = "some notes with a token line\n";
    const fake = new FakeDocker().onMatch((argv) =>
      argv[0] === "exec" && argv.includes("cat")
        ? { code: 0, stdout: raw }
        : undefined,
    );
    const content = await makeProvider(fake).readFile(HANDLE, "notes.md");
    expect(content).toBe(redactSecrets(raw));
    expect(
      callFor(fake, (argv) => argv[0] === "exec" && argv[6] === "cat"),
    ).toEqual([
      "exec",
      "--user",
      "node",
      "--workdir",
      "/workspace",
      NAME,
      "cat",
      "--",
      "/workspace/notes.md",
    ]);
  });

  it("treats over-limit file reads as errors", async () => {
    const fake = new FakeDocker().onMatch((argv) =>
      argv[0] === "exec" && argv.includes("cat")
        ? { code: 0, stdout: "x".repeat(1000) }
        : undefined,
    );
    const provider = makeProvider(fake, { outputLimitBytes: 64 });
    await expect(provider.readFile(HANDLE, "big.txt")).rejects.toThrow(
      "Workspace file exceeds the output limit",
    );
  });

  it("blocks sensitive writes before any docker call", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    await expect(
      provider.writeFile(HANDLE, ".env", "SECRET=1"),
    ).rejects.toThrow("Writing sensitive paths is blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("copies files via docker cp and fixes ownership with a root chown", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).writeFile(HANDLE, "src/a.txt", "hello");
    // docker cp has no --chown support: the copy must not carry one.
    const cpCall = callFor(fake, (argv) => argv[0] === "cp");
    expect(cpCall).not.toContain("--chown");
    expect(cpCall.at(-1)).toBe(`${NAME}:/workspace/src/a.txt`);
    // The ancestor verification (stat) runs before the copy.
    const statIdx = fake.calls.findIndex(
      (argv) => argv[0] === "exec" && argv[6] === "stat",
    );
    expect(statIdx).toBeGreaterThan(-1);
    expect(statIdx).toBeLessThan(fake.calls.indexOf(cpCall));
    // The host-side temp file is removed after the copy.
    await expect(access(cpCall[1])).rejects.toThrow();
    // A controlled root chown fixes the file and its (newly created) parent
    // directories, so writes work when parents do not exist yet and task
    // code (node) can read them afterwards.
    const chownCall = callFor(
      fake,
      (argv) => argv[0] === "exec" && argv[6] === "chown",
    );
    expect(chownCall).toEqual([
      "exec",
      "--user",
      "root",
      "--workdir",
      "/workspace",
      NAME,
      "chown",
      "node:node",
      "/workspace",
      "/workspace/src",
      "/workspace/src/a.txt",
    ]);
  });

  it("creates missing parent directories before the copy for nested writes", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      // /workspace/src does not exist yet; everything above it does.
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/src"
      ) {
        return {
          code: 1,
          stderr: "cannot statx '/workspace/src': No such file or directory",
        };
      }
      return undefined;
    });
    const provider = makeProvider(fake);
    await provider.writeFile(HANDLE, "src/nested/a.txt", "nested");

    const statMissing = fake.calls.findIndex(
      (argv) =>
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/src",
    );
    const mkdir = fake.calls.findIndex(
      (argv) => argv[0] === "exec" && argv[6] === "mkdir",
    );
    const cpIdx = fake.calls.findIndex((argv) => argv[0] === "cp");
    // Parent setup happens before docker cp — in that order.
    expect(statMissing).toBeGreaterThan(-1);
    expect(mkdir).toBeGreaterThan(statMissing);
    expect(cpIdx).toBeGreaterThan(mkdir);

    // Fixed-argv root setup only; mkdir -p targets the first missing ancestor.
    expect(fake.calls[mkdir]).toEqual([
      "exec",
      "--user",
      "root",
      "--workdir",
      "/workspace",
      NAME,
      "mkdir",
      "-p",
      "/workspace/src",
    ]);
    const cpCall = callFor(fake, (argv) => argv[0] === "cp");
    expect(cpCall).not.toContain("--chown");
    expect(cpCall.at(-1)).toBe(`${NAME}:/workspace/src/nested/a.txt`);

    // The created ancestors and the file land node-owned via the root chown.
    const chownCall = callFor(
      fake,
      (argv) => argv[0] === "exec" && argv[6] === "chown",
    );
    expect(chownCall).toEqual([
      "exec",
      "--user",
      "root",
      "--workdir",
      "/workspace",
      NAME,
      "chown",
      "node:node",
      "/workspace",
      "/workspace/src",
      "/workspace/src/nested",
      "/workspace/src/nested/a.txt",
    ]);
  });

  it("rejects symlinked or file ancestors before any copy happens", async () => {
    const symlinked = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/evil"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(symlinked).writeFile(HANDLE, "evil/a.txt", "x"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(symlinked.calls.some((argv) => argv[0] === "cp")).toBe(false);
    expect(
      symlinked.calls.some((argv) => argv[0] === "exec" && argv[6] === "mkdir"),
    ).toBe(false);

    const fileAncestor = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/blob"
      ) {
        return { code: 0, stdout: "regular file\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fileAncestor).writeFile(HANDLE, "blob/a.txt", "x"),
    ).rejects.toThrow("Invalid workspace path");
    expect(fileAncestor.calls.some((argv) => argv[0] === "cp")).toBe(false);
  });

  it("readFile rejects symlinked components before any read happens", async () => {
    // A task-created symlink as the final target must not be followed.
    const targetLink = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/link.txt"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(targetLink).readFile(HANDLE, "link.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(targetLink.calls.some((argv) => argv[6] === "cat")).toBe(false);

    // ... and so must a symlinked ancestor (the /etc-leak vector).
    const ancestorLink = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/leaky"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(ancestorLink).readFile(HANDLE, "leaky/notes.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(ancestorLink.calls.some((argv) => argv[6] === "cat")).toBe(false);

    // A missing target keeps the not-found semantics without running cat.
    const missing = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/gone.txt"
      ) {
        return {
          code: 1,
          stderr:
            "cannot statx '/workspace/gone.txt': No such file or directory",
        };
      }
      return undefined;
    });
    await expect(
      makeProvider(missing).readFile(HANDLE, "gone.txt"),
    ).rejects.toThrow("Could not read workspace file");
    expect(missing.calls.some((argv) => argv[6] === "cat")).toBe(false);
  });

  it("readFileForCommit rejects symlinked components so no foreign content is committed", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/leaky"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fake).readFileForCommit(HANDLE, "leaky/notes.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(fake.calls.some((argv) => argv[6] === "cat")).toBe(false);
  });

  it("deleteFile rejects symlinked components before any delete happens", async () => {
    const ancestorLink = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/leaky"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(ancestorLink).deleteFile(HANDLE, "leaky/a.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(ancestorLink.calls.some((argv) => argv[6] === "rm")).toBe(false);

    const targetLink = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/link.txt"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(targetLink).deleteFile(HANDLE, "link.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(targetLink.calls.some((argv) => argv[6] === "rm")).toBe(false);
  });

  it("writeFile rejects an existing symlink as its final target", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      if (
        argv[0] === "exec" &&
        argv[6] === "stat" &&
        argv.at(-1) === "/workspace/link.txt"
      ) {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fake).writeFile(HANDLE, "link.txt", "x"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(fake.calls.some((argv) => argv[0] === "cp")).toBe(false);
    expect(fake.calls.some((argv) => argv[6] === "chown")).toBe(false);
  });

  it("deletes files with a direct rm argv", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).deleteFile(HANDLE, "src/a.txt");
    expect(
      callFor(fake, (argv) => argv[0] === "exec" && argv[6] === "rm"),
    ).toEqual([
      "exec",
      "--user",
      "node",
      "--workdir",
      "/workspace",
      NAME,
      "rm",
      "--",
      "/workspace/src/a.txt",
    ]);
  });

  it("rejects commands that are not allowlisted", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    await expect(provider.runValidation(HANDLE, "npm install")).rejects.toThrow(
      "Validation command is not allowlisted: npm install",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("blocks deployment and migration commands even when explicitly allowlisted", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake, {
      allowedCommands: {
        "npm run deploy": ["npm", "run", "deploy"],
      },
    });
    await expect(
      provider.runValidation(HANDLE, "npm run deploy"),
    ).rejects.toThrow(
      "Deployments and database migrations are never run automatically",
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("runs the exact allowlisted argv and maps exit codes to statuses", async () => {
    for (const [code, status] of [
      [0, "passed"],
      [1, "failed"],
      [124, "timed_out"],
    ] as const) {
      const fake = new FakeDocker().onMatch((argv) => {
        if (argv[0] !== "exec") return undefined;
        // The post-validation reaper exec must succeed for the run to be
        // reported at all.
        if (argv[6] === "node") return { code: 0, stderr: "" };
        return { code, stderr: code === 0 ? "" : "failure" };
      });
      const result = await makeProvider(fake).runValidation(HANDLE, "npm test");
      expect(result.status).toBe(status);
      expect(result.command).toBe("npm test");
      expect(result.exitCode).toBe(code);
      // Exact validation argv: direct argv under the wall-clock timeout,
      // no shell, and no namespace syscalls (seccomp=default forbids them).
      const timeoutCall = callFor(
        fake,
        (argv) => argv[0] === "exec" && argv[6] === "timeout",
      );
      expect(timeoutCall).toEqual([
        "exec",
        "--user",
        "node",
        "--workdir",
        "/workspace",
        NAME,
        "timeout",
        "--signal=KILL",
        "180",
        "npm",
        "test",
      ]);
      // After every validation run — pass, fail, or timeout — a fixed root
      // exec of the staged reaper kills everything the validation started.
      const reap = callFor(
        fake,
        (argv) => argv[0] === "exec" && argv[6] === "node",
      );
      expect(reap.slice(0, 7)).toEqual([
        "exec",
        "--user",
        "root",
        "--workdir",
        "/workspace",
        NAME,
        "node",
      ]);
      expect(reap[7]).toBe("/workspace/.valmont/validation-reap.mjs");
      expect(Number.isInteger(Number(reap[8]))).toBe(true);
      expect(fake.calls.indexOf(reap)).toBeGreaterThan(
        fake.calls.indexOf(timeoutCall),
      );
    }
  });

  it("treats a failed validation cleanup as a failed validation", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv[6] === "node") {
        return { code: 1, stderr: "a validation process could not be killed" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fake).runValidation(HANDLE, "npm test"),
    ).rejects.toThrow("Could not complete validation cleanup");
  });

  it("destroy removes the container and its workspace storage", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).destroy(TASK);
    // The tmpfs workspace dies with the container; there is no volume.
    expect(fake.calls).toContainEqual(["rm", "-f", NAME]);
    expect(fake.calls).toHaveLength(1);
  });
});
