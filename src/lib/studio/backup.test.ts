import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import {
  BACKUP_VERSION,
  BackupValidationError,
  buildBackup,
  importBackup,
  parseBackup,
  PartialImportError,
} from "./backup";
import { ImportInProgressError } from "./import-coordinator";
import { SqliteStudioDraftStore } from "./draft-store";
import { createDefaultBrief } from "./site-brief/defaults";
import { SqliteCustomerAccountStore } from "@/lib/customer-account-store";
import { hashCustomerToken } from "@/lib/customer-password";
import { SqliteOrdersStore, type NewOrderInput } from "./orders";

const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "9002", login: "kofi", name: "Kofi" };

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;
let dbPath = "";

function freshDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-backup-"));
  dirs.push(dir);
  dbPath = path.join(dir, "chat-store.sqlite");
  chatStore = new SqliteChatStore(dbPath, path.join(dir, "chat-store.json"));
  setSqliteChatStoreForTests(chatStore);
  drafts = new SqliteStudioDraftStore();
}

beforeEach(freshDatabase);

afterEach(() => {
  setSqliteChatStoreForTests(null);
  delete process.env.DATABASE_URL;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function seedUserA() {
  const session = await chatStore.create({
    userId: userA.id,
    title: "Planning",
  });
  await chatStore.appendMessages(session.id, userA.id, [
    {
      id: "m1",
      role: "user",
      content: "Please help me plan my shop website.",
      createdAt: new Date().toISOString(),
    },
  ]);
  await chatStore.addMemory({
    id: "mem1",
    userId: userA.id,
    scope: "personal",
    category: "preference",
    content: "Prefers WhatsApp contact.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const draft = await drafts.create(
    userA,
    createDefaultBrief({
      businessName: "Adom Fashion House",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
    }),
  );
  return { session, draft };
}

describe("parseBackup version handling", () => {
  it("accepts a v2 file", () => {
    const parsed = parseBackup({
      backupVersion: 2,
      exportedAt: new Date().toISOString(),
      chat: { version: 1, sessions: [], memories: [], memoryEnabled: true },
      studio: { version: 1, schemaVersion: 1, drafts: [] },
    });
    expect(parsed.sourceVersion).toBe(2);
  });

  it("accepts a legacy v1 chat-only file and treats studio as empty", () => {
    const parsed = parseBackup({ version: 1, sessions: [], memories: [] });
    expect(parsed.sourceVersion).toBe(1);
    expect(parsed.studio.drafts).toEqual([]);
  });

  it("rejects an unknown version before anything is written", () => {
    expect(() => parseBackup({ backupVersion: 3 })).toThrow(
      BackupValidationError,
    );
    expect(() => parseBackup({ backupVersion: 3 })).toThrow(
      /Unsupported backup version/,
    );
  });

  it("rejects a file with no version at all", () => {
    expect(() => parseBackup({ sessions: [] })).toThrow(BackupValidationError);
  });

  it("rejects non-object input", () => {
    expect(() => parseBackup("nonsense")).toThrow(BackupValidationError);
    expect(() => parseBackup([1, 2, 3])).toThrow(BackupValidationError);
    expect(() => parseBackup(null)).toThrow(BackupValidationError);
  });

  it("validates the whole file, not just the version", () => {
    expect(() =>
      parseBackup({
        backupVersion: 2,
        exportedAt: new Date().toISOString(),
        chat: { version: 1, sessions: "not-an-array", memories: [] },
        studio: { version: 1, schemaVersion: 1, drafts: [] },
      }),
    ).toThrow(BackupValidationError);
  });

  it("names the bad field without echoing the value in it", () => {
    const secret = "0244000111 private client number";
    let message = "";
    try {
      parseBackup({
        backupVersion: 2,
        exportedAt: new Date().toISOString(),
        chat: {
          version: 1,
          sessions: [],
          memories: [],
          memoryEnabled: secret,
        },
        studio: { version: 1, schemaVersion: 1, drafts: [] },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("chat.memoryEnabled");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("0244000111");
  });

  it("rejects a draft whose brief is invalid", () => {
    expect(() =>
      parseBackup({
        backupVersion: 2,
        exportedAt: new Date().toISOString(),
        chat: { version: 1, sessions: [], memories: [] },
        studio: {
          version: 1,
          schemaVersion: 1,
          drafts: [
            {
              id: "d1",
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              brief: { schemaVersion: 1, category: "not-a-category" },
            },
          ],
        },
      }),
    ).toThrow(BackupValidationError);
  });
});

describe("export", () => {
  it("produces a v2 file containing chat, memories and drafts", async () => {
    await seedUserA();
    const backup = await buildBackup(userA);

    expect(backup.backupVersion).toBe(BACKUP_VERSION);
    expect(backup.chat.version).toBe(1);
    expect(backup.chat.sessions).toHaveLength(1);
    expect(backup.chat.memories).toHaveLength(1);
    expect(backup.studio.version).toBe(1);
    expect(backup.studio.drafts).toHaveLength(1);
    expect(backup.studio.drafts[0]!.brief.businessName).toBe(
      "Adom Fashion House",
    );
  });

  it("exports only the caller's own data", async () => {
    await seedUserA();
    await drafts.create(
      userB,
      createDefaultBrief({ businessName: "Kofi Motors" }),
    );

    const backup = await buildBackup(userB);
    expect(backup.studio.drafts).toHaveLength(1);
    expect(backup.studio.drafts[0]!.brief.businessName).toBe("Kofi Motors");
  });

  it("re-validates cleanly through parseBackup (round-trippable shape)", async () => {
    await seedUserA();
    const backup = await buildBackup(userA);
    const reparsed = parseBackup(JSON.parse(JSON.stringify(backup)));
    expect(reparsed.sourceVersion).toBe(2);
    expect(reparsed.studio.drafts).toHaveLength(1);
  });

  it("does not include coordinator journal snapshots in a user backup", async () => {
    const SENTINEL = "JOURNAL-SENTINEL-CHAT-XY7-NOT-FOR-EXPORT";
    await seedUserA();
    const { ensureCoordinatorSchema } = await import("./import-coordinator");
    const db = chatStore.connection;
    ensureCoordinatorSchema(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO backup_import_jobs
         (id, owner_id, chat_user_id, mode, source_version, status,
          created_at, updated_at, payload_json, pre_state_json)
       VALUES (?, ?, ?, 'mixed', 2, 'completed', ?, ?, ?, ?)`,
    ).run(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      canonicalUserId(userA),
      userA.id,
      now,
      now,
      JSON.stringify({ sentinel: SENTINEL }),
      JSON.stringify({ chat: { sessions: [{ title: SENTINEL }] } }),
    );

    const backup = await buildBackup(userA);
    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("backup_import_jobs");
    expect(serialized).not.toContain("payload_json");
  });

  it("cannot combine chat and drafts from different points in time", async () => {
    await seedUserA();
    const originalSessionId = (await chatStore.list(userA.id))[0]!.id;
    const originalDraftId = (await drafts.list(userA))[0]!.id;

    // A second, adversarial connection to the same database file, standing in
    // for another process or server that commits mid-export.
    const other = new DatabaseSync(dbPath);
    try {
      const exported = await buildBackup(userA, {
        afterChatReadForTests: () => {
          // This runs inside the export's read transaction, AFTER the chat
          // half has been read and BEFORE the draft half. A writer on a
          // different connection commits a new session and a new draft here.
          const lateSessionId = "22222222-2222-4222-8222-222222222222";
          const lateDraftId = "33333333-3333-4333-8333-333333333333";
          other.exec("BEGIN");
          other
            .prepare(
              "INSERT INTO chat_sessions(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
            )
            .run(
              lateSessionId,
              userA.id,
              "Late session",
              "2026-01-02T00:00:00.000Z",
              "2026-01-02T00:00:00.000Z",
            );
          other
            .prepare(
              `INSERT INTO studio_drafts
                 (id, owner_id, schema_version, template_version, theme_version,
                  revision, created_at, updated_at, brief_json)
               VALUES (?,?,1,1,1,1,?,?,?)`,
            )
            .run(
              lateDraftId,
              canonicalUserId(userA),
              "2026-01-02T00:00:00.000Z",
              "2026-01-02T00:00:00.000Z",
              JSON.stringify(
                createDefaultBrief({ businessName: "Late Draft" }),
              ),
            );
          other.exec("COMMIT");
        },
      });

      // A snapshot export contains either the "before" state or the "after"
      // state — never the chat half from before the write and the draft half
      // from after it. Both late records must be absent, and both original
      // records present, for the export to be from one point in time.
      expect(exported.chat.sessions.map((s) => s.id)).not.toContain(
        "22222222-2222-4222-8222-222222222222",
      );
      expect(exported.studio.drafts.map((d) => d.id)).not.toContain(
        "33333333-3333-4333-8333-333333333333",
      );
      expect(exported.chat.sessions.map((s) => s.id)).toContain(
        originalSessionId,
      );
      expect(exported.studio.drafts.map((d) => d.id)).toContain(
        originalDraftId,
      );
    } finally {
      other.close();
    }
  });
});

describe("import round trip", () => {
  it("restores chat, memories and drafts into an empty database", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));

    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));

    expect(summary.sourceVersion).toBe(2);
    expect(summary.chatSessions).toBe(1);
    expect(summary.memories).toBe(1);
    expect(summary.studioDrafts).toBe(1);
    expect(summary.remappedDraftIds).toBe(0);

    const restoredDrafts = await drafts.list(userA);
    expect(restoredDrafts).toHaveLength(1);
    expect(restoredDrafts[0]!.brief.businessName).toBe("Adom Fashion House");
    expect(restoredDrafts[0]!.brief.phone).toBe("+233201234567");

    const sessions = await chatStore.list(userA.id);
    expect(sessions).toHaveLength(1);
    expect(await chatStore.memories(userA.id)).toHaveLength(1);
  });

  it("imports a legacy v1 chat-only file without touching studio", async () => {
    await seedUserA();
    const legacy = {
      version: 1,
      sessions: JSON.parse(
        JSON.stringify((await buildBackup(userA)).chat.sessions),
      ),
      memories: [],
      memoryEnabled: true,
    };

    freshDatabase();
    const summary = await importBackup(userA, parseBackup(legacy));

    expect(summary.sourceVersion).toBe(1);
    expect(summary.chatSessions).toBe(1);
    expect(summary.studioDrafts).toBe(0);
    expect(await drafts.list(userA)).toHaveLength(0);
    expect(await chatStore.list(userA.id)).toHaveLength(1);
  });
});

describe("customer accounts survive export and restore", () => {
  const CUSTOMER_PASSWORD = "a sufficiently long password";

  /**
   * The customer backup is scoped to accounts linked to the exporting
   * owner's ORDERS (an account a shopper never used on this owner's
   * shops is another tenant's data and never enters the file). The
   * seeding helper therefore places one order for userA and attaches
   * the customer account to it, the way checkout/claim would.
   */
  async function seedCustomer(): Promise<{
    account: { id: string; email: string; name: string };
    session: { token: string };
  }> {
    const store = new SqliteCustomerAccountStore();
    const account = await store.createAccount({
      email: "shopper@example.com",
      name: "Ama Shopper",
      password: CUSTOMER_PASSWORD,
    });
    await store.verifyEmail(account.id);
    const session = await store.createSession(account.id);
    await store.createToken(account.id, "verify_email", 60_000, "order-code-1");

    const orders = new SqliteOrdersStore();
    await orders.create({
      ownerId: canonicalUserId(userA),
      draftId: "draft-for-customer",
      accessCode: "order-code-1",
      status: "paid",
      currency: "GHS",
      subtotal: 100,
      deliveryFee: 0,
      total: 100,
      lines: [
        {
          itemId: "i1",
          name: "Jollof Rice",
          price: 100,
          quantity: 1,
        },
      ],
      customerName: "Ama Shopper",
      customerPhone: "+233240000000",
      customerEmail: "shopper@example.com",
      customerAccountId: account.id,
      paymentMethod: "cod",
    } satisfies NewOrderInput);
    return { account, session };
  }

  it("never exports a customer who never ordered on this owner's shops", async () => {
    // A customer of ANOTHER tenant (no order row links them to userA).
    const store = new SqliteCustomerAccountStore();
    await store.createAccount({
      email: "other-tenant-shopper@example.com",
      name: "Other Tenant",
      password: CUSTOMER_PASSWORD,
    });
    await seedUserA();
    const backup = await buildBackup(userA);
    expect(backup.customers?.accounts).toEqual([]);
    expect(JSON.stringify(backup)).not.toContain(
      "other-tenant-shopper@example.com",
    );
  });

  it("restores accounts, sessions and tokens into an empty database — the customer can still sign in with the same password", async () => {
    await seedCustomer();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    expect(backup.customers.accounts).toHaveLength(1);
    expect(backup.customers.sessions).toHaveLength(1);
    expect(backup.customers.tokens).toHaveLength(1);

    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));

    expect(summary.customerAccounts).toBe(1);
    expect(summary.skippedCustomerAccounts).toBe(0);
    expect(summary.customerSessions).toBe(1);
    expect(summary.customerTokens).toBe(1);

    const store = new SqliteCustomerAccountStore();
    const restored = await store.getByEmail("shopper@example.com");
    expect(restored?.emailVerifiedAt).toBeDefined();
    // The scrypt hash travelled as-is, so the same password still verifies.
    expect(
      await store.verifyPassword("shopper@example.com", CUSTOMER_PASSWORD),
    ).toMatchObject({ email: "shopper@example.com" });
  });

  it("never exports a readable password or session token — hashes only", async () => {
    const { session } = await seedCustomer();
    const raw = JSON.stringify(await buildBackup(userA));

    expect(raw).not.toContain(CUSTOMER_PASSWORD);
    expect(raw).not.toContain(session.token);
    expect(raw).toContain("scrypt$N=32768");
    expect(raw).toContain(hashCustomerToken(session.token));
  });

  it("restoring an older backup never overwrites the current password or account", async () => {
    const { account } = await seedCustomer();
    const older = JSON.parse(JSON.stringify(await buildBackup(userA)));

    const live = new SqliteCustomerAccountStore();
    await live.updatePassword(account.id, "the newer replacement password");

    const summary = await importBackup(userA, parseBackup(older));
    expect(summary.customerAccounts).toBe(0);
    expect(summary.skippedCustomerAccounts).toBe(1);

    expect(
      await live.verifyPassword(
        "shopper@example.com",
        "the newer replacement password",
      ),
    ).toMatchObject({ email: "shopper@example.com" });
    expect(
      await live.verifyPassword("shopper@example.com", CUSTOMER_PASSWORD),
    ).toBeNull();
  });

  it("refuses a file where a password hash is not an scrypt envelope", async () => {
    await seedCustomer();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    backup.customers.accounts[0].passwordHash = "not-a-hash-at-all";

    expect(() => parseBackup(backup)).toThrow(BackupValidationError);
  });

  it("a v2 file written before customer accounts existed still imports cleanly", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    delete backup.customers;

    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));

    expect(summary.studioDrafts).toBe(1);
    expect(summary.customerAccounts).toBe(0);
    expect(summary.customerSessions).toBe(0);
    expect(summary.customerTokens).toBe(0);
  });
});

describe("ownership is never taken from the file", () => {
  it("assigns imported drafts to the authenticated user, not the file's owner", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    expect(backup.studio.drafts[0].ownerId).toBe(canonicalUserId(userA));

    freshDatabase();
    // User B imports user A's file.
    await importBackup(userB, parseBackup(backup));

    const forB = await drafts.list(userB);
    expect(forB).toHaveLength(1);
    expect(forB[0]!.ownerId).toBe(canonicalUserId(userB));
    expect(await drafts.list(userA)).toHaveLength(0);
  });

  it("ignores a forged owner id inside the file", async () => {
    const now = new Date().toISOString();
    const forged = {
      backupVersion: 2,
      exportedAt: now,
      chat: { version: 1, sessions: [], memories: [] },
      studio: {
        version: 1,
        schemaVersion: 1,
        drafts: [
          {
            id: "11111111-2222-3333-4444-555555555555",
            ownerId: "somebody-else-entirely",
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
            brief: createDefaultBrief({ businessName: "Forged" }),
          },
        ],
      },
    };

    await importBackup(userA, parseBackup(forged));

    const mine = await drafts.list(userA);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.ownerId).toBe(canonicalUserId(userA));
  });
});

describe("id collisions", () => {
  it("gives a fresh id to a draft whose id already exists, keeping both", async () => {
    const { draft } = await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));

    // Import into the same database that still holds the original.
    const summary = await importBackup(userA, parseBackup(backup));

    expect(summary.remappedDraftIds).toBe(1);
    const all = await drafts.list(userA);
    expect(all).toHaveLength(2);
    expect(all.filter((item) => item.id === draft.id)).toHaveLength(1);
    expect(new Set(all.map((item) => item.id)).size).toBe(2);
  });

  it("remaps deterministically: every colliding draft is counted", async () => {
    await drafts.create(userA, createDefaultBrief({ businessName: "One" }));
    await drafts.create(userA, createDefaultBrief({ businessName: "Two" }));
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));

    const summary = await importBackup(userA, parseBackup(backup));

    expect(summary.remappedDraftIds).toBe(2);
    expect(await drafts.list(userA)).toHaveLength(4);
  });

  it("does not remap when the ids are free", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));
    expect(summary.remappedDraftIds).toBe(0);
  });
});

describe("rollback", () => {
  it("rolls chat, memories and drafts back together when a write fails midway", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));

    freshDatabase();
    const before = {
      sessions: (await chatStore.list(userA.id)).length,
      drafts: (await drafts.list(userA)).length,
    };
    expect(before).toEqual({ sessions: 0, drafts: 0 });

    await expect(
      importBackup(userA, parseBackup(backup), {
        failAfterInsertForTests: () => {
          throw new Error("simulated failure after inserts");
        },
      }),
    ).rejects.toThrow(/simulated failure/);

    // Nothing at all survived the failed import.
    expect(await chatStore.list(userA.id)).toHaveLength(0);
    expect(await chatStore.memories(userA.id)).toHaveLength(0);
    expect(await drafts.list(userA)).toHaveLength(0);
  });

  it("leaves pre-existing data untouched after a failed import", async () => {
    const { draft } = await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));

    await expect(
      importBackup(userA, parseBackup(backup), {
        failAfterInsertForTests: () => {
          throw new Error("simulated failure after inserts");
        },
      }),
    ).rejects.toThrow(/simulated failure/);

    const after = await drafts.list(userA);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(draft.id);
    expect(after[0]!.brief.businessName).toBe("Adom Fashion House");
    expect(await chatStore.list(userA.id)).toHaveLength(1);
  });
});

describe("draft ids must be UUIDs before anything is written", () => {
  function fileWithDraftId(id: string) {
    return {
      backupVersion: 2,
      exportedAt: new Date().toISOString(),
      chat: { version: 1, sessions: [], memories: [] },
      studio: {
        version: 1,
        schemaVersion: 1,
        drafts: [
          {
            id,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            brief: createDefaultBrief({ businessName: "Adom" }),
          },
        ],
      },
    };
  }

  it("rejects ids that are not UUIDs", () => {
    for (const id of [
      "d1",
      "",
      "not-a-uuid",
      "../../etc/passwd",
      "'; DROP TABLE studio_drafts; --",
      "x".repeat(200),
    ]) {
      expect(() => parseBackup(fileWithDraftId(id)), id).toThrow(
        BackupValidationError,
      );
    }
  });

  it("accepts a real UUID", () => {
    const parsed = parseBackup(
      fileWithDraftId("3f4b2c1e-7a9d-4c8b-9f21-5d6e7a8b9c01"),
    );
    expect(parsed.studio.drafts).toHaveLength(1);
  });

  it("names the offending field without echoing the bad id", () => {
    let message = "";
    try {
      parseBackup(fileWithDraftId("secret-looking-value-123"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("studio.drafts");
    expect(message).not.toContain("secret-looking-value-123");
  });
});

describe("counts describe what was written, not what the file claimed", () => {
  // Regression cover for an independent-review finding: a memory whose text
  // matches a secret pattern is dropped on import, but the summary counted it
  // as restored, so the owner was told data came back when it had not.

  it("does not count a redacted memory as restored", async () => {
    // Build a real export, then replace the memory text with something the
    // secret filter will reject. This is the reviewer's reproduction.
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    expect(backup.chat.memories).toHaveLength(1);
    backup.chat.memories[0].content = "password=perfectly-legitimate-note";

    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));

    // The store really is empty...
    expect(await chatStore.memories(userA.id)).toHaveLength(0);
    // ...so the summary must say so rather than claiming one was restored.
    expect(summary.memories).toBe(0);
    expect(summary.skippedMemories).toBe(1);
  });

  it("counts a memory that is genuinely stored", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));
    expect(summary.memories).toBe(1);
    expect(summary.skippedMemories).toBe(0);
    expect(await chatStore.memories(userA.id)).toHaveLength(summary.memories);
  });

  it("draft and session counts match the rows actually present", async () => {
    await seedUserA();
    const backup = JSON.parse(JSON.stringify(await buildBackup(userA)));
    freshDatabase();
    const summary = await importBackup(userA, parseBackup(backup));
    expect(await drafts.list(userA)).toHaveLength(summary.studioDrafts);
    expect(await chatStore.list(userA.id)).toHaveLength(summary.chatSessions);
  });
});

describe("import atomicity is reported, not assumed", () => {
  it("reports a single transaction on SQLite", async () => {
    await seedUserA();
    const backup = await buildBackup(userA);
    const summary = await importBackup(
      userB,
      parseBackup(JSON.parse(JSON.stringify(backup))),
    );
    expect(summary.atomicity).toBe("single-transaction");
  });

  it("refuses a second same-owner SQLite import with 409 before either store changes", async () => {
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
              adminEmail: `${label.replaceAll(" ", "").toLowerCase()}@adom.example`,
            }),
          },
        ],
      },
    });

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalReady!: () => void;
    const firstLockVisible = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    const first = importBackup(
      userA,
      parseBackup(fileFor("Import A", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
      {
        onLockAcquired: async () => {
          signalReady();
          await holdFirst;
        },
      },
    );
    await firstLockVisible;
    expect(await chatStore.list(userA.id)).toHaveLength(0);
    expect(await drafts.list(userA)).toHaveLength(0);

    await expect(
      importBackup(
        userA,
        parseBackup(
          fileFor("Import B", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        ),
      ),
    ).rejects.toBeInstanceOf(ImportInProgressError);

    expect(await chatStore.list(userA.id)).toHaveLength(0);
    expect(await drafts.list(userA)).toHaveLength(0);

    releaseFirst();
    const summary = await first;
    expect(summary.atomicity).toBe("single-transaction");
    expect(summary.chatSessions).toBe(1);
    expect(summary.studioDrafts).toBe(1);
    expect((await chatStore.list(userA.id))[0]!.title).toBe("Import A chat");
    expect((await drafts.list(userA))[0]!.brief.businessName).toBe(
      "Import A Studio",
    );
  });

  // This checks the error object's shape only. It constructs the error
  // directly; the real rollback behaviour is covered against two live engines
  // by `postgres-backup.test.ts`, and the route's 500 response by
  // `backup-route.test.ts`. PartialImportError is the catastrophic, exceptional
  // outcome (the rollback itself failed), not the normal result of an import
  // that failed part-way.
  it("PartialImportError names the halves known to have committed", () => {
    const error = new PartialImportError(new Error("connection reset"), {
      chat: true,
      studio: false,
    });
    expect(error.status).toBe(500);
    expect(error.committed).toEqual({ chat: true, studio: false });
    expect(error.message).toMatch(/rolled back/i);
    expect(error.message).toMatch(/recovery/i);
    // It must not leak the underlying driver text to the user.
    expect(error.message).not.toContain("connection reset");
  });
});
