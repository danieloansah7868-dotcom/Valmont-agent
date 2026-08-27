/**
 * Real coordinated-import tests against PostgreSQL.
 *
 * When `DATABASE_URL` is set, Chat lives in SQLite and Studio lives in
 * PostgreSQL. There is no distributed transaction, so imports are made
 * all-or-nothing by the durable cross-store coordinator: a job records the
 * staged payload and a snapshot of both stores before any write, advances
 * through durable checkpoints, and rolls both stores back to their exact
 * previous state when anything fails — immediately, or after a restart.
 *
 * These tests need a real throwaway PostgreSQL server:
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
  vi,
} from "vitest";
import type { SessionUser } from "@/lib/auth";
import type { ChatMemory } from "@/lib/chat-store";
import type { ChatSession } from "@/lib/types";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;

const owner: SessionUser = { id: "pgb-9001", login: "ama", name: "Ama" };

// Only the session cookie is faked, exactly as a signed-in browser sends it.
let currentUser: SessionUser | null = owner;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== "valmont_session" || !currentUser) return undefined;
      return {
        name,
        value: JSON.stringify({
          accessToken: "test-token",
          id: currentUser.id,
          login: currentUser.login,
          name: currentUser.name,
          expiresAt: Date.now() + 3_600_000,
        }),
      };
    },
  }),
}));

vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, decryptSessionValue: (value: string) => value };
});

describe.runIf(connectionString)("PostgreSQL coordinated backup import", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let SqliteChatStore: any;
  let setSqliteChatStoreForTests: any;
  let PostgresStudioDraftStore: any;
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
  let coordinator: any;
  let chatStore: any;
  let drafts: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const dirs: string[] = [];
  let sqlitePath = "";
  let legacyPath = "";

  function freshChatStore() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-pg-backup-"));
    dirs.push(dir);
    sqlitePath = path.join(dir, "chat-store.sqlite");
    legacyPath = path.join(dir, "chat-store.json");
    chatStore = new SqliteChatStore(sqlitePath, legacyPath);
    setSqliteChatStoreForTests(chatStore);
  }

  async function seed() {
    const session = await chatStore.create({
      userId: owner.id,
      title: "Planning",
    });
    await chatStore.appendMessages(session.id, owner.id, [
      {
        id: "m1",
        role: "user",
        content: "Please help me plan my shop website.",
        createdAt: new Date().toISOString(),
      },
    ]);
    await chatStore.addMemory({
      id: "mem1",
      userId: owner.id,
      scope: "personal",
      category: "preference",
      content: "Prefers WhatsApp contact.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await drafts.create(
      owner,
      createDefaultBrief({
        businessName: "Adom Fashion House",
        phone: "+233201234567",
        adminEmail: "owner@adom.example",
      }),
    );
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
        rows.map((row) => ({
          id: row.id,
          schemaVersion: row.schemaVersion,
          templateVersion: row.templateVersion,
          themeVersion: row.themeVersion,
          revision: row.revision,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          brief: row.brief,
        })),
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

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;

    const chat = await import("@/lib/chat-store");
    const draftStore = await import("./draft-store");
    const defaults = await import("./site-brief/defaults");
    const backup = await import("./backup");
    const identity = await import("@/lib/user-identity");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");

    SqliteChatStore = chat.SqliteChatStore;
    setSqliteChatStoreForTests = chat.setSqliteChatStoreForTests;
    PostgresStudioDraftStore = draftStore.PostgresStudioDraftStore;
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
    coordinator = await import("./import-coordinator");

    drafts = new PostgresStudioDraftStore();
    await ensureStudioUser(owner);
  });

  beforeEach(async () => {
    currentUser = owner;
    process.env.DATABASE_URL = connectionString;
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
  });

  afterEach(() => {
    setSqliteChatStoreForTests(null);
    process.env.DATABASE_URL = connectionString;
    coordinator?.setImportLeaseMsForTests?.(null);
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

  it("really imports both halves and reports coordinated atomicity", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));

    // Empty both halves, then restore.
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);

    const summary = await importBackup(owner, parseBackup(file));

    expect(summary.atomicity).toBe("coordinated");
    expect(summary.chatSessions).toBe(1);
    expect(summary.memories).toBe(1);
    expect(summary.studioDrafts).toBe(1);
    // The drafts are really in PostgreSQL, not merely counted.
    expect(await readStudioState(ownerId)).toHaveLength(1);
    const restored = await drafts.list(owner);
    expect(restored).toHaveLength(1);
    expect(restored[0].brief.businessName).toBe("Adom Fashion House");
    // The job is durably recorded as completed, without the payload/snapshot.
    const jobs = coordinator.listImportJobs(ownerId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].payload_json).toBe("");
    expect(jobs[0].pre_state_json).toBe("");
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();
  });

  it.each([
    "job-created",
    "chat-imported",
    "chat-committed",
    "studio-imported",
    "studio-fenced",
    "studio-committed",
    "completed",
  ] as const)(
    "a failure at checkpoint %s returns both stores to their exact previous state",
    async (checkpoint) => {
      // Pre-existing data in BOTH stores. Importing the same file again would
      // add separate copies (colliding ids are remapped), so any surviving
      // write after the injected failure is visible as a difference.
      await seed();
      const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
      const ownerId = await ensureStudioUser(owner);
      const before = await captureBeforeState(ownerId);

      await expect(
        importBackup(owner, parseBackup(file), {
          onCheckpoint: (cp: string) => {
            if (cp === checkpoint) {
              throw new Error(`injected failure at ${checkpoint}`);
            }
          },
        }),
        `importBackup should fail at ${checkpoint}`,
      ).rejects.toBeInstanceOf(ImportFailedError);

      // The failure is reported as a clean failure, never as a partial
      // success, and BOTH stores are exactly as they were before the import.
      const after = await captureBeforeState(ownerId);
      expect(after, `stores after failure at ${checkpoint}`).toEqual(before);
      // The job is durably recorded as rolled back.
      const jobs = coordinator.listImportJobs(ownerId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("restored");
      expect(jobs[0].payload_json).toBe("");
      expect(jobs[0].pre_state_json).toBe("");
      expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();
    },
  );

  it("recovers an interrupted import after a simulated restart", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
    const before = await captureBeforeState(ownerId);

    // Simulate a process dying mid-import: drive the coordinator's real steps
    // up to the point where the chat half committed, then STOP without any
    // rollback, exactly as an abrupt crash would leave the database.
    const parsed = parseBackup(file);
    const started = await coordinator.beginImportJob(owner, ownerId, parsed);
    const jobId = started.jobId;
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions as ChatSession[],
        memories: parsed.chat.memories as ChatMemory[],
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(jobId, started.lease);
    coordinator.stopImportLeaseHeartbeat(started.lease);
    // The chat half really did land before the "crash".
    expect(await chatStore.list(owner.id)).toHaveLength(1);

    // "Restart": a brand-new connection to the same SQLite file and a fresh
    // PostgreSQL client. The coordinator record survives on disk. The lease
    // is expired the way a missed heartbeat after a crash would expire it.
    coordinator.expireOwnerLockForTests(ownerId);
    setSqliteChatStoreForTests(null);
    chatStore = new SqliteChatStore(sqlitePath, legacyPath);
    setSqliteChatStoreForTests(chatStore);
    await closeDatabase();
    process.env.DATABASE_URL = connectionString;

    await coordinator.recoverPendingImports();

    // Both stores are back to their exact pre-import state.
    const after = await captureBeforeState(ownerId);
    expect(after).toEqual(before);
    expect(coordinator.getImportJob(jobId).status).toBe("restored");
  });

  it("rolls an interrupted import back automatically before the next import", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);

    // Crash the same way: chat half committed, job left at "chat-committed".
    const parsed = parseBackup(file);
    const crashed = await coordinator.beginImportJob(owner, ownerId, parsed);
    const crashedJobId = crashed.jobId;
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions as ChatSession[],
        memories: parsed.chat.memories as ChatMemory[],
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(crashedJobId, crashed.lease);
    coordinator.stopImportLeaseHeartbeat(crashed.lease);
    coordinator.expireOwnerLockForTests(ownerId);
    expect(await chatStore.list(owner.id)).toHaveLength(1);

    // The next import attempt self-heals: it claims the expired lease, rolls
    // the crashed job back, then runs the new import.
    const summary = await importBackup(owner, parseBackup(file));

    expect(summary.chatSessions).toBe(1);
    expect(summary.memories).toBe(1);
    expect(summary.studioDrafts).toBe(1);
    // The crashed job was rolled back (not duplicated by the new import).
    expect(coordinator.getImportJob(crashedJobId).status).toBe("restored");
    expect(await chatStore.list(owner.id)).toHaveLength(1);
    expect(await readStudioState(ownerId)).toHaveLength(1);
  });

  it("keeps the recovery record when the rollback itself fails, then restores later", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
    const before = await captureBeforeState(ownerId);

    // Chat half commits, then PostgreSQL becomes unreachable so the rollback's
    // studio half cannot run — the catastrophic case behind PartialImportError.
    const parsed = parseBackup(file);
    const started = await coordinator.beginImportJob(owner, ownerId, parsed);
    const jobId = started.jobId;
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions as ChatSession[],
        memories: parsed.chat.memories as ChatMemory[],
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(jobId, started.lease);
    expect(await chatStore.list(owner.id)).toHaveLength(1);

    await closeDatabase();
    process.env.DATABASE_URL = "postgres://postgres:hunter2@127.0.0.1:1/none";

    await expect(
      coordinator.restoreJob(coordinator.getImportJob(jobId), started.lease),
    ).rejects.toThrow();
    // The job stays "restoring" — recovery retries, it is not lost.
    expect(coordinator.getImportJob(jobId).status).toBe("restoring");

    // PostgreSQL comes back. Expire the original lease (the process that
    // failed the rollback is gone) so recovery can claim it.
    coordinator.stopImportLeaseHeartbeat(started.lease);
    coordinator.expireOwnerLockForTests(ownerId);
    await closeDatabase();
    process.env.DATABASE_URL = connectionString;
    await coordinator.recoverPendingImports();

    const after = await captureBeforeState(ownerId);
    expect(after).toEqual(before);
    expect(coordinator.getImportJob(jobId).status).toBe("restored");
    expect(coordinator.getImportJob(jobId).payload_json).toBe("");
    expect(coordinator.getImportJob(jobId).pre_state_json).toBe("");
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();
  });

  const SENTINEL = "SENTINEL-JOURNAL-ADOM-FASHION-9f3c2e";

  it("strips sentinel payload text from the journal after a successful import", async () => {
    const session = await chatStore.create({
      userId: owner.id,
      title: SENTINEL,
    });
    await chatStore.appendMessages(session.id, owner.id, [
      {
        id: "m-sentinel",
        role: "user",
        content: SENTINEL,
        createdAt: new Date().toISOString(),
      },
    ]);
    await drafts.create(
      owner,
      createDefaultBrief({
        businessName: SENTINEL,
        adminEmail: "owner@adom.example",
      }),
    );
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    expect(JSON.stringify(file)).toContain(SENTINEL);

    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
    await importBackup(owner, parseBackup(file));

    expect(coordinator.journalSensitiveBlob()).not.toContain(SENTINEL);
    const exported = JSON.stringify(await buildBackup(owner));
    expect(exported).toContain(SENTINEL);
    expect(exported).not.toContain("payload_json");
  });

  it("strips sentinel snapshot text from the journal after a completed recovery", async () => {
    await drafts.create(
      owner,
      createDefaultBrief({
        businessName: SENTINEL,
        adminEmail: "owner@adom.example",
      }),
    );
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    const ownerId = await ensureStudioUser(owner);

    await expect(
      importBackup(owner, parseBackup(file), {
        onCheckpoint: (cp: string) => {
          if (cp === "chat-committed") throw new Error("injected");
        },
      }),
    ).rejects.toBeInstanceOf(ImportFailedError);

    expect(coordinator.journalSensitiveBlob()).not.toContain(SENTINEL);
    const jobs = coordinator.listImportJobs(ownerId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("restored");
  });

  it("lets exactly one of two simultaneous same-owner imports proceed", async () => {
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);

    const now = new Date().toISOString();
    const fileA = {
      backupVersion: 2 as const,
      exportedAt: now,
      chat: {
        version: 1 as const,
        sessions: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "Import A chat",
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
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            brief: createDefaultBrief({
              businessName: "Import A Studio",
              adminEmail: "a@adom.example",
            }),
          },
        ],
      },
    };
    const fileB = {
      backupVersion: 2 as const,
      exportedAt: now,
      chat: {
        version: 1 as const,
        sessions: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            title: "Import B chat",
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
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            brief: createDefaultBrief({
              businessName: "Import B Studio",
              adminEmail: "b@adom.example",
            }),
          },
        ],
      },
    };

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalReady!: () => void;
    const firstLockVisible = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const first = importBackup(owner, parseBackup(fileA), {
      onLockAcquired: async () => {
        signalReady();
        await holdFirst;
      },
    });

    await firstLockVisible;
    expect(coordinator.getOwnerImportLock(ownerId)).not.toBeNull();
    expect(coordinator.ownerImportLeaseIsActive(ownerId)).toBe(true);
    const beforeSecond = await captureBeforeState(ownerId);

    const second = importBackup(owner, parseBackup(fileB));
    await expect(second).rejects.toMatchObject({
      name: "ImportInProgressError",
      status: 409,
    });
    expect(await captureBeforeState(ownerId)).toEqual(beforeSecond);

    releaseFirst();
    const summary = await first;
    expect(summary.chatSessions).toBe(1);
    expect(summary.studioDrafts).toBe(1);

    const sessions = await chatStore.list(owner.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("Import A chat");
    const studio = await readStudioState(ownerId);
    expect(studio).toHaveLength(1);
    expect(studio[0].brief.businessName).toBe("Import A Studio");
    expect(coordinator.getOwnerImportLock(ownerId)).toBeNull();
  });

  it("does not restore or release a live lease from a recovery scan or draft-store init", async () => {
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
    const now = new Date().toISOString();
    const file = {
      backupVersion: 2 as const,
      exportedAt: now,
      chat: {
        version: 1 as const,
        sessions: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "Live scan chat",
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
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            brief: createDefaultBrief({
              businessName: "Live Scan Studio",
              adminEmail: "live@adom.example",
            }),
          },
        ],
      },
    };

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalReady!: () => void;
    const firstLockVisible = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const first = importBackup(owner, parseBackup(file), {
      onLockAcquired: async () => {
        signalReady();
        await holdFirst;
      },
    });
    await firstLockVisible;
    const lockBefore = coordinator.getOwnerImportLock(ownerId);
    expect(lockBefore).not.toBeNull();
    const jobId = lockBefore.job_id;
    expect(coordinator.getImportJob(jobId).status).toBe("prepared");

    await coordinator.recoverPendingImports();
    await coordinator.recoverPendingImports(ownerId);
    coordinator.resetStartupImportRecoveryForTests();
    coordinator.scheduleStartupImportRecovery();
    const { getStudioDraftStore } = await import("./draft-store");
    await getStudioDraftStore().list(owner);

    const lockAfter = coordinator.getOwnerImportLock(ownerId);
    expect(lockAfter.lock_token).toBe(lockBefore.lock_token);
    expect(lockAfter.generation).toBe(lockBefore.generation);
    expect(coordinator.getImportJob(jobId).status).toBe("prepared");
    expect(coordinator.getImportJob(jobId).payload_json).not.toBe("");
    expect(await chatStore.list(owner.id)).toHaveLength(0);
    expect(await readStudioState(ownerId)).toHaveLength(0);

    releaseFirst();
    const summary = await first;
    expect(summary.studioDrafts).toBe(1);
    expect((await chatStore.list(owner.id))[0].title).toBe("Live scan chat");
  });

  it("lets exactly one recovery worker claim an expired lease", async () => {
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
    const file = JSON.parse(
      JSON.stringify({
        backupVersion: 2,
        exportedAt: new Date().toISOString(),
        chat: { version: 1, sessions: [], memories: [], memoryEnabled: true },
        studio: { version: 1, schemaVersion: 1, drafts: [] },
      }),
    );
    const started = await coordinator.beginImportJob(
      owner,
      ownerId,
      parseBackup(file),
    );
    coordinator.stopImportLeaseHeartbeat(started.lease);
    coordinator.expireOwnerLockForTests(ownerId);

    const first = coordinator.tryClaimExpiredOwnerLock(ownerId, started.jobId);
    const second = coordinator.tryClaimExpiredOwnerLock(ownerId, started.jobId);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first.generation).toBe(started.lease.generation + 1);
    expect(first.lockToken).not.toBe(started.lease.lockToken);
    expect(coordinator.getOwnerImportLock(ownerId).lock_token).toBe(
      first.lockToken,
    );
    coordinator.releaseImportLock(first);
  });

  it("refuses writes, sanitize and release from an obsolete lock token", async () => {
    const ownerId = await ensureStudioUser(owner);
    await emptyStudio(ownerId);
    const file = JSON.parse(
      JSON.stringify({
        backupVersion: 2,
        exportedAt: new Date().toISOString(),
        chat: { version: 1, sessions: [], memories: [], memoryEnabled: true },
        studio: { version: 1, schemaVersion: 1, drafts: [] },
      }),
    );
    const started = await coordinator.beginImportJob(
      owner,
      ownerId,
      parseBackup(file),
    );
    const stale = started.lease;
    coordinator.stopImportLeaseHeartbeat(stale);
    coordinator.expireOwnerLockForTests(ownerId);
    const claimed = coordinator.tryClaimExpiredOwnerLock(
      ownerId,
      started.jobId,
    );
    expect(claimed).not.toBeNull();

    expect(() => coordinator.renewImportLease(stale)).toThrow(
      /no longer holding the owner lock/,
    );
    expect(() => coordinator.assertOwnsImportLease(stale)).toThrow(
      coordinator.ImportLostLeaseError,
    );
    expect(() => coordinator.markChatCommitted(started.jobId, stale)).toThrow(
      coordinator.ImportLostLeaseError,
    );
    expect(() =>
      coordinator.sanitizeAndReleaseJob(
        started.jobId,
        "completed",
        undefined,
        stale,
      ),
    ).toThrow(coordinator.ImportLostLeaseError);
    expect(coordinator.releaseImportLock(stale)).toBe(false);
    expect(coordinator.getOwnerImportLock(ownerId).lock_token).toBe(
      claimed.lockToken,
    );

    await expect(
      coordinator.restoreJob(coordinator.getImportJob(started.jobId), stale),
    ).rejects.toBeInstanceOf(coordinator.ImportLostLeaseError);
    expect(coordinator.getOwnerImportLock(ownerId).lock_token).toBe(
      claimed.lockToken,
    );
    coordinator.releaseImportLock(claimed);
  });

  it("lets two different owners import at the same time without mixing data", async () => {
    const other: SessionUser = {
      id: "pgb-9002",
      login: "kofi",
      name: "Kofi",
    };
    await ensureStudioUser(other);
    const ownerIdA = await ensureStudioUser(owner);
    const ownerIdB = await ensureStudioUser(other);
    await emptyStudio(ownerIdA);
    await emptyStudio(ownerIdB);

    const now = new Date().toISOString();
    const fileFor = (label: string, id: string) => ({
      backupVersion: 2 as const,
      exportedAt: now,
      chat: {
        version: 1 as const,
        sessions: [
          {
            id,
            title: `${label} chat`,
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
            id,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            brief: createDefaultBrief({
              businessName: `${label} Studio`,
              adminEmail: `${label}@adom.example`,
            }),
          },
        ],
      },
    });

    const [summaryA, summaryB] = await Promise.all([
      importBackup(
        owner,
        parseBackup(fileFor("OwnerA", "11111111-1111-4111-8111-111111111111")),
      ),
      importBackup(
        other,
        parseBackup(fileFor("OwnerB", "22222222-2222-4222-8222-222222222222")),
      ),
    ]);

    expect(summaryA.studioDrafts).toBe(1);
    expect(summaryB.studioDrafts).toBe(1);
    expect((await chatStore.list(owner.id))[0].title).toBe("OwnerA chat");
    expect((await chatStore.list(other.id))[0].title).toBe("OwnerB chat");
    expect((await readStudioState(ownerIdA))[0].brief.businessName).toBe(
      "OwnerA Studio",
    );
    expect((await readStudioState(ownerIdB))[0].brief.businessName).toBe(
      "OwnerB Studio",
    );

    await emptyStudio(ownerIdB);
  });
});

// Customer accounts live in GLOBAL tables (customer_accounts,
// customer_sessions, customer_tokens) shared across every tenant in a
// PostgreSQL deployment. The export must therefore be scoped to customers
// linked to the exporting owner's orders, mirroring the SQLite test in
// backup.test.ts. These are the PostgreSQL counterparts of that test.
describe.runIf(connectionString)(
  "PostgreSQL customer backup is owner-scoped and restores safely",
  () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let buildBackup: any;
    let importBackup: any;
    let parseBackup: any;
    let ensureStudioUser: any;
    let canonicalUserId: any;
    let getDatabase: any;
    let closeDatabase: any;
    let customerAccountStore: any;
    let ordersStore: any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const customerPassword = "a sufficiently long password";

    beforeAll(async () => {
      process.env.DATABASE_URL = connectionString;
      const backup = await import("./backup");
      const identity = await import("@/lib/user-identity");
      const db = await import("@/db");
      const customers = await import("@/lib/customer-account-store");
      const orders = await import("./orders");

      buildBackup = backup.buildBackup;
      importBackup = backup.importBackup;
      parseBackup = backup.parseBackup;
      ensureStudioUser = identity.ensureStudioUser;
      canonicalUserId = identity.canonicalUserId;
      getDatabase = db.getDatabase;
      closeDatabase = db.closeDatabase;
      customerAccountStore = customers.getCustomerAccountStore();
      ordersStore = orders.getOrdersStore();
      await ensureStudioUser(owner);
    });

    async function emptyCustomerTables() {
      const { studioOrders, customerAccounts } = await import("@/db/schema");
      // Orders first: studio_orders.customer_account_id is a foreign key,
      // and customer_sessions/customer_tokens cascade from customer_accounts.
      await getDatabase().delete(studioOrders);
      await getDatabase().delete(customerAccounts);
    }

    /**
     * Places one order for the test owner and attaches a customer account to
     * it, the way checkout-attach or guest claim does. The order's draft is
     * created through the real studio draft store.
     */
    async function seedCustomer(label: string): Promise<{
      account: { id: string; email: string };
      token: string;
    }> {
      const { PostgresStudioDraftStore } = await import("./draft-store");
      const { createDefaultBrief } = await import("./site-brief/defaults");
      const draft = await new PostgresStudioDraftStore().create(
        owner,
        createDefaultBrief({
          businessName: `${label} Shop`,
          phone: "+233201234567",
          adminEmail: `${label}@adom.example`,
        }),
      );
      const account = await customerAccountStore.createAccount({
        email: `${label}-shopper@example.com`,
        name: `${label} Shopper`,
        password: customerPassword,
      });
      await customerAccountStore.verifyEmail(account.id);
      const session = await customerAccountStore.createSession(account.id);
      await customerAccountStore.createToken(
        account.id,
        "verify_email",
        60_000,
        `${label}-code`,
      );
      await ordersStore.create({
        ownerId: canonicalUserId(owner),
        draftId: draft.id,
        accessCode: `${label}-access-code`,
        status: "paid",
        currency: "GHS",
        subtotal: 100,
        deliveryFee: 0,
        total: 100,
        lines: [{ itemId: "i1", name: "Jollof Rice", price: 100, quantity: 1 }],
        customerName: `${label} Shopper`,
        customerPhone: "+233240000000",
        customerEmail: `${label}-shopper@example.com`,
        customerAccountId: account.id,
        paymentMethod: "cod",
      });
      return { account, token: session.token };
    }

    it("never exports another tenant's customer — accounts linked only to a different owner's orders, or to no orders at all, stay out", async () => {
      await emptyCustomerTables();
      // Owner A: a customer who ordered on A's shop -> belongs in A's backup.
      await seedCustomer("ownera");

      // A second tenant B sharing the global customer table, with B's own
      // customer who ordered only on B's shop -> must NOT enter A's backup.
      const otherUser = {
        id: "pgb-9002",
        login: "kofi",
        name: "Kofi Other",
      } as const;
      const otherOwnerId = await ensureStudioUser(otherUser);
      const { PostgresStudioDraftStore } = await import("./draft-store");
      const { createDefaultBrief } = await import("./site-brief/defaults");
      const otherDraft = await new PostgresStudioDraftStore().create(
        otherUser,
        createDefaultBrief({
          businessName: "Other Owner Shop",
          phone: "+233209999999",
          adminEmail: "other@adom.example",
        }),
      );
      const foreignAccount = await customerAccountStore.createAccount({
        email: "foreign-shopper@example.com",
        name: "Foreign Tenant",
        password: customerPassword,
      });
      await ordersStore.create({
        ownerId: otherOwnerId,
        draftId: otherDraft.id,
        accessCode: "foreign-access-code",
        status: "paid",
        currency: "GHS",
        subtotal: 50,
        deliveryFee: 0,
        total: 50,
        lines: [{ itemId: "i9", name: "Waakye", price: 50, quantity: 1 }],
        customerName: "Foreign Tenant",
        customerPhone: "+23320999888",
        customerEmail: "foreign-shopper@example.com",
        customerAccountId: foreignAccount.id,
        paymentMethod: "cod",
      });

      // An account with no order on any shop is excluded too.
      await customerAccountStore.createAccount({
        email: "never-ordered@example.com",
        name: "Never Ordered",
        password: customerPassword,
      });

      const backup = JSON.parse(JSON.stringify(await buildBackup(owner)));
      const emails = backup.customers.accounts.map(
        (customer: { email: string }) => customer.email,
      );
      expect(emails).toEqual(["ownera-shopper@example.com"]);
      expect(JSON.stringify(backup)).not.toContain(
        "foreign-shopper@example.com",
      );
      expect(JSON.stringify(backup)).not.toContain("never-ordered@example.com");
    });

    it("restores accounts, sessions and tokens so the customer can still sign in with the same password", async () => {
      await emptyCustomerTables();
      await seedCustomer("restore");
      const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
      expect(file.customers.accounts).toHaveLength(1);
      expect(file.customers.sessions).toHaveLength(1);
      expect(file.customers.tokens).toHaveLength(1);

      await emptyCustomerTables();

      const summary = await importBackup(owner, parseBackup(file));
      expect(summary.customerAccounts).toBe(1);
      expect(summary.skippedCustomerAccounts).toBe(0);
      expect(summary.customerSessions).toBe(1);
      expect(summary.customerTokens).toBe(1);

      const restored = await customerAccountStore.getByEmail(
        "restore-shopper@example.com",
      );
      expect(restored?.emailVerifiedAt).toBeDefined();
      // The scrypt envelope travelled as-is, so the same password still works.
      expect(
        await customerAccountStore.verifyPassword(
          "restore-shopper@example.com",
          customerPassword,
        ),
      ).toMatchObject({ email: "restore-shopper@example.com" });
      expect(
        await customerAccountStore.verifyPassword(
          "restore-shopper@example.com",
          "wrong password entirely",
        ),
      ).toBeNull();
    });

    it("never exports a readable password or session token — hashes only", async () => {
      await emptyCustomerTables();
      const { token } = await seedCustomer("hashonly");
      const { hashCustomerToken } = await import("@/lib/customer-password");
      const raw = JSON.stringify(await buildBackup(owner));

      expect(raw).not.toContain(customerPassword);
      expect(raw).not.toContain(token);
      expect(raw).toContain("scrypt$N=32768");
      expect(raw).toContain(hashCustomerToken(token));
    });

    it("re-importing an older backup never overwrites the current password or account", async () => {
      await emptyCustomerTables();
      const { account } = await seedCustomer("overwrite");
      const older = JSON.parse(JSON.stringify(await buildBackup(owner)));

      await customerAccountStore.updatePassword(
        account.id,
        "the newer replacement password",
      );

      const summary = await importBackup(owner, parseBackup(older));
      expect(summary.customerAccounts).toBe(0);
      expect(summary.skippedCustomerAccounts).toBe(1);

      expect(
        await customerAccountStore.verifyPassword(
          "overwrite-shopper@example.com",
          "the newer replacement password",
        ),
      ).toMatchObject({ email: "overwrite-shopper@example.com" });
      expect(
        await customerAccountStore.verifyPassword(
          "overwrite-shopper@example.com",
          customerPassword,
        ),
      ).toBeNull();
    });

    afterAll(async () => {
      await emptyCustomerTables();
      await closeDatabase();
      delete process.env.DATABASE_URL;
    });
  },
);
