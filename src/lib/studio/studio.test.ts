import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import {
  DraftConflictError,
  DraftNotFoundError,
  SqliteStudioDraftStore,
  getStudioSqliteDb,
  getStudioSqliteStore,
  normalizeBrief,
} from "./draft-store";
import { createDefaultBrief } from "./site-brief/defaults";
import { siteBriefSchemaV1, type SiteBriefV1 } from "./site-brief/schema";

const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "9002", login: "kofi", name: "Kofi" };

const dirs: string[] = [];
let store: SqliteStudioDraftStore;
let chatStore: SqliteChatStore;
let dbPath: string;
let legacyPath: string;

function brief(overrides: Partial<SiteBriefV1> = {}): SiteBriefV1 {
  return createDefaultBrief({
    businessName: "Adom Fashion House",
    adminEmail: "owner@adom.example",
    ...overrides,
  });
}

beforeEach(() => {
  // Temporary files only. No real .data file is ever opened by these tests.
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-studio-"));
  dirs.push(dir);
  dbPath = path.join(dir, "chat-store.sqlite");
  legacyPath = path.join(dir, "chat-store.json");
  chatStore = new SqliteChatStore(dbPath, legacyPath);
  setSqliteChatStoreForTests(chatStore);
  store = new SqliteStudioDraftStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("studio drafts share the chat database", () => {
  it("writes drafts into the very same SQLite file as chat", async () => {
    await store.create(userA, brief());
    expect(existsSync(dbPath)).toBe(true);

    const tables = getStudioSqliteDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: string }).name));

    expect(tables).toContain("studio_drafts");
    expect(tables).toContain("chat_sessions");
  });

  it("uses one connection, not a second handle onto the same file", () => {
    expect(getStudioSqliteStore().connection).toBe(chatStore.connection);
  });

  it("records the studio schema version in the dedicated studio_meta table", async () => {
    await store.create(userA, brief());
    const row = getStudioSqliteDb()
      .prepare("SELECT value FROM studio_meta WHERE key = ?")
      .get("studio-schema-version") as { value: string } | undefined;
    expect(row?.value).toBe("1");
  });

  it("keeps existing chat data intact when studio tables are added", async () => {
    await chatStore.create({ userId: userA.id, title: "Existing chat" });
    const before = await chatStore.list(userA.id);
    await store.create(userA, brief());
    const after = await chatStore.list(userA.id);
    expect(after.map((session) => session.id)).toEqual(
      before.map((session) => session.id),
    );
  });

  it("survives repeated startup against an existing file", async () => {
    const created = await store.create(userA, brief());

    // Simulate the process restarting against the same database file.
    setSqliteChatStoreForTests(new SqliteChatStore(dbPath, legacyPath));
    const reopened = new SqliteStudioDraftStore();
    const found = await reopened.get(userA, created.id);
    expect(found?.brief.businessName).toBe("Adom Fashion House");
  });
});

describe("draft CRUD", () => {
  it("creates a draft at revision 1 owned by the signed-in user", async () => {
    const draft = await store.create(userA, brief());
    expect(draft.revision).toBe(1);
    expect(draft.ownerId).toBe(canonicalUserId(userA));
    expect(draft.schemaVersion).toBe(1);
  });

  it("lists only the caller's own drafts", async () => {
    await store.create(userA, brief({ businessName: "Ama Shop" }));
    await store.create(userB, brief({ businessName: "Kofi Motors" }));

    const forA = await store.list(userA);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.brief.businessName).toBe("Ama Shop");
  });

  it("reopens a saved draft with its details intact", async () => {
    const created = await store.create(
      userA,
      brief({ phone: "+233201234567", services: ["Tailoring", "Repairs"] }),
    );
    const reopened = await store.get(userA, created.id);
    expect(reopened?.brief.phone).toBe("+233201234567");
    expect(reopened?.brief.services).toEqual(["Tailoring", "Repairs"]);
  });

  it("deletes a draft and refuses to delete somebody else's", async () => {
    const draft = await store.create(userA, brief());
    expect(await store.delete(userB, draft.id)).toBe(false);
    expect(await store.get(userA, draft.id)).not.toBeNull();
    expect(await store.delete(userA, draft.id)).toBe(true);
    expect(await store.get(userA, draft.id)).toBeNull();
  });
});

describe("owner isolation", () => {
  it("returns null for another owner's draft, exactly as for a random id", async () => {
    const draft = await store.create(userA, brief());
    expect(await store.get(userB, draft.id)).toBeNull();
    expect(
      await store.get(userB, "11111111-2222-3333-4444-555555555555"),
    ).toBeNull();
  });

  it("raises the same not-found error for a foreign draft as for a missing one", async () => {
    const draft = await store.create(userA, brief());

    const foreign = await store
      .update(userB, draft.id, brief({ businessName: "Hijack" }), 1)
      .catch((error: unknown) => error);
    const missing = await store
      .update(userB, "11111111-2222-3333-4444-555555555555", brief(), 1)
      .catch((error: unknown) => error);

    expect(foreign).toBeInstanceOf(DraftNotFoundError);
    expect(missing).toBeInstanceOf(DraftNotFoundError);
    expect((foreign as Error).message).toBe((missing as Error).message);
    expect((foreign as DraftNotFoundError).status).toBe(404);
  });

  it("leaves the real owner's draft untouched after a foreign write attempt", async () => {
    const draft = await store.create(userA, brief());
    await store
      .update(userB, draft.id, brief({ businessName: "Hijack" }), 1)
      .catch(() => undefined);
    const current = await store.get(userA, draft.id);
    expect(current?.brief.businessName).toBe("Adom Fashion House");
    expect(current?.revision).toBe(1);
  });
});

describe("optimistic concurrency (SQLite)", () => {
  it("accepts an update that carries the current revision", async () => {
    const draft = await store.create(userA, brief());
    const updated = await store.update(
      userA,
      draft.id,
      brief({ tagline: "Style that fits" }),
      draft.revision,
    );
    expect(updated.revision).toBe(2);
    expect(updated.brief.tagline).toBe("Style that fits");
  });

  it("rejects a stale revision with a conflict", async () => {
    const draft = await store.create(userA, brief());
    await store.update(userA, draft.id, brief({ tagline: "First" }), 1);

    const error = await store
      .update(userA, draft.id, brief({ tagline: "Second" }), 1)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DraftConflictError);
    expect((error as DraftConflictError).status).toBe(409);
  });

  it("lets exactly one of two writers on the same revision win", async () => {
    const draft = await store.create(userA, brief());

    const results = await Promise.allSettled([
      store.update(userA, draft.id, brief({ tagline: "Writer one" }), 1),
      store.update(userA, draft.id, brief({ tagline: "Writer two" }), 1),
    ]);

    const wins = results.filter((result) => result.status === "fulfilled");
    const losses = results.filter((result) => result.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DraftConflictError,
    );

    const final = await store.get(userA, draft.id);
    expect(final?.revision).toBe(2);
  });

  it("never reports success when no row was updated", async () => {
    const draft = await store.create(userA, brief());
    await store.delete(userA, draft.id);
    await expect(
      store.update(userA, draft.id, brief(), 1),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
  });
});

describe("changing choices does not lose business information", () => {
  it("keeps every business detail when the theme changes", async () => {
    const filled = brief({
      phone: "+233201234567",
      whatsapp: "+233241111111",
      address: "12 Oxford Street, Osu",
      hours: "Mon-Sat 8am-6pm",
      services: ["Tailoring"],
      products: [{ name: "Kente scarf" }],
      description: "Bespoke tailoring in Accra.",
    });
    const draft = await store.create(userA, filled);

    const updated = await store.update(
      userA,
      draft.id,
      { ...filled, selectedTheme: "luxury" },
      draft.revision,
    );

    expect(updated.brief.selectedTheme).toBe("luxury");
    expect(updated.brief.phone).toBe("+233201234567");
    expect(updated.brief.address).toBe("12 Oxford Street, Osu");
    expect(updated.brief.services).toEqual(["Tailoring"]);
    expect(updated.brief.products).toEqual([{ name: "Kente scarf" }]);
    expect(updated.brief.description).toBe("Bespoke tailoring in Accra.");
  });

  it("keeps business details when the package and website type change", async () => {
    const filled = brief({ phone: "+233201234567", tagline: "Fits you" });
    const draft = await store.create(userA, filled);

    const step = await store.update(
      userA,
      draft.id,
      { ...filled, selectedPackage: "business" },
      1,
    );
    const final = await store.update(
      userA,
      draft.id,
      {
        ...step.brief,
        category: "online-shop",
        selectedTemplate: "split-features",
      },
      step.revision,
    );

    expect(final.brief.selectedPackage).toBe("business");
    expect(final.brief.category).toBe("online-shop");
    expect(final.brief.phone).toBe("+233201234567");
    expect(final.brief.tagline).toBe("Fits you");
  });
});

/**
 * Stage 3 made bundle shops online-only. A bundle site saved before that rule
 * still carries "cod" and/or an enabled delivery option, and
 * siteBriefSchemaV1 now rejects both. normalizeBrief repairs that on read so
 * the owner's next autosave cannot freeze silently.
 */
describe("normalizeBrief self-heals stale bundle-shop payment config", () => {
  function bundleBrief(
    methods: Array<"cod" | "valmont_pay" | "momo"> = ["cod", "valmont_pay"],
    deliveryEnabled = true,
    paymentsEnabled = true,
  ): SiteBriefV1 {
    const base = brief({ category: "data-bundles" });
    return {
      ...base,
      items: [
        {
          id: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
      payments: {
        ...base.payments,
        enabled: paymentsEnabled,
        methods,
        delivery: { ...base.payments.delivery, enabled: deliveryEnabled },
      },
    };
  }

  it("stale bundle config fails the schema before the fix-up", () => {
    // Proves the trap is real: without normalizeBrief the brief is invalid.
    expect(siteBriefSchemaV1.safeParse(bundleBrief()).success).toBe(false);
  });

  it("keeps only valmont_pay and switches delivery off", () => {
    const normalized = normalizeBrief(bundleBrief());

    expect(normalized.payments.methods).toEqual(["valmont_pay"]);
    expect(normalized.payments.delivery.enabled).toBe(false);
    expect(siteBriefSchemaV1.safeParse(normalized).success).toBe(true);
  });

  it("sanitises methods even when payments are switched off", () => {
    // The wizard hides the method toggles for bundle shops, so an owner who
    // enables payments later must not land on a stale ["cod"].
    const normalized = normalizeBrief(bundleBrief(["cod"], false, false));

    expect(normalized.payments.methods).toEqual([]);
    expect(normalized.payments.enabled).toBe(false);
    expect(siteBriefSchemaV1.safeParse(normalized).success).toBe(true);
  });

  it("keeps valmont_pay and the delivery fee settings intact", () => {
    const stale = bundleBrief();
    const normalized = normalizeBrief(stale);

    expect(normalized.payments.enabled).toBe(true);
    expect(normalized.payments.delivery.fee).toBe(stale.payments.delivery.fee);
    expect(normalized.payments.notifications).toEqual(
      stale.payments.notifications,
    );
  });

  it("leaves a non-bundle brief untouched", () => {
    const nonBundle: SiteBriefV1 = {
      ...brief({ category: "online-shop" }),
      payments: {
        ...brief().payments,
        enabled: true,
        methods: ["cod", "momo"],
        delivery: {
          ...brief().payments.delivery,
          enabled: true,
          fee: 15,
        },
      },
    };
    const normalized = normalizeBrief(nonBundle);

    expect(normalized.payments.methods).toEqual(["cod", "momo"]);
    expect(normalized.payments.delivery.enabled).toBe(true);
    expect(normalized.payments.delivery.fee).toBe(15);
    expect(normalized).toEqual(nonBundle);
  });

  it("heals a stale bundle draft when it is read back from the store", async () => {
    const draft = await store.create(
      userA,
      bundleBrief(["cod", "valmont_pay"], true, false),
    );
    // Write the stale config straight to the row, bypassing validation, the way
    // a draft saved by the previous build would look on disk.
    const db = getStudioSqliteDb();
    const row = db
      .prepare("SELECT brief_json FROM studio_drafts WHERE id = ?")
      .get(draft.id) as { brief_json: string };
    db.prepare("UPDATE studio_drafts SET brief_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...JSON.parse(row.brief_json),
        payments: {
          ...JSON.parse(row.brief_json).payments,
          enabled: true,
          methods: ["cod", "valmont_pay"],
          delivery: { enabled: true, fee: 10, minimumOrder: 0 },
        },
      }),
      draft.id,
    );

    const loaded = await store.get(userA, draft.id);

    expect(loaded?.brief.payments.methods).toEqual(["valmont_pay"]);
    expect(loaded?.brief.payments.delivery.enabled).toBe(false);
    expect(siteBriefSchemaV1.safeParse(loaded?.brief).success).toBe(true);
  });
});
