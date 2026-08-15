import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandRequiresShell,
  resolveCommandExecutable,
  RestrictedLocalWorkspaceProvider,
  type WorkspaceHandle,
} from "@/lib/workspace";

let temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary.map((item) => rm(item, { recursive: true, force: true })),
  ),
);
beforeEach(() => {
  temporary = [];
});

async function setup(options: { timeoutMs?: number } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "valmont-workspaces-"));
  temporary.push(base);
  const root = path.join(base, "task-safe");
  await mkdir(root);
  await writeFile(path.join(root, "safe.txt"), "safe");
  const handle: WorkspaceHandle = { id: "task-safe", root };
  const provider = new RestrictedLocalWorkspaceProvider({
    baseDirectory: base,
    timeoutMs: options.timeoutMs ?? 2_000,
    outputLimitBytes: 1_000,
    allowedCommands: {
      "node pass": ["node", "-e", "console.log('passed')"],
      "node slow": ["node", "-e", "setTimeout(() => {}, 1000)"],
      "node noisy": ["node", "-e", "console.log('x'.repeat(5000))"],
    },
  });
  return { base, root, handle, provider };
}

describe("restricted local workspace", () => {
  it("uses a shell only for Windows package-manager shims", () => {
    expect(resolveCommandExecutable("npm", "win32")).toBe("npm.cmd");
    expect(resolveCommandExecutable("pnpm", "win32")).toBe("pnpm.cmd");
    expect(commandRequiresShell("npm", "win32")).toBe(true);
    expect(commandRequiresShell("pnpm", "win32")).toBe(true);
    expect(resolveCommandExecutable("git", "win32")).toBe("git");
    expect(commandRequiresShell("git", "win32")).toBe(false);
    expect(resolveCommandExecutable("npm", "linux")).toBe("npm");
    expect(commandRequiresShell("npm", "linux")).toBe(false);
  });

  it("blocks path traversal and sensitive writes", async () => {
    const { provider, handle } = await setup();
    await expect(provider.readFile(handle, "../safe.txt")).rejects.toThrow(
      /escapes/,
    );
    await expect(
      provider.writeFile(handle, "/tmp/escape.txt", "no"),
    ).rejects.toThrow(/Invalid/);
    await expect(
      provider.writeFile(handle, ".env", "SECRET=no"),
    ).rejects.toThrow(/sensitive/i);
  });

  it("blocks symlink escapes", async () => {
    const { provider, handle, root, base } = await setup();
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "link"));
    await expect(
      provider.readFile(handle, "link/secret.txt"),
    ).rejects.toThrow();
    await expect(
      provider.writeFile(handle, "link/new.txt", "escape"),
    ).rejects.toThrow(/Symlink|escapes/);
  });

  it("runs only exact allowlisted commands and limits output", async () => {
    const { provider, handle } = await setup();
    await expect(provider.runValidation(handle, "rm -rf .")).rejects.toThrow(
      /allowlisted/,
    );
    const passed = await provider.runValidation(handle, "node pass");
    expect(passed.status).toBe("passed");
    expect(passed.output).toContain("passed");
    const noisy = await provider.runValidation(handle, "node noisy");
    expect(noisy.truncated).toBe(true);
    expect(noisy.output).toContain("output truncated");
  });

  it("kills validation commands after the configured timeout", async () => {
    const { provider, handle } = await setup({ timeoutMs: 60 });
    const result = await provider.runValidation(handle, "node slow");
    expect(result.status).toBe("timed_out");
    expect(result.durationMs).toBeLessThan(700);
  });
});
