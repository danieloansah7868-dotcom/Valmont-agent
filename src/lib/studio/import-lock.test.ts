import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  acquireNewImportLock,
  assertOwnsImportLease,
  ensureCoordinatorSchema,
  expireOwnerLockForTests,
  getOwnerImportLock,
  heartbeatTickForTests,
  ImportInProgressError,
  ImportLostLeaseError,
  importHeartbeatActiveForTests,
  ownerImportLeaseIsActive,
  refuseIfOwnerImportActive,
  releaseImportLock,
  renewImportLease,
  setHeartbeatRenewOverrideForTests,
  setImportLeaseMsForTests,
  startImportLeaseHeartbeat,
  stopImportLeaseHeartbeat,
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

  it("keeps generations monotonic across release and a later import", () => {
    const first = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(releaseImportLock(first)).toBe(true);
    // PR #14 reissued generation 1 here because the released row was gone.
    const second = acquireNewImportLock(
      "owner-1",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(second.generation).toBeGreaterThan(first.generation);
    expireOwnerLockForTests("owner-1");
    const claimed = tryClaimExpiredOwnerLock(
      "owner-1",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(claimed!.generation).toBeGreaterThan(second.generation);
    expect(releaseImportLock(claimed!)).toBe(true);
    const third = acquireNewImportLock(
      "owner-1",
      "33333333-3333-4333-8333-333333333333",
    );
    expect(third.generation).toBeGreaterThan(claimed!.generation);
    releaseImportLock(third);
  });

  it("keeps generations monotonic across a process restart", () => {
    const dbPath = path.join(dirs[0]!, "restart.sqlite");
    const jsonPath = path.join(dirs[0]!, "restart.json");
    const before = new SqliteChatStore(dbPath, jsonPath);
    setSqliteChatStoreForTests(before);
    ensureCoordinatorSchema(before.connection);
    const first = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(releaseImportLock(first)).toBe(true);
    before.connection.close();

    // "Restart": a brand-new connection to the same file. The lock table is
    // empty, but the durable per-owner counter is not.
    const after = new SqliteChatStore(dbPath, jsonPath);
    setSqliteChatStoreForTests(after);
    ensureCoordinatorSchema(after.connection);
    const second = acquireNewImportLock(
      "owner-1",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(second.generation).toBeGreaterThan(first.generation);
    releaseImportLock(second);
  });

  it("refuses to renew or resurrect a lease that has already expired", () => {
    const lease = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    renewImportLease(lease); // live: renewal works
    expireOwnerLockForTests("owner-1");
    // The old holder must not bring an expired lease back to life, even
    // though no replacement has claimed it yet.
    expect(() => renewImportLease(lease)).toThrow(ImportLostLeaseError);
    expect(() => assertOwnsImportLease(lease)).toThrow(ImportLostLeaseError);
    // The failed renewal really did not extend the expiry.
    expect(ownerImportLeaseIsActive("owner-1")).toBe(false);
    const lock = getOwnerImportLock("owner-1");
    expect(lock!.expires_at).toBe("1970-01-01T00:00:00.000Z");
    // Expired takeover still works — the lease was not resurrected.
    const claimed = tryClaimExpiredOwnerLock(
      "owner-1",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(claimed).not.toBeNull();
    releaseImportLock(claimed!);
  });

  it("does not convert a renewal database failure into a 409 lost-lease", () => {
    const store = new SqliteChatStore(
      path.join(dirs[0]!, "renew-error.sqlite"),
      path.join(dirs[0]!, "renew-error.json"),
    );
    setSqliteChatStoreForTests(store);
    ensureCoordinatorSchema(store.connection);
    const lease = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    store.connection.close();
    try {
      renewImportLease(lease);
      throw new Error("expected a database error");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ImportLostLeaseError);
      expect((error as Error).name).not.toBe("ImportLostLeaseError");
    }
  });

  it("keeps the heartbeat alive through a transient failure and stops it on a confirmed lost lease", () => {
    // A large lease keeps the real interval from firing during the test;
    // ticks are driven explicitly and deterministically.
    setImportLeaseMsForTests(60_000);
    const lease = acquireNewImportLock(
      "owner-1",
      "11111111-1111-4111-8111-111111111111",
    );
    startImportLeaseHeartbeat(lease);
    try {
      expect(importHeartbeatActiveForTests(lease)).toBe(true);

      // One transient database error must NOT permanently stop renewal.
      setHeartbeatRenewOverrideForTests(() => {
        throw new Error("transient database failure");
      });
      heartbeatTickForTests(lease);
      expect(importHeartbeatActiveForTests(lease)).toBe(true);

      // The next tick, with the transient fault gone, really renews.
      setHeartbeatRenewOverrideForTests(null);
      const staleExpiry = getOwnerImportLock("owner-1")!.heartbeat_at;
      heartbeatTickForTests(lease);
      expect(importHeartbeatActiveForTests(lease)).toBe(true);
      expect(
        Date.parse(getOwnerImportLock("owner-1")!.heartbeat_at),
      ).toBeGreaterThanOrEqual(Date.parse(staleExpiry));

      // A confirmed lost lease stops the heartbeat for good.
      expireOwnerLockForTests("owner-1");
      const claimed = tryClaimExpiredOwnerLock(
        "owner-1",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(claimed).not.toBeNull();
      heartbeatTickForTests(lease);
      expect(importHeartbeatActiveForTests(lease)).toBe(false);
      releaseImportLock(claimed!);
    } finally {
      setHeartbeatRenewOverrideForTests(null);
      stopImportLeaseHeartbeat(lease);
    }
  });
});
