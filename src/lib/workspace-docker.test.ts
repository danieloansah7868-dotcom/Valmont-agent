import { EventEmitter } from "node:events";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { access, mkdtemp, symlink, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
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

interface DockerCall {
  command: string;
  args: string[];
  stdinPath?: string;
}

interface FakeSpawnOptions {
  stdio: string[];
  env: unknown;
  stdinPath?: string;
}

/**
 * Records every CLI invocation (docker AND host-side tar) and simulates a
 * container well enough to assert the provider's behaviour without a Docker
 * daemon: host-side tar archives are real files (written/parsed with a
 * minimal ustar codec), and the in-container `tar -xf -` execs apply their
 * archive contents to `containerFiles`, the simulated /workspace.
 */
class FakeDocker {
  readonly calls: DockerCall[] = [];
  private readonly handlers: Handler[] = [];
  /** Simulated CLI latency, so overlapping operations would interleave. */
  private readonly delayMs: number;
  private inFlightCount = 0;
  /** Highest number of concurrently in-flight CLI invocations. */
  maxInFlight = 0;
  /** Simulated /workspace: relative path -> content. */
  readonly containerFiles = new Map<string, Buffer>();
  createArgs: string[] | undefined;
  readonly cpCalls: string[][] = [];
  /** File modes (0o777) of every docker cp source at the time of the copy. */
  readonly cpSourceModes: number[] = [];
  /** Every `docker rm -f <target>` target, in order. */
  readonly rmTargets: string[] = [];
  /** Scripted results for `docker rm -f`, consumed one per removal. */
  readonly rmResults: Scripted[] = [];
  /** Host-side `tar -cf ...` invocations. */
  readonly hostTarCalls: string[][] = [];
  /** Copies of each host-side archive, for content assertions. */
  readonly hostTarArchives: Buffer[] = [];
  /** In-container `tar` execs (staging / file writes / git excludes). */
  readonly execTarCalls: {
    user: string;
    argv: string[];
    stdinPath?: string;
  }[] = [];
  /** Hooked while a `docker rm -f` is in flight (before it returns). */
  onRm: ((target: string) => void) | undefined;
  private lastHostTarArchive: string | undefined;

  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  onMatch(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  private defaultResult(
    command: string,
    args: readonly string[],
    options: FakeSpawnOptions,
  ): Scripted {
    if (command === "tar") {
      // Host-side archive creation: `tar -cf <archive> -C <cwd> <members...>`
      const archive = args[1] ?? "";
      const cwd = args[3] ?? "";
      this.hostTarCalls.push([...args]);
      const entries: { name: string; content: Buffer }[] = [];
      for (const member of args.slice(4)) {
        if (member === ".") {
          const walk = (dir: string, prefix: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const abs = path.join(dir, entry.name);
              const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                // Directory members are kept (as real tar writes them) so
                // empty directories are visible in the archive.
                entries.push({ name: `./${rel}/`, content: Buffer.alloc(0) });
                walk(abs, rel);
              } else if (entry.isFile()) {
                entries.push({
                  name: `./${rel}`,
                  content: readFileSync(abs),
                });
              }
            }
          };
          walk(cwd, "");
        } else {
          const abs = path.join(cwd, member);
          if (!statSync(abs).isFile()) {
            return { code: 2, stderr: `tar: ${member}: Not a directory` };
          }
          entries.push({ name: member, content: readFileSync(abs) });
        }
      }
      writeTarFile(archive, entries);
      this.hostTarArchives.push(readFileSync(archive));
      this.lastHostTarArchive = archive;
      return { code: 0 };
    }
    if (command !== "docker") {
      return { code: 127, stderr: `unexpected command: ${command}` };
    }
    switch (args[0]) {
      case "create":
        this.createArgs = [...args];
        return { code: 0 };
      case "start":
        return { code: 0 };
      case "exec":
        return this.execDefault(args, options);
      case "cp": {
        this.cpCalls.push([...args]);
        try {
          this.cpSourceModes.push(statSync(args[1]).mode & 0o777);
        } catch {
          this.cpSourceModes.push(-1);
        }
        return { code: 0 };
      }
      case "rm": {
        if (args[1] !== "-f") return { code: 0 };
        const target = args[2] ?? "";
        this.rmTargets.push(target);
        // The hook runs while the removal is in flight — the exact window
        // an operation can enqueue into.
        const scripted = this.rmResults.shift();
        this.onRm?.(target);
        return scripted ?? { code: 0 };
      }
      case "ps":
        return { code: 0, stdout: "" };
      case "inspect":
        return { code: 0, stdout: "true\n" };
      default:
        return {
          code: 127,
          stderr: `unexpected docker subcommand: ${args[0]}`,
        };
    }
  }

  private execDefault(
    args: readonly string[],
    options: FakeSpawnOptions,
  ): Scripted {
    const withI = args[1] === "-i";
    const user = args[withI ? 3 : 2] ?? "";
    const cmdIdx = withI ? 7 : 6;
    const command = args[cmdIdx] ?? "";
    if (command === "stat") {
      const target = args[args.length - 1] ?? "";
      const format = args[cmdIdx + 2] ?? "";
      if (format === "%u %g %a") return { code: 0, stdout: "0 0 700\n" };
      if (format === "%u %g %a %F")
        return { code: 0, stdout: "0 0 644 regular file\n" };
      // %F default: a plausible healthy workspace — directory components
      // are real directories, and a component that looks like a file (a
      // dot in its name) is a regular file. Tests override via onMatch to
      // simulate missing, symlinked, or otherwise unsafe components.
      const kind = target.includes(".") ? "regular file" : "directory";
      return { code: 0, stdout: `${kind}\n` };
    }
    if (command === "tar") {
      const stdinPath = options.stdinPath ?? this.lastHostTarArchive;
      this.execTarCalls.push({
        user,
        argv: [...args.slice(cmdIdx)],
        stdinPath,
      });
      // Apply the extracted archive to the simulated /workspace.
      if (stdinPath && existsSync(stdinPath)) {
        for (const entry of readTarFile(stdinPath)) {
          const name = entry.name.startsWith("./")
            ? entry.name.slice(2)
            : entry.name;
          this.containerFiles.set(name, entry.content);
        }
      }
      return { code: 0 };
    }
    if (command === "cat") {
      const target = args[args.length - 1] ?? "";
      const content = this.containerFiles.get(
        target.replace(/^\/workspace\//, ""),
      );
      if (content === undefined) {
        return {
          code: 1,
          stderr: `cat: ${target}: No such file or directory`,
        };
      }
      return { code: 0, stdout: content.toString("utf8") };
    }
    if (command === "chown") {
      // chown is NOT available in a --cap-drop ALL container; if the
      // provider ever attempts it, this fails loudly.
      return { code: 127, stderr: "chown: not available in the sandbox" };
    }
    if (command === "git" || command === "rm" || command === "mkdir") {
      return { code: 0 };
    }
    // node (the validation reaper) and timeout (validation runs) succeed by
    // default; tests script failures and specific exit codes.
    return { code: 0 };
  }

  spawn(command: string, args: readonly string[], options: FakeSpawnOptions) {
    this.calls.push({ command, args: [...args], stdinPath: options.stdinPath });
    let result: Scripted = this.defaultResult(command, args, options);
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
    const stdin =
      options.stdio[0] === "pipe"
        ? new Writable({
            write(_chunk: Buffer, _encoding: string, callback: () => void) {
              callback();
            },
          })
        : undefined;
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
      stdin,
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

/** Minimal ustar writer: regular files only, 512-byte blocks. */
function writeTarFile(
  archive: string,
  entries: { name: string; content: Buffer }[],
): void {
  const blocks: Buffer[] = [];
  for (const { name, content } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000100\0", 108, "ascii");
    header.write("0000100\0", 116, "ascii");
    header.write(
      `${content.length.toString(8).padStart(11, "0")}\0`,
      124,
      "ascii",
    );
    header.write("00000000000\0", 136, "ascii");
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    blocks.push(header);
    for (let offset = 0; offset < content.length; offset += 512) {
      blocks.push(content.subarray(offset, offset + 512));
    }
    const remainder = content.length % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(archive, Buffer.concat(blocks));
}

function readTarFile(archive: string): { name: string; content: Buffer }[] {
  const buf = readFileSync(archive);
  const entries: { name: string; content: Buffer }[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").trim();
    const size = Number.parseInt(sizeField || "0", 8);
    if (name === "" && size === 0) break;
    entries.push({ name, content: buf.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
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
  predicate: (call: DockerCall) => boolean,
): DockerCall {
  const call = fake.calls.find(predicate);
  if (!call) throw new Error("expected CLI call not found");
  return call;
}

/** One word per CLI call, in order: `host-tar`, `create`, `exec:stat`, ... */
function opsOf(fake: FakeDocker): string[] {
  return fake.calls.map((call) => {
    if (call.command === "tar") return "host-tar";
    if (call.args[0] === "exec") {
      const command = call.args[call.args[1] === "-i" ? 7 : 6];
      return `exec:${command}`;
    }
    return call.args[0];
  });
}

const TASK = "task-1";
const NAME = `valmont-sandbox-${TASK}`;
const HANDLE = { id: TASK, root: "/workspace" };

async function makeSource(root: string): Promise<string> {
  const source = await mkdtemp(path.join(tmpdir(), root));
  await writeFile(path.join(source, "README.md"), "# hello\n");
  return source;
}

async function createTask(
  fake: FakeDocker,
  provider: DockerWorkspaceProvider,
  source?: string,
): Promise<void> {
  const root = source ?? (await makeSource("valmont-src-"));
  await provider.create(TASK, root);
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

  it("refuses to run task code as root", () => {
    for (const user of ["root", "0", "0:0", "root:0", " : "]) {
      expect(() => new DockerWorkspaceProvider({ image: "x", user })).toThrow(
        /unprivileged/,
      );
    }
    expect(() => new DockerWorkspaceProvider({ image: "x", uid: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new DockerWorkspaceProvider({ image: "x", gid: 0 })).toThrow(
      /positive integer/,
    );
    expect(
      () => new DockerWorkspaceProvider({ image: "x", uid: 1001, gid: 0 }),
    ).toThrow(/positive integer/);
  });

  it("fromEnv rejects a root sandbox user", () => {
    expect(() =>
      DockerWorkspaceProvider.fromEnv({
        VALMONT_SANDBOX_USER: "root",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/unprivileged/);
  });

  it("creates one hardened, credential-free container per task", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    // A source-supplied symlink must never reach the container.
    await symlink(path.join(source, "README.md"), path.join(source, "link.md"));
    const handle = await provider.create(TASK, source);
    expect(handle).toEqual({ id: TASK, root: "/workspace" });

    const create = callFor(fake, (c) => c.args[0] === "create").args;
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
    // uid=/gid= own the tmpfs root with the sandbox user, so task code and
    // the provider's tar extraction write into it without any chown.
    expect(create.filter((flag) => flag === "--tmpfs")).toHaveLength(1);
    expect(create[create.indexOf("--tmpfs") + 1]).toBe(
      "/workspace:rw,nosuid,nodev,size=2147483648,uid=1000,gid=1000",
    );
    // The container runs as the unprivileged user from CREATE time (no
    // in-container chown/setpriv bootstrap — none could run under
    // --cap-drop ALL) and --init so PID 1 reaps zombies.
    expect(create[create.indexOf("--user") + 1]).toBe("1000:1000");
    expect(create).toContain("--init");
    expect(create).not.toContain("-v");
    // Labels for the TTL reaper; the image is the final create argument.
    expect(create).toContain("valmont.managed=true");
    expect(create).toContain(`valmont.task=${TASK}`);
    expect(create.at(-1)).toBe("valmont-sandbox:local");
    // No environment variables ever enter the container: credentials cannot.
    expect(create).not.toContain("-e");
    expect(create).not.toContain("--env");
    // Only the docker CLI and host-side tar are ever invoked.
    expect(
      fake.calls.every((c) => c.command === "docker" || c.command === "tar"),
    ).toBe(true);
    // No chown anywhere in the lifecycle (root would need CAP_CHOWN).
    expect(
      fake.calls.some(
        (c) => c.command === "docker" && c.args.includes("chown"),
      ),
    ).toBe(false);

    // Custom uid/gid/user flow into the create-time flags.
    const custom = new FakeDocker();
    const customProvider = makeProvider(custom, {
      user: "appuser",
      uid: 1001,
      gid: 2002,
    });
    await createTask(custom, customProvider, source);
    const customCreate = custom.createArgs as string[];
    expect(customCreate[customCreate.indexOf("--user") + 1]).toBe("1001:2002");
    expect(customCreate[customCreate.indexOf("--tmpfs") + 1]).toBe(
      "/workspace:rw,nosuid,nodev,size=2147483648,uid=1001,gid=2002",
    );
    expect(custom.execTarCalls[0].user).toBe("appuser");

    // Staging: host-side tar (archive NEXT TO staging, never inside it),
    // extracted IN the container AS the unprivileged user.
    const [, stagingArchive, , stagingCwd] = fake.hostTarCalls[0];
    expect(fake.hostTarCalls[0]).toEqual([
      "-cf",
      stagingArchive,
      "-C",
      stagingCwd,
      ".",
    ]);
    expect(stagingArchive).toBe(`${stagingCwd}.tar`);
    expect(fake.execTarCalls[0].user).toBe("node");
    expect(fake.execTarCalls[0].argv).toEqual([
      "tar",
      "-xf",
      "-",
      "-C",
      "/workspace",
    ]);
    expect(fake.execTarCalls[0].stdinPath).toBe(stagingArchive);
    // The symlink never reached the container; package-manager scratch
    // (.home/.tmp) is staged as part of the workspace.
    expect(fake.containerFiles.has("README.md")).toBe(true);
    expect(fake.containerFiles.has("link.md")).toBe(false);
    const stagingBytes = fake.hostTarArchives[0].toString("utf8");
    expect(stagingBytes).toContain("./.home");
    expect(stagingBytes).toContain("./.tmp");
    expect(stagingBytes).not.toContain("./link.md");

    // The validation reaper is staged into a root-only directory AFTER the
    // staging extraction and before the git baseline (.valmont/ is
    // git-excluded). docker cp (a daemon-side, root-privileged operation)
    // is the only in-container placement that needs no capability; the
    // host file mode (0644: other-readable for the unprivileged reaper,
    // no write path) is preserved by the copy.
    const ops = opsOf(fake);
    const rmValmont = fake.calls.findIndex(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "exec" &&
        c.args.slice(6).join(" ") === "rm -rf -- /workspace/.valmont",
    );
    const mkdirValmont = fake.calls.findIndex(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "exec" &&
        c.args.slice(6).join(" ") === "mkdir -m 0700 /workspace/.valmont",
    );
    const cpReaper = fake.calls.findIndex(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "cp" &&
        c.args.at(-1) === `${NAME}:/workspace/.valmont/validation-reap.mjs`,
    );
    const statDir = fake.calls.findIndex(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "exec" &&
        c.args.slice(6).join(" ") === "stat -c %u %g %a /workspace/.valmont",
    );
    const statScript = fake.calls.findIndex(
      (c) =>
        c.command === "docker" &&
        c.args[0] === "exec" &&
        c.args.slice(6).join(" ") ===
          "stat -c %u %g %a %F /workspace/.valmont/validation-reap.mjs",
    );
    expect(rmValmont).toBeGreaterThan(-1);
    expect(mkdirValmont).toBeGreaterThan(rmValmont);
    expect(cpReaper).toBeGreaterThan(mkdirValmont);
    expect(cpReaper).toBeGreaterThan(ops.indexOf("exec:tar"));
    expect(statDir).toBeGreaterThan(cpReaper);
    expect(statScript).toBeGreaterThan(statDir);
    // The reaper script is the ONLY docker cp in the whole lifecycle (the
    // git exclude is staged with tar, like file writes).
    expect(fake.cpCalls).toHaveLength(1);
    expect(fake.cpSourceModes).toEqual([0o644]);
    // All four reaper-staging execs are fixed-argv root; the .valmont
    // cleanup is the only root rm, the reaper dir the only root mkdir.
    for (const index of [rmValmont, mkdirValmont, statDir, statScript]) {
      expect(fake.calls[index].args.slice(1, 3)).toEqual(["--user", "root"]);
    }
    // The .valmont rm/mkdir are the ONLY root execs in the lifecycle
    // (besides the stat verifications above): no root tar, chown, git, or
    // cat anywhere.
    expect(
      fake.calls.filter(
        (c) =>
          c.command === "docker" &&
          c.args[0] === "exec" &&
          (c.args[1] === "-i" ? c.args[3] : c.args[2]) === "root",
      ).length,
    ).toBe(4);

    // The git exclude is staged via the same tar-as-user mechanism: host
    // tar AFTER `git init`, in-container extraction BEFORE `git add`.
    expect(fake.hostTarCalls[1]).toEqual([
      "-cf",
      fake.hostTarCalls[1][1],
      "-C",
      fake.hostTarCalls[1][3],
      ".git/info/exclude",
    ]);
    const gitInitIdx = fake.calls.findIndex(
      (c) =>
        c.command === "docker" && c.args.slice(6).join(" ") === "git init -q",
    );
    const gitAddIdx = fake.calls.findIndex(
      (c) =>
        c.command === "docker" && c.args.slice(6).join(" ") === "git add -A",
    );
    const excludeHostTarIdx = fake.calls.findIndex(
      (c) => c.command === "tar" && c.args.at(-1) === ".git/info/exclude",
    );
    const excludeExtractIdx = fake.calls.findIndex(
      (c, i) =>
        i > excludeHostTarIdx &&
        c.command === "docker" &&
        c.args[0] === "exec" &&
        c.args[1] === "-i",
    );
    expect(excludeHostTarIdx).toBeGreaterThan(gitInitIdx);
    expect(excludeExtractIdx).toBeGreaterThan(excludeHostTarIdx);
    expect(gitAddIdx).toBeGreaterThan(excludeExtractIdx);
    expect(
      fake.calls.some(
        (c) => c.command === "docker" && c.args.includes("commit"),
      ),
    ).toBe(true);
  });

  it("fails creation when the staged reaper script is not root-owned 0644", async () => {
    const fake = new FakeDocker().onMatch((argv) =>
      argv[0] === "exec" &&
      argv.slice(6).join(" ") ===
        "stat -c %u %g %a %F /workspace/.valmont/validation-reap.mjs"
        ? { code: 0, stdout: "0 0 600 regular file\n" }
        : undefined,
    );
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await expect(provider.create(TASK, source)).rejects.toThrow(
      "Could not verify the validation reaper script",
    );
    // The failed setup destroys the container (cleanup checks rm results).
    expect(fake.rmTargets).toContain(NAME);
  });

  it("runs arbitrary task code only as the unprivileged user", async () => {
    const fake = new FakeDocker();
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await provider.create(TASK, source);
    await provider.writeFile(HANDLE, "src/new.txt", "x");
    await provider.runValidation(HANDLE, "npm test");
    // The root vocabulary is exactly: the fixed .valmont rm, the fixed
    // .valmont mkdir, and stat (path-component verification + the fixed
    // reaper-staging verifications). chown, node, tar, git, cat are never
    // root — arbitrary task code is never root at all.
    for (const call of fake.calls) {
      if (call.command !== "docker" || call.args[0] !== "exec") continue;
      const withI = call.args[1] === "-i";
      const user = call.args[withI ? 3 : 2];
      const argv = call.args.slice(withI ? 7 : 6);
      if (user === "root") {
        if (argv[0] === "rm") {
          expect(argv.join(" ")).toBe("rm -rf -- /workspace/.valmont");
        } else if (argv[0] === "mkdir") {
          expect(argv).toEqual(["mkdir", "-m", "0700", "/workspace/.valmont"]);
        } else if (argv[0] === "stat") {
          expect(argv.slice(0, 2)).toEqual(["stat", "-c"]);
          if (argv[2] === "%F") {
            expect(argv[3].startsWith("/workspace")).toBe(true);
          } else if (argv[2] === "%u %g %a") {
            expect(argv[3]).toBe("/workspace/.valmont");
          } else if (argv[2] === "%u %g %a %F") {
            expect(argv[3]).toBe("/workspace/.valmont/validation-reap.mjs");
          } else {
            throw new Error(`unexpected root stat format: ${argv[2]}`);
          }
        } else {
          throw new Error(`unexpected root command: ${argv[0]}`);
        }
      } else {
        expect(user).toBe("node");
      }
    }
    // The post-validation reaper exec runs as the unprivileged user (the
    // same uid as the validation tree — SIGKILL needs no CAP_KILL).
    const reap = callFor(
      fake,
      (c) => c.command === "docker" && c.args[6] === "node",
    );
    expect(reap.args.slice(1, 3)).toEqual(["--user", "node"]);
  });

  it("writes files by extracting a host-built tar as the unprivileged user", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).writeFile(HANDLE, "src/a.txt", "hello café ☃");
    // No docker cp, no chown, no mkdir — verification (stat) and tar only.
    expect(fake.cpCalls).toHaveLength(0);
    expect(
      fake.calls.some(
        (c) =>
          c.command === "docker" &&
          (c.args.includes("chown") ||
            (c.args[0] === "exec" &&
              (c.args[6] === "mkdir" ||
                (c.args[1] === "-i" && c.args[7] === "mkdir")))),
      ),
    ).toBe(false);
    const ops = opsOf(fake);
    expect(ops.indexOf("exec:stat")).toBeGreaterThan(-1);
    expect(ops.indexOf("host-tar")).toBeGreaterThan(ops.indexOf("exec:stat"));
    // The host tar member IS the workspace-relative path (no host paths or
    // symlinks can be inside it); extraction is node, fed the host archive.
    expect(fake.hostTarCalls[0]).toEqual([
      "-cf",
      fake.hostTarCalls[0][1],
      "-C",
      fake.hostTarCalls[0][3],
      "src/a.txt",
    ]);
    const extract = fake.execTarCalls[0];
    expect(extract.user).toBe("node");
    expect(extract.argv).toEqual(["tar", "-xf", "-", "-C", "/workspace"]);
    expect(extract.stdinPath).toBe(fake.hostTarCalls[0][1]);
    // The file lands with its exact content, owned by the extracting user.
    expect(fake.containerFiles.get("src/a.txt")?.toString("utf8")).toBe(
      "hello café ☃",
    );
    // Host-side temp files (archive + scratch) are removed afterwards.
    const [, archive, , scratch] = fake.hostTarCalls[0];
    expect(existsSync(archive)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    await expect(access(archive)).rejects.toThrow();
  });

  it("creates missing parent directories via the tar extraction, not root mkdir", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      // /workspace/src does not exist yet; everything above it does.
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/src") {
        return {
          code: 1,
          stderr: "cannot statx '/workspace/src': No such file or directory",
        };
      }
      return undefined;
    });
    const provider = makeProvider(fake);
    await provider.writeFile(HANDLE, "src/nested/a.txt", "nested");

    // No mkdir exec at all: the ENOENT ancestor is created by the
    // extraction itself, as the unprivileged user.
    expect(
      fake.calls.some(
        (c) =>
          c.command === "docker" &&
          c.args[0] === "exec" &&
          c.args[c.args[1] === "-i" ? 7 : 6] === "mkdir",
      ),
    ).toBe(false);
    // The archive member carries the full relative path, so the extraction
    // creates every missing ancestor as the extracting user.
    expect(fake.hostTarCalls[0][4]).toBe("src/nested/a.txt");
    expect(fake.containerFiles.get("src/nested/a.txt")?.toString("utf8")).toBe(
      "nested",
    );
  });

  it("rejects symlinked or file ancestors before any staging happens", async () => {
    const symlinked = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/evil") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(symlinked).writeFile(HANDLE, "evil/a.txt", "x"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(symlinked.hostTarCalls).toHaveLength(0);
    expect(symlinked.execTarCalls).toHaveLength(0);
    expect(symlinked.cpCalls).toHaveLength(0);
    expect(
      symlinked.calls.some(
        (c) =>
          c.command === "docker" &&
          c.args[0] === "exec" &&
          c.args[c.args[1] === "-i" ? 7 : 6] === "mkdir",
      ),
    ).toBe(false);

    const fileAncestor = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/blob") {
        return { code: 0, stdout: "regular file\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fileAncestor).writeFile(HANDLE, "blob/a.txt", "x"),
    ).rejects.toThrow("Invalid workspace path");
    expect(fileAncestor.hostTarCalls).toHaveLength(0);
  });

  it("aborts path verification on a stat failure that is not ENOENT", async () => {
    // A permission or I/O failure on stat is NOT "missing": treating it as
    // missing would let the write proceed into an unverifiable path.
    for (const stderr of [
      "stat: cannot read file system: Permission denied",
      "stat: '/workspace/locked': Input/output error",
      "stat: cannot read file context of '/workspace/locked'",
    ]) {
      const fake = new FakeDocker().onMatch((argv) => {
        if (argv[0] === "exec" && argv.at(-1) === "/workspace/locked") {
          return { code: 1, stderr };
        }
        return undefined;
      });
      await expect(
        makeProvider(fake).writeFile(HANDLE, "locked/a.txt", "x"),
      ).rejects.toThrow("Workspace path verification failed");
      expect(fake.hostTarCalls).toHaveLength(0);
      expect(fake.execTarCalls).toHaveLength(0);
      expect(fake.containerFiles.size).toBe(0);
    }
    // Reads and deletes abort the same way, before any use.
    const readFake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/locked") {
        return { code: 1, stderr: "stat: Permission denied" };
      }
      return undefined;
    });
    await expect(
      makeProvider(readFake).readFile(HANDLE, "locked/a.txt"),
    ).rejects.toThrow("Workspace path verification failed");
    expect(
      readFake.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "cat",
      ),
    ).toBe(false);

    const deleteFake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/locked") {
        return { code: 1, stderr: "stat: I/O error" };
      }
      return undefined;
    });
    await expect(
      makeProvider(deleteFake).deleteFile(HANDLE, "locked/a.txt"),
    ).rejects.toThrow("Workspace path verification failed");
    expect(
      deleteFake.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "rm",
      ),
    ).toBe(false);
  });

  it("serializes overlapping operations for the same task", async () => {
    const fake = new FakeDocker(5);
    const provider = makeProvider(fake);
    const source = await makeSource("valmont-src-");
    await provider.create(TASK, source);
    fake.containerFiles.set("notes.md", Buffer.from("n\n"));
    await Promise.all([
      provider.readFile(HANDLE, "notes.md"),
      provider.writeFile(HANDLE, "src/x.txt", "x"),
      provider.deleteFile(HANDLE, "notes.md"),
      provider.runValidation(HANDLE, "npm test"),
    ]);
    // Per-task serialization: no CLI invocation from one operation can
    // overlap a CLI invocation from another operation on the same task.
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
    expect(fake.rmTargets).toContain("cid-abandoned");
  });

  it("removes a managed container with an invalid task label directly", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "ps") {
        return { code: 0, stdout: "cid-bad\tbad label!\n" };
      }
      return undefined;
    });
    const provider = makeProvider(fake, { ttlMs: 60_000 });
    await (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    // Removed directly (no valid task, so no per-task queue) — and the
    // reaper must NOT fall through to the task-queue logic for it (which
    // would inspect/create activity records under the invalid label).
    expect(fake.rmTargets).toEqual(["cid-bad"]);
    expect(
      fake.calls.some(
        (c) => c.command === "docker" && c.args.includes("{{.Created}}"),
      ),
    ).toBe(false);
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
    expect(fake.rmTargets).not.toContain("cid-live");
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
    expect(fake.rmTargets).not.toContain("cid-locked");
    // The operation recorded fresh activity at start; by the time the
    // reaper acquires the lock, the in-lock re-check must abort the removal.
    state.taskActivity.set(TASK, Date.now());
    releaseGate();
    await reaping;
    expect(fake.rmTargets).not.toContain("cid-locked");
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
    expect(fake.rmTargets).not.toContain("cid-race");
  });

  it("keeps the activity record when an operation enqueues during a failed removal", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    const CID = "cid-race2";
    let queued: Promise<unknown> | undefined;
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "ps") return { code: 0, stdout: `${CID}\t${TASK}\n` };
      if (argv[0] === "inspect" && argv.includes("{{.Created}}")) {
        return { code: 0, stdout: `${OLD}\n` };
      }
      if (argv[0] === "inspect" && argv.includes("{{.State.Running}}")) {
        return { code: 0, stdout: "true\n" };
      }
      return undefined;
    });
    const provider = makeProvider(fake, { ttlMs: 60_000 });
    const state = provider as unknown as { taskActivity: Map<string, number> };
    // Every removal fails while in flight (the container is busy); the hook
    // enqueues an operation mid-removal — exactly the window the conditional
    // activity delete closes.
    fake.rmResults.push({ code: 1, stderr: "Error: device or resource busy" });
    fake.onRm = (target) => {
      if (target === CID) {
        queued = provider.runValidation(HANDLE, "npm test");
      }
    };
    state.taskActivity.set(TASK, Date.now() - 120_000);
    await (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    // The operation enqueued during the in-flight removal still ran.
    await expect(queued).resolves.toBeDefined();
    // ... and its fresh activity record survived the failed removal (it was
    // enqueued AFTER the reaper's tail gate, so deleting it would resurrect
    // the race).
    expect(state.taskActivity.has(TASK)).toBe(true);
    expect(state.taskActivity.get(TASK)).toBeGreaterThan(Date.now() - 120_000);
    // A second reaper pass must now defer on the fresh record: no second
    // rm attempt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await (
      provider as unknown as { reapExpired: () => Promise<void> }
    ).reapExpired();
    expect(fake.rmTargets.filter((t) => t === CID)).toHaveLength(1);
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
    expect(fake.rmTargets).toContain(NAME);
  });

  it("destroys the container and its workspace storage", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).destroy(TASK);
    // The tmpfs workspace dies with the container; there is no volume.
    expect(fake.rmTargets).toEqual([NAME]);
    expect(
      fake.calls.every((c) => c.command === "docker" && c.args[0] === "rm"),
    ).toBe(true);
  });

  it("reports a failed container removal instead of claiming success", async () => {
    const fake = new FakeDocker();
    fake.rmResults.push({ code: 1, stderr: "Error: device or resource busy" });
    await expect(makeProvider(fake).destroy(TASK)).rejects.toThrow(
      "Could not remove sandbox container:",
    );
    expect(fake.rmTargets).toEqual([NAME]);
  });

  it("treats a missing container as a successful destroy", async () => {
    const fake = new FakeDocker();
    fake.rmResults.push({
      code: 1,
      stderr: `Error: No such container: ${NAME}`,
    });
    await expect(makeProvider(fake).destroy(TASK)).resolves.toBeUndefined();
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
      callFor(
        fake,
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "cat",
      ).args,
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

  it("readFile rejects symlinked components before any read happens", async () => {
    // A task-created symlink as the final target must not be followed.
    const targetLink = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/link.txt") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(targetLink).readFile(HANDLE, "link.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(
      targetLink.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "cat",
      ),
    ).toBe(false);

    // ... and so must a symlinked ancestor (the /etc-leak vector).
    const ancestorLink = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/leaky") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(ancestorLink).readFile(HANDLE, "leaky/notes.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(
      ancestorLink.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "cat",
      ),
    ).toBe(false);

    // A missing target keeps the not-found semantics without running cat.
    const missing = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/gone.txt") {
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
    expect(
      missing.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "cat",
      ),
    ).toBe(false);
  });

  it("readFileForCommit rejects symlinked components so no foreign content is committed", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/leaky") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fake).readFileForCommit(HANDLE, "leaky/notes.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(
      fake.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "cat",
      ),
    ).toBe(false);
  });

  it("deleteFile rejects symlinked components before any delete happens", async () => {
    const ancestorLink = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/leaky") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(ancestorLink).deleteFile(HANDLE, "leaky/a.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(
      ancestorLink.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "rm",
      ),
    ).toBe(false);

    const targetLink = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/link.txt") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(targetLink).deleteFile(HANDLE, "link.txt"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(
      targetLink.calls.some(
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "rm",
      ),
    ).toBe(false);
  });

  it("writeFile rejects an existing symlink as its final target", async () => {
    const fake = new FakeDocker().onMatch((argv) => {
      if (argv[0] === "exec" && argv.at(-1) === "/workspace/link.txt") {
        return { code: 0, stdout: "symbolic link\n" };
      }
      return undefined;
    });
    await expect(
      makeProvider(fake).writeFile(HANDLE, "link.txt", "x"),
    ).rejects.toThrow("Symlink path components are blocked");
    expect(fake.hostTarCalls).toHaveLength(0);
    expect(fake.execTarCalls).toHaveLength(0);
    expect(fake.cpCalls).toHaveLength(0);
  });

  it("deletes files with a direct rm argv", async () => {
    const fake = new FakeDocker();
    await makeProvider(fake).deleteFile(HANDLE, "src/a.txt");
    expect(
      callFor(
        fake,
        (c) =>
          c.command === "docker" && c.args[0] === "exec" && c.args[6] === "rm",
      ).args,
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
      [137, "timed_out"],
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
        (c) =>
          c.command === "docker" &&
          c.args[0] === "exec" &&
          c.args[6] === "timeout",
      );
      expect(timeoutCall.args).toEqual([
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
      // After every validation run — pass, fail, or timeout (124 = the
      // wrapper's own status, 137 = the killed child's status) — a fixed
      // exec of the staged reaper, AS THE UNPRIVILEGED USER, kills
      // everything the validation started.
      const reap = callFor(
        fake,
        (c) =>
          c.command === "docker" &&
          c.args[0] === "exec" &&
          c.args[6] === "node",
      );
      expect(reap.args.slice(0, 7)).toEqual([
        "exec",
        "--user",
        "node",
        "--workdir",
        "/workspace",
        NAME,
        "node",
      ]);
      expect(reap.args[7]).toBe("/workspace/.valmont/validation-reap.mjs");
      expect(Number.isInteger(Number(reap.args[8]))).toBe(true);
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
});
