import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_STORE_PATH,
  assertDistinctStorePaths,
  configuredLegacyChatStorePath,
  configuredSqliteChatStorePath,
  deriveSqliteChatStorePath,
  legacyBackupPath,
  resolveSqliteStorePaths,
} from "@/lib/sqlite-path";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-path-"));
  dirs.push(dir);
  return dir;
}

const originalLegacy = process.env.CHAT_STORE_PATH;
const originalSqlite = process.env.CHAT_SQLITE_PATH;

beforeEach(() => {
  delete process.env.CHAT_STORE_PATH;
  delete process.env.CHAT_SQLITE_PATH;
});

afterEach(() => {
  if (originalLegacy === undefined) delete process.env.CHAT_STORE_PATH;
  else process.env.CHAT_STORE_PATH = originalLegacy;
  if (originalSqlite === undefined) delete process.env.CHAT_SQLITE_PATH;
  else process.env.CHAT_SQLITE_PATH = originalSqlite;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("shared SQLite path resolver", () => {
  it("uses the default legacy path when nothing is configured", () => {
    expect(configuredLegacyChatStorePath()).toBe(DEFAULT_CHAT_STORE_PATH);
    expect(
      DEFAULT_CHAT_STORE_PATH.endsWith(path.join(".data", "chat-store.json")),
    ).toBe(true);
  });

  it("derives the SQLite file from a legacy .json path", () => {
    expect(deriveSqliteChatStorePath("/tmp/x/chat-store.json")).toBe(
      "/tmp/x/chat-store.sqlite",
    );
  });

  it("derives a distinct SQLite file for a non-.json CHAT_STORE_PATH", () => {
    process.env.CHAT_STORE_PATH = "/tmp/x/chat-store";
    expect(configuredSqliteChatStorePath()).toBe("/tmp/x/chat-store.sqlite");
  });

  it("never returns the legacy path itself, even when it ends in .sqlite", () => {
    const legacy = "/tmp/x/chat-store.sqlite";
    const derived = deriveSqliteChatStorePath(legacy);
    expect(derived).not.toBe(legacy);
    expect(derived).toBe("/tmp/x/chat-store.sqlite.sqlite");
  });

  it("honours CHAT_SQLITE_PATH over the derived value", () => {
    process.env.CHAT_STORE_PATH = "/tmp/x/chat-store.json";
    process.env.CHAT_SQLITE_PATH = "/tmp/other/db.sqlite";
    expect(configuredSqliteChatStorePath()).toBe("/tmp/other/db.sqlite");
  });

  it("rejects a configuration where both paths are the same file", () => {
    expect(() =>
      assertDistinctStorePaths("/tmp/x/data.json", "/tmp/x/data.json"),
    ).toThrow(/must be distinct/);
    expect(() =>
      assertDistinctStorePaths("/tmp/x/data.json", "/tmp/x/../x/data.json"),
    ).toThrow(/must be distinct/);
  });

  it("rejects two different names that point at one file through a symlink", () => {
    const dir = tempDir();
    const legacy = path.join(dir, "chat-store.json");
    const link = path.join(dir, "linked.sqlite");
    writeFileSync(legacy, "{}");
    symlinkSync(legacy, link);
    expect(() => assertDistinctStorePaths(legacy, link)).toThrow(
      /must be distinct/,
    );
  });

  it("refuses to use the legacy backup path as the SQLite destination", () => {
    const legacy = "/tmp/x/chat-store.json";
    expect(() =>
      assertDistinctStorePaths(legacy, legacyBackupPath(legacy)),
    ).toThrow(/pre-sqlite-backup/);
  });

  it("returns the same three paths on every call (repeated startup)", () => {
    const dir = tempDir();
    process.env.CHAT_STORE_PATH = path.join(dir, "chat-store.json");
    const first = resolveSqliteStorePaths();
    const second = resolveSqliteStorePaths();
    const third = resolveSqliteStorePaths();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.sqlitePath).toBe(path.join(dir, "chat-store.sqlite"));
    expect(first.backupPath).toBe(
      path.join(dir, "chat-store.json.pre-sqlite-backup"),
    );
  });

  it("validates as part of resolving, so a bad configuration fails fast", () => {
    const dir = tempDir();
    process.env.CHAT_STORE_PATH = path.join(dir, "same.json");
    process.env.CHAT_SQLITE_PATH = path.join(dir, "same.json");
    expect(() => resolveSqliteStorePaths()).toThrow(/must be distinct/);
  });
});
