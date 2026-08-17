import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { SqliteStudioDraftStore } from "./draft-store";
import { createDefaultBrief } from "./site-brief/defaults";

const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "9002", login: "kofi", name: "Kofi" };

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;

function freshDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-backup-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
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

  it("PartialImportError explains exactly what landed", () => {
    const error = new PartialImportError(new Error("connection reset"));
    expect(error.status).toBe(500);
    expect(error.committed).toEqual({ chat: true, studio: false });
    expect(error.message).toMatch(/chat/i);
    expect(error.message).toMatch(/draft/i);
    // It must not leak the underlying driver text to the user.
    expect(error.message).not.toContain("connection reset");
  });
});
