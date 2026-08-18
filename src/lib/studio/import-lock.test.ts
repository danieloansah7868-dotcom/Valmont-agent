import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  acquireNewImportLock,
  ensureCoordinatorSchema,
  expireOwnerLockForTests,
  ImportInProgressError,
  ImportLostLeaseError,
  refuseIfOwnerImportActive,
  releaseImportLock,
  setImportLeaseMsForTests,
  tryClaimExpiredOwnerLock,
} from "./import-coordinator";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-import-lock-"));
  dirs.push(dir);
  const store = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(store);
  ensureCoordinatorSchema(store.connection);
  setImportLeaseMsForTests(null);
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  setImportLeaseMsForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("owner import lease", () => {
  it("does not convert a non-unique database error into 409", () => {
    const store = new SqliteChatStore(
      path.join(dirs[0]!, "other.sqlite"),
      path.join(dirs[0]!, "other.json"),
    );
    setSqliteChatStoreForTests(store);
    ensureCoordinatorSchema(store.connection);
    store.connection.close();
    try {
      acquireNewImportLock("owner-1", "11111111-1111-4111-8111-111111111111");
      throw new Error("expected a database error");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ImportInProgressError);
      expect((error as Error).name).not.toBe("ImportInProgressError");
    }
  });

  it("returns 409 from INSERT ON CONFLICT without treating other errors as busy", () => {
    const first = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(() =>
      acquireNewImportLock("owner-1", "22222222-2222-4222-8222-222222222222"),
    ).toThrow(ImportInProgressError);
    expect(() => refuseIfOwnerImportActive("owner-1")).toThrow(
      ImportInProgressError,
    );
    releaseImportLock(first);
  });

  it("lets exactly one worker claim an expired lease via compare-and-swap", () => {
    const first = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expireOwnerLockForTests("owner-1");
    const claimed = tryClaimExpiredOwnerLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    const lost = tryClaimExpiredOwnerLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(claimed).not.toBeNull();
    expect(lost).toBeNull();
    expect(claimed!.generation).toBe(first.generation + 1);
    expect(claimed!.lockToken).not.toBe(first.lockToken);
    expect(releaseImportLock(first)).toBe(false);
    expect(releaseImportLock(claimed!)).toBe(true);
  });

  it("refuses an obsolete token after a newer generation is installed", () => {
    const stale = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expireOwnerLockForTests("owner-1");
    const claimed = tryClaimExpiredOwnerLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(claimed).not.toBeNull();
    expect(releaseImportLock(stale)).toBe(false);
    expect(() => {
      throw new ImportLostLeaseError();
    }).toThrow(ImportLostLeaseError);
    expect(releaseImportLock(claimed!)).toBe(true);
  });
});
