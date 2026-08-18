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
    // The job is durably recorded as completed.
    const jobs = coordinator.listImportJobs(ownerId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
  });

  it.each([
    "job-created",
    "chat-imported",
    "chat-committed",
    "studio-imported",
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
    const jobId = await coordinator.beginImportJob(owner, ownerId, parsed);
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions as ChatSession[],
        memories: parsed.chat.memories as ChatMemory[],
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(jobId);
    // The chat half really did land before the "crash".
    expect(await chatStore.list(owner.id)).toHaveLength(1);

    // "Restart": a brand-new connection to the same SQLite file and a fresh
    // PostgreSQL client. The coordinator record survives on disk.
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
    const crashedJobId = await coordinator.beginImportJob(
      owner,
      ownerId,
      parsed,
    );
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions as ChatSession[],
        memories: parsed.chat.memories as ChatMemory[],
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(crashedJobId);
    expect(await chatStore.list(owner.id)).toHaveLength(1);

    // The next import attempt self-heals: it rolls the crashed job back, then
    // runs the new import.
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
    const jobId = await coordinator.beginImportJob(owner, ownerId, parsed);
    chatStore.runInTransaction(() => {
      chatStore.importUserSync(owner.id, {
        sessions: parsed.chat.sessions as ChatSession[],
        memories: parsed.chat.memories as ChatMemory[],
        memoryEnabled: parsed.chat.memoryEnabled,
      });
    });
    coordinator.markChatCommitted(jobId);
    expect(await chatStore.list(owner.id)).toHaveLength(1);

    await closeDatabase();
    process.env.DATABASE_URL = "postgres://postgres:hunter2@127.0.0.1:1/none";

    await expect(
      coordinator.restoreJob(coordinator.getImportJob(jobId)),
    ).rejects.toThrow();
    // The job stays "restoring" — recovery retries, it is not lost.
    expect(coordinator.getImportJob(jobId).status).toBe("restoring");

    // PostgreSQL comes back; recovery finishes the rollback.
    await closeDatabase();
    process.env.DATABASE_URL = connectionString;
    await coordinator.recoverPendingImports();

    const after = await captureBeforeState(ownerId);
    expect(after).toEqual(before);
    expect(coordinator.getImportJob(jobId).status).toBe("restored");
  });
});
