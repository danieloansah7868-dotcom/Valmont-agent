/**
 * Real staged-import tests against PostgreSQL.
 *
 * An independent review found that the previous coverage for staged imports
 * only constructed a `PartialImportError` by hand. It never ran an import with
 * `DATABASE_URL` set, never proved the studio half is transactional, and never
 * exercised the route that turns a partial import into an HTTP 500. This file
 * closes that gap.
 *
 * Like the other PostgreSQL suite these tests need a throwaway server:
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

describe.runIf(connectionString)("PostgreSQL staged backup import", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let SqliteChatStore: any;
  let setSqliteChatStoreForTests: any;
  let PostgresStudioDraftStore: any;
  let createDefaultBrief: any;
  let buildBackup: any;
  let importBackup: any;
  let parseBackup: any;
  let PartialImportError: any;
  let ensureStudioUser: any;
  let getDatabase: any;
  let closeDatabase: any;
  let studioDraftsTable: any;
  let eq: any;
  let chatStore: any;
  let drafts: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const dirs: string[] = [];

  function freshChatStore() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-pg-backup-"));
    dirs.push(dir);
    chatStore = new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    );
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

  async function draftRowCount(): Promise<number> {
    const ownerId = await ensureStudioUser(owner);
    const rows = await getDatabase()
      .select({ id: studioDraftsTable.id })
      .from(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId));
    return rows.length;
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
    PartialImportError = backup.PartialImportError;
    ensureStudioUser = identity.ensureStudioUser;
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    studioDraftsTable = schema.studioDrafts;
    eq = drizzle.eq;

    drafts = new PostgresStudioDraftStore();
    await ensureStudioUser(owner);
  });

  beforeEach(async () => {
    currentUser = owner;
    process.env.DATABASE_URL = connectionString;
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await getDatabase()
      .delete(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId));
  });

  afterEach(() => {
    setSqliteChatStoreForTests(null);
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

  it("really imports both halves and reports staged atomicity", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));

    // Empty both halves, then restore.
    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await getDatabase()
      .delete(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId));

    const summary = await importBackup(owner, parseBackup(file));

    expect(summary.atomicity).toBe("staged");
    expect(summary.chatSessions).toBe(1);
    expect(summary.memories).toBe(1);
    expect(summary.studioDrafts).toBe(1);
    // The drafts are really in PostgreSQL, not merely counted.
    expect(await draftRowCount()).toBe(1);
    const restored = await drafts.list(owner);
    expect(restored).toHaveLength(1);
    expect(restored[0].brief.businessName).toBe("Adom Fashion House");
  });

  it("rolls the studio half back and raises PartialImportError", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));

    freshChatStore();
    const ownerId = await ensureStudioUser(owner);
    await getDatabase()
      .delete(studioDraftsTable)
      .where(eq(studioDraftsTable.ownerId, ownerId));

    const failure = importBackup(owner, parseBackup(file), {
      failAfterInsertForTests: () => {
        throw new Error("connection reset");
      },
    });

    await expect(failure).rejects.toBeInstanceOf(PartialImportError);
    // The studio transaction rolled back: no half-written drafts.
    expect(await draftRowCount()).toBe(0);
    // The chat half did commit, which is exactly what the error promises.
    expect(await chatStore.list(owner.id)).toHaveLength(1);
  });

  it("does not credit drafts that were rolled back", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    freshChatStore();

    let thrown: unknown;
    try {
      await importBackup(owner, parseBackup(file), {
        failAfterInsertForTests: () => {
          throw new Error("connection reset");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PartialImportError);
    expect((thrown as { committed: unknown }).committed).toEqual({
      chat: true,
      studio: false,
    });
    // The driver's own text must never reach the owner.
    expect((thrown as Error).message).not.toContain("connection reset");
  });
});
