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

  onMatch(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  spawn(_command: string, args: readonly string[]) {
    this.calls.push([...args]);
    let result: Scripted = { code: 0, stdout: "", stderr: "" };
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
    setImmediate(() => {
      stdout.emit("data", Buffer.from(result.stdout ?? ""));
      stderr.emit("data", Buffer.from(result.stderr ?? ""));
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
const VOLUME = `valmont-workspace-${TASK}`;
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
    // The only mount is the task's own named volume.
    expect(create).toContain(`${VOLUME}:/workspace`);
    const volumeFlags = create.filter((flag) => flag === "-v");
    expect(volumeFlags).toHaveLength(1);
    // Labels for the TTL reaper; the image is the final create argument.
    expect(create).toContain("valmont.managed=true");
    expect(create).toContain(`valmont.task=${TASK}`);
    expect(create.at(-1)).toBe("valmont-sandbox:local");
    // No environment variables ever enter the container: credentials cannot.
    expect(create).not.toContain("-e");
    expect(create).not.toContain("--env");

    // The git baseline (and every other exec) runs as the unprivileged user.
    const execs = fake.calls.filter((argv) => argv[0] === "exec");
    expect(execs.length).toBeGreaterThanOrEqual(3);
    for (const exec of execs) {
      expect(exec.slice(1, 3)).toEqual(["--user", "node"]);
    }
    expect(
      fake.calls.some((argv) => argv[0] === "exec" && argv.includes("commit")),
    ).toBe(true);
  });

  it("destroys the container and volume when the git baseline fails", async () => {
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
    expect(
      fake.calls.some(
        (argv) =>
          argv[0] === "volume" && argv[1] === "rm" && argv.includes(VOLUME),
      ),
    ).toBe(true);
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
    expect(callFor(fake, (argv) => argv[0] === "exec")).toEqual([
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
      argv[0] === "exec" ? { code: 0, stdout: "x".repeat(1000) } : undefined,
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

  it("writes files through docker cp with ownership transfer", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).writeFile(HANDLE, "src/a.txt", "hello");
    const cpCall = callFor(
      fake,
      (argv) => argv[0] === "cp" && argv.includes("--chown"),
    );
    expect(cpCall[1]).toBe("--chown");
    expect(cpCall[2]).toBe("node:node");
    expect(cpCall.at(-1)).toBe(`${NAME}:/workspace/src/a.txt`);
    // The host-side temp file is removed after the copy.
    await expect(access(cpCall[3])).rejects.toThrow();
  });

  it("deletes files with a direct rm argv", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).deleteFile(HANDLE, "src/a.txt");
    expect(callFor(fake, (argv) => argv[0] === "exec")).toEqual([
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
      const fake = new FakeDocker().onMatch((argv) =>
        argv[0] === "exec"
          ? { code, stderr: code === 0 ? "" : "failure" }
          : undefined,
      );
      const result = await makeProvider(fake).runValidation(HANDLE, "npm test");
      expect(result.status).toBe(status);
      expect(result.command).toBe("npm test");
      expect(result.exitCode).toBe(code);
      expect(callFor(fake, (argv) => argv[0] === "exec")).toEqual([
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
    }
  });

  it("destroy removes the container and volume", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).destroy(TASK);
    expect(fake.calls).toContainEqual(["rm", "-f", NAME]);
    expect(fake.calls).toContainEqual(["volume", "rm", VOLUME]);
  });
});
