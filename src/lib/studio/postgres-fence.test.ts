/**
 * PostgreSQL import-fence regression tests — real database, no sleeps.
 *
 * These prove the transaction-level fencing of mixed-store imports: the
 * SQLite lease alone cannot stop an in-flight PostgreSQL transaction from
 * committing after its lease was replaced, so every Studio import/restore
 * transaction ends with a conditional fence check inside PostgreSQL itself,
 * and recovery advances the fence inside the same transaction that restores
 * the pre-import snapshot. Both orderings of that race are pinned down here
 * with deterministic latches.
 *
 * They need a real throwaway PostgreSQL server:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 *
 * With the variable absent the file is skipped rather than quietly passing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;

const owner: SessionUser = { id: "pgf-9001", login: "abena", name: "Abena" };

describe.runIf(connectionString)("PostgreSQL import fence", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let SqliteChatStore: any;
  let setSqliteChatStoreForTests: any;
  let createDefaultBrief: any;
  let buildBackup: any;
  let importBackup: any;
  let parseBackup: any;
  let ImportFailedError: any;
  let ensureStudioUser: any;
  let getDatabase: any;
  let closeDatabase: any;
  let studioDraftsTable: any;
  let eq: any;
  let sqlTag: any;
  let coordinator: any;
  let fence: any;
  let chatStore: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const dirs: string[] = [];
  let sqlitePath = "";
  let legacyPath = "";

  function freshChatStore() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-pg-fence-"));
    dirs.push(dir);
    sqlitePath = path.join(dir, "chat-store.sqlite");
    legacyPath = path.join(dir, "chat-store.json");
    chatStore = new SqliteChatStore(sqlitePath, legacyPath);
    setSqliteChatStoreForTests(chatStore);
  }

  interface StudioStateRow {
    id: string;
    schemaVersion: number;
    templateVersion: number;
    themeVersion: number;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    brief: unknown;
  }

  async function readStudioState(ownerId: string) {
    const rows = (await getDatabase()
      .select()
      .from(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId))) as StudioStateRow[];
    return JSON.parse(
      JSON.stringify(
        rows
          .map((row) => ({
            id: row.id,
            schemaVersion: row.schemaVersion,
            templateVersion: row.templateVersion,
            themeVersion: row.themeVersion,
            revision: row.revision,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            brief: row.brief,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    );
  }

  async function emptyStudio(ownerId: string) {
    await getDatabase()
      .delete(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId));
  }

  async function captureBeforeState(ownerId: string) {
    return {
      chat: JSON.parse(
        JSON.stringify(chatStore.captureUserStateSync(owner.id)),
      ),
      studio: await readStudioState(ownerId),
    };
  }

  const PRE_DRAFT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  /** Pre-existing state in BOTH stores, so late writes are visible. */
  async function seedBothStores(ownerId: string) {
    const session = await chatStore.create({
      userId: owner.id,
      title: "Pre-import chat",
    });
    await chatStore.appendMessages(session.id, owner.id, [
      {
        id: "m-pre",
        role: "user",
        content: "This message must survive every recovery ordering.",
        createdAt: new Date().toISOString(),
      },
    ]);
    const now = new Date();
    await getDatabase()
      .insert(studioDraftsTable)
      .values({
        id: PRE_DRAFT_ID,
        ownerId,
        schemaVersion: 1,
        templateVersion: 1,
        themeVersion: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        brief: createDefaultBrief({
          businessName: "Pre-import Studio",
          adminEmail: "pre@adom.example",
        }),
      });
  }

  function importFile() {
    const now = new Date().toISOString();
    return {
      backupVersion: 2 as const,
      exportedAt: now,
      chat: {
        version: 1 as const,
        sessions: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "Imported chat",
            messages: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        memories: [],
        memoryEnabled: true,
      },
      studio: {
        version: 1 as const,
        schemaVersion: 1 as const,
        drafts: [
          {
            // Collides with the pre-existing draft on purpose: the import
            // remaps it, so an imported row can never be mistaken for the
            // restored pre-import row.
            id: PRE_DRAFT_ID,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            brief: createDefaultBrief({
              businessName: "Imported Studio",
              adminEmail: "import@adom.example",
            }),
          },
        ],
      },
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;

    const chat = await import("@/lib/chat-store");
    const defaults = await import("./site-brief/defaults");
    const backup = await import("./backup");
    const identity = await import("@/lib/user-identity");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");

    SqliteChatStore = chat.SqliteChatStore;
    setSqliteChatStoreForTests = chat.setSqliteChatStoreForTests;
    createDefaultBrief = defaults.createDefaultBrief;
    buildBackup = backup.buildBackup;
    importBackup = backup.importBackup;
    parseBackup = backup.parseBackup;
    ImportFailedError = backup.ImportFailedError;
    ensureStudioUser = identity.ensureStudioUser;
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    studioDraftsTable = schema.studioDrafts;
    eq = drizzle.eq;
    sqlTag = drizzle.sql;
    coordinator = await import("./import-coordinator");
    fence = await import("./import-fence");

    await ensureStudioUser(owner);
  });

  beforeEach(async () => {
    process.env.DATABASE_URL = connectionString;
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
  });

  afterEach(() => {
    setSqliteChatStoreForTests(null);
    process.env.DATABASE_URL = connectionString;
    coordinator?.setImportLeaseMsForTests?.(null);
    coordinator?.setRestoreFenceBarrierForTests?.(null);
    coordinator?.setHeartbeatRenewOverrideForTests?.(null);
    coordinator?.resetStartupImportRecoveryForTests?.();
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    const ownerId = await ensureStudioUser(owner);
    await getDatabase()
      .delete(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId));
    await closeDatabase();
    delete process.env.DATABASE_URL;
  });

  it("has the fence table from the Drizzle migration, holding identity only", async () => {
    const columns = (await getDatabase().execute(
      sqlTag`SELECT column_name FROM information_schema.columns
              WHERE table_name = 'studio_import_fences'
              ORDER BY column_name`,
    )) as Array<{ column_name: string }>;
    expect(columns.map((c) => c.column_name)).toEqual([
      "generation",
      "job_id",
      "lock_token",
      "owner_id",
      "updated_at",
    ]);
  });

  it("scenario A: the replacement fence wins, so the obsolete transaction fails its final check and rolls back", async () => {
    const ownerId = await ensureStudioUser(owner);
    await seedBothStores(ownerId);
    const before = await captureBeforeState(ownerId);

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalPaused!: () => void;
    const aPaused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });

    // Import A acquires its committed SQLite lease, enters its PostgreSQL
    // Studio transaction and pauses AFTER its writes but BEFORE the final
    // fence check/commit. It holds no fence row lock at this point.
    const first = importBackup(owner, parseBackup(importFile()), {
      // Not async: the chat-imported checkpoint must observe a synchronous
      // callback. Only the targeted checkpoint returns a promise.
      onCheckpoint: (cp: string) => {
        if (cp === "studio-imported") {
          signalPaused();
          return holdA;
        }
      },
    });
    await aPaused;
    const lockA = coordinator.getOwnerImportLock(ownerId);
    expect(lockA).not.toBeNull();

    // Test controls: stop A's heartbeat and expire its lease.
    coordinator.stopOwnerHeartbeatsForTests(ownerId);
    coordinator.expireOwnerLockForTests(ownerId);

    // Recovery atomically claims a newer generation, advances the
    // PostgreSQL fence and restores both stores — all while A's obsolete
    // transaction is still open.
    await coordinator.recoverPendingImports(ownerId);
    const fenceAfterRecovery = await fence.readStudioImportFence(ownerId);
    expect(fenceAfterRecovery.generation).toBeGreaterThan(
      Number(lockA.generation),
    );

    // Release A: its final fence check must fail and PostgreSQL must roll
    // back every Studio row it wrote.
    releaseA();
    await expect(first).rejects.toBeInstanceOf(ImportFailedError);

    // Both stores exactly equal the pre-import snapshots.
    expect(await captureBeforeState(ownerId)).toEqual(before);
    const jobs = coordinator.listImportJobs(ownerId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("restored");
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();
    // The fence row persists after release, still at the newer generation.
    const fenceFinal = await fence.readStudioImportFence(ownerId);
    expect(fenceFinal.generation).toBe(fenceAfterRecovery.generation);
  });

  it("scenario B: the obsolete transaction wins the row-lock race; recovery serializes after it and restores the snapshot", async () => {
    const ownerId = await ensureStudioUser(owner);
    await seedBothStores(ownerId);
    const before = await captureBeforeState(ownerId);

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalFenced!: () => void;
    const aHoldsFenceLock = new Promise<void>((resolve) => {
      signalFenced = resolve;
    });

    // Import A runs up to and THROUGH its fence touch — it now holds the
    // fence row's lock inside its open transaction — and pauses before
    // COMMIT. This is the PostgreSQL fence serialization point.
    const first = importBackup(owner, parseBackup(importFile()), {
      // Not async: the chat-imported checkpoint must observe a synchronous
      // callback. Only the targeted checkpoint returns a promise.
      onCheckpoint: (cp: string) => {
        if (cp === "studio-fenced") {
          signalFenced();
          return holdA;
        }
      },
    });
    await aHoldsFenceLock;
    const lockA = coordinator.getOwnerImportLock(ownerId);
    const staleLease = {
      ownerId,
      jobId: lockA.job_id,
      lockToken: lockA.lock_token,
      generation: Number(lockA.generation),
    };

    // A's SQLite lease expires and recovery claims the newer generation.
    coordinator.stopOwnerHeartbeatsForTests(ownerId);
    coordinator.expireOwnerLockForTests(ownerId);

    let signalRecoveryAtFence!: () => void;
    const recoveryAtFence = new Promise<void>((resolve) => {
      signalRecoveryAtFence = resolve;
    });
    coordinator.setRestoreFenceBarrierForTests(() => {
      signalRecoveryAtFence();
    });
    const recovery = coordinator.recoverPendingImports(ownerId);
    // Deterministic latch: recovery is inside its restore transaction, its
    // next statement queues on the fence row lock that A is holding.
    await recoveryAtFence;
    coordinator.setRestoreFenceBarrierForTests(null);

    // A finishes first — its commit wins the row-lock race. Attach the
    // failure expectation immediately so the rejection is handled the moment
    // it happens: A's lease is gone, so the studio-committed checkpoint (and
    // everything after it) is refused.
    releaseA();
    const aRefused = expect(first).rejects.toBeInstanceOf(ImportFailedError);
    // Recovery then serializes after A, advances the fence and restores the
    // exact pre-import Studio snapshot over A's late-committed writes.
    await recovery;
    await aRefused;

    // Final Chat and Studio exactly equal the pre-import snapshots.
    expect(await captureBeforeState(ownerId)).toEqual(before);
    const jobs = coordinator.listImportJobs(ownerId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("restored");
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();

    // A can perform no later Studio write, restore, checkpoint,
    // sanitization or release with its obsolete lease.
    const studioAfter = await readStudioState(ownerId);
    expect(() => coordinator.renewImportLease(staleLease)).toThrow(
      coordinator.ImportLostLeaseError,
    );
    expect(() =>
      coordinator.markStudioCommitted(staleLease.jobId, staleLease),
    ).toThrow(coordinator.ImportLostLeaseError);
    expect(() =>
      coordinator.sanitizeAndReleaseJob(
        staleLease.jobId,
        "completed",
        undefined,
        staleLease,
      ),
    ).toThrow(coordinator.ImportLostLeaseError);
    await expect(
      coordinator.restoreStudioState({ drafts: [] }, staleLease),
    ).rejects.toBeInstanceOf(coordinator.ImportLostLeaseError);
    expect(coordinator.releaseImportLock(staleLease)).toBe(false);
    expect(await readStudioState(ownerId)).toEqual(studioAfter);
    // The replacement fence stayed in place throughout.
    const fenceFinal = await fence.readStudioImportFence(ownerId);
    expect(fenceFinal.generation).toBeGreaterThan(staleLease.generation);
  });

  it("refuses PostgreSQL fence writes and Studio restores from an obsolete token", async () => {
    const ownerId = await ensureStudioUser(owner);
    await seedBothStores(ownerId);
    const parsed = parseBackup(importFile());

    const started = await coordinator.beginImportJob(owner, ownerId, parsed);
    const stale = started.lease;
    coordinator.stopOwnerHeartbeatsForTests(ownerId);
    coordinator.expireOwnerLockForTests(ownerId);
    const claimed = coordinator.tryClaimExpiredOwnerLock(
      ownerId,
      started.jobId,
    );
    expect(claimed).not.toBeNull();
    // The replacement worker advances the durable PostgreSQL fence.
    await fence.advanceStudioImportFence(claimed);

    const studioBefore = await readStudioState(ownerId);
    // The obsolete token cannot advance or touch the fence at the
    // PostgreSQL level, even bypassing every SQLite check.
    await expect(fence.advanceStudioImportFence(stale)).rejects.toBeInstanceOf(
      coordinator.ImportLostLeaseError,
    );
    await expect(
      fence.touchStudioImportFenceInTx(getDatabase(), stale),
    ).rejects.toBeInstanceOf(coordinator.ImportLostLeaseError);
    await expect(
      fence.verifyStudioImportFenceInTx(getDatabase(), stale),
    ).rejects.toBeInstanceOf(coordinator.ImportLostLeaseError);
    // And the lease-requiring restoration helper refuses to delete or
    // insert any Studio row for it.
    await expect(
      coordinator.restoreStudioState({ drafts: [] }, stale),
    ).rejects.toBeInstanceOf(coordinator.ImportLostLeaseError);
    expect(await readStudioState(ownerId)).toEqual(studioBefore);

    // The rightful holder cleans up.
    await coordinator.restoreJob(
      coordinator.getImportJob(started.jobId),
      claimed,
    );
    expect(coordinator.getImportJob(started.jobId).status).toBe("restored");
  });

  it("keeps the fence row after successful release and keeps generations monotonic across imports", async () => {
    const ownerId = await ensureStudioUser(owner);

    const summary1 = await importBackup(owner, parseBackup(importFile()));
    expect(summary1.studioDrafts).toBe(1);
    const fence1 = await fence.readStudioImportFence(ownerId);
    expect(fence1).not.toBeNull();
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();

    const summary2 = await importBackup(owner, parseBackup(importFile()));
    expect(summary2.studioDrafts).toBe(1);
    const fence2 = await fence.readStudioImportFence(ownerId);
    expect(fence2.generation).toBeGreaterThan(fence1.generation);
    expect(fence2.lockToken).not.toBe(fence1.lockToken);
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();

    // The fence is never part of an exported backup.
    const exported = JSON.stringify(await buildBackup(owner));
    expect(exported).not.toContain("lock_token");
    expect(exported).not.toContain(fence2.lockToken);
    expect(exported).not.toContain("studio_import_fences");
  });

  it("stays monotonic even when the SQLite file is replaced, thanks to the durable fence floor", async () => {
    const ownerId = await ensureStudioUser(owner);
    await importBackup(owner, parseBackup(importFile()));
    const fenceBefore = await fence.readStudioImportFence(ownerId);

    // A brand-new SQLite file: locks, jobs and the generation counter are
    // all gone. Without the fence floor this would reissue generation 1.
    freshChatStore();
    await importBackup(owner, parseBackup(importFile()));
    const fenceAfter = await fence.readStudioImportFence(ownerId);
    expect(fenceAfter.generation).toBeGreaterThan(fenceBefore.generation);
  });

  it("recovers a crashed import after restart and advances the fence", async () => {
    const ownerId = await ensureStudioUser(owner);
    await seedBothStores(ownerId);
    const before = await captureBeforeState(ownerId);
    const parsed = parseBackup(importFile());

    // Crash mid-import: chat committed, studio not; no rollback runs.
    const started = await coordinator.beginImportJob(owner, ownerId, parsed);
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions,
        memories: parsed.chat.memories,
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(started.jobId, started.lease);
    coordinator.stopOwnerHeartbeatsForTests(ownerId);
    const fenceCrashed = await fence.readStudioImportFence(ownerId);
    expect(fenceCrashed.lockToken).toBe(started.lease.lockToken);

    // "Restart": new connection to the same SQLite file, fresh PostgreSQL
    // client, lease expired the way a missed heartbeat would leave it.
    coordinator.expireOwnerLockForTests(ownerId);
    setSqliteChatStoreForTests(null);
    chatStore = new SqliteChatStore(sqlitePath, legacyPath);
    setSqliteChatStoreForTests(chatStore);
    await closeDatabase();
    process.env.DATABASE_URL = connectionString;

    await coordinator.recoverPendingImports();

    expect(await captureBeforeState(ownerId)).toEqual(before);
    expect(coordinator.getImportJob(started.jobId).status).toBe("restored");
    const fenceRecovered = await fence.readStudioImportFence(ownerId);
    expect(fenceRecovered.generation).toBeGreaterThan(fenceCrashed.generation);
    expect(fenceRecovered.lockToken).not.toBe(started.lease.lockToken);
  });
});
