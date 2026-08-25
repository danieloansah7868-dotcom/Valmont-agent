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
    if (
      args[0] === "exec" &&
      args[6] === "stat" &&
      args[7] === "-c" &&
      args[8] === "%F"
    ) {
      // Default: a plausible healthy workspace — directory components are
      // real directories, and a component that looks like a file (a dot in
      // its name) is a regular file. Tests override via onMatch to simulate
      // missing, symlinked, or otherwise unsafe path components.
      const target = args[args.length - 1] ?? "";
      const kind = target.includes(".") ? "regular file" : "directory";
      result = { code: 0, stdout: `${kind}\n` };
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
      if (exec[6] === "chown") {
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
        // Write-path setup: create missing parents only, as root.
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
        expect(command.slice(1, 2)).toEqual(["-p"]);
        expect(command[2].startsWith("/workspace")).toBe(true);
      } else if (command[0] === "stat") {
        // Write-path setup: verify ancestors are real directories, as root.
        expect(exec.slice(1, 3)).toEqual(["--user", "root"]);
        expect(command.slice(1, 3)).toEqual(["-c", "%F"]);
        expect(command[3].startsWith("/workspace")).toBe(true);
      } else {
        // Arbitrary task code (git, cat, rm, timeout+validation): never root.
        expect(exec.slice(1, 3)).toEqual(["--user", "node"]);
      }
    }
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

  it("destroy removes the container and its workspace storage", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).destroy(TASK);
    // The tmpfs workspace dies with the container; there is no volume.
    expect(fake.calls).toContainEqual(["rm", "-f", NAME]);
    expect(fake.calls).toHaveLength(1);
  });
});
