/**
 * Real PostgreSQL contract tests for Website Studio drafts.
 *
 * These do NOT run against SQLite and they do NOT mock the database. They need
 * a throwaway PostgreSQL server, supplied by CI as a service container:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 *
 * When that variable is absent the whole file is skipped, so a local run never
 * pretends PostgreSQL was verified.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;

const userA: SessionUser = { id: "pg-9001", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "pg-9002", login: "kofi", name: "Kofi" };

describe.runIf(connectionString)("PostgreSQL studio drafts", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let DraftConflictError: any;
  let DraftNotFoundError: any;
  let createDefaultBrief: any;
  let canonicalUserId: any;
  let ensureStudioUser: any;
  let closeDatabase: any;
  let getDatabase: any;
  let studioDrafts: any;
  let eq: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;

    const draftStore = await import("./draft-store");
    const defaults = await import("./site-brief/defaults");
    const identity = await import("@/lib/user-identity");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");

    store = new draftStore.PostgresStudioDraftStore();
    DraftConflictError = draftStore.DraftConflictError;
    DraftNotFoundError = draftStore.DraftNotFoundError;
    createDefaultBrief = defaults.createDefaultBrief;
    canonicalUserId = identity.canonicalUserId;
    ensureStudioUser = identity.ensureStudioUser;
    closeDatabase = db.closeDatabase;
    getDatabase = db.getDatabase;
    studioDrafts = schema.studioDrafts;
    eq = drizzle.eq;

    // Both owners must exist before drafts can reference them.
    await ensureStudioUser(userA);
    await ensureStudioUser(userB);
  });

  afterEach(async () => {
    for (const user of [userA, userB]) {
      await getDatabase()
        .delete(studioDrafts)
        .where(eq(studioDrafts.ownerId, canonicalUserId(user)));
    }
  });

  afterAll(async () => {
    await closeDatabase?.();
    delete process.env.DATABASE_URL;
  });

  function brief(overrides: Record<string, unknown> = {}) {
    return createDefaultBrief({
      businessName: "Adom Fashion House",
      adminEmail: "owner@adom.example",
      ...overrides,
    });
  }

  it("creates and reads back a draft", async () => {
    const draft = await store.create(userA, brief());
    expect(draft.revision).toBe(1);
    expect(draft.ownerId).toBe(canonicalUserId(userA));

    const found = await store.get(userA, draft.id);
    expect(found?.brief.businessName).toBe("Adom Fashion House");
  });

  it("updates a draft that carries the current revision", async () => {
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

  it("rejects a stale revision with a 409 conflict", async () => {
    const draft = await store.create(userA, brief());
    await store.update(userA, draft.id, brief({ tagline: "First" }), 1);

    const error = await store
      .update(userA, draft.id, brief({ tagline: "Second" }), 1)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DraftConflictError);
    expect((error as { status: number }).status).toBe(409);
  });

  it("lets exactly one of two simultaneous same-revision writers win", async () => {
    const draft = await store.create(userA, brief());

    const results = await Promise.allSettled([
      store.update(userA, draft.id, brief({ tagline: "Writer one" }), 1),
      store.update(userA, draft.id, brief({ tagline: "Writer two" }), 1),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DraftConflictError,
    );

    const final = await store.get(userA, draft.id);
    expect(final.revision).toBe(2);
  });

  it("never returns success when the update matched zero rows", async () => {
    const draft = await store.create(userA, brief());
    await store.delete(userA, draft.id);
    await expect(
      store.update(userA, draft.id, brief(), 1),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it("gives owner B the same generic not-found as a random id", async () => {
    const draft = await store.create(userA, brief());

    expect(await store.get(userB, draft.id)).toBeNull();

    const foreign = await store
      .update(userB, draft.id, brief({ businessName: "Hijack" }), 1)
      .catch((cause: unknown) => cause);
    const missing = await store
      .update(userB, "11111111-2222-3333-4444-555555555555", brief(), 1)
      .catch((cause: unknown) => cause);

    expect(foreign).toBeInstanceOf(DraftNotFoundError);
    expect(missing).toBeInstanceOf(DraftNotFoundError);
    expect((foreign as Error).message).toBe((missing as Error).message);

    const untouched = await store.get(userA, draft.id);
    expect(untouched.brief.businessName).toBe("Adom Fashion House");
    expect(untouched.revision).toBe(1);
  });

  it("lists only the caller's drafts", async () => {
    await store.create(userA, brief({ businessName: "Ama Shop" }));
    await store.create(userB, brief({ businessName: "Kofi Motors" }));

    const forA = await store.list(userA);
    expect(forA).toHaveLength(1);
    expect(forA[0].brief.businessName).toBe("Ama Shop");
  });

  it("deletes only the caller's own draft", async () => {
    const draft = await store.create(userA, brief());
    expect(await store.delete(userB, draft.id)).toBe(false);
    expect(await store.get(userA, draft.id)).not.toBeNull();
    expect(await store.delete(userA, draft.id)).toBe(true);
    expect(await store.get(userA, draft.id)).toBeNull();
  });

  it("keeps business details when the theme changes", async () => {
    const filled = brief({ phone: "+233201234567", services: ["Tailoring"] });
    const draft = await store.create(userA, filled);
    const updated = await store.update(
      userA,
      draft.id,
      { ...filled, selectedTheme: "luxury" },
      draft.revision,
    );
    expect(updated.brief.selectedTheme).toBe("luxury");
    expect(updated.brief.phone).toBe("+233201234567");
    expect(updated.brief.services).toEqual(["Tailoring"]);
  });

  it("behaves the same as SQLite for the shared contract", async () => {
    // Same sequence the SQLite suite runs, asserted on the PostgreSQL store.
    const draft = await store.create(userA, brief());
    expect(draft.schemaVersion).toBe(1);
    expect(draft.revision).toBe(1);

    const second = await store.update(
      userA,
      draft.id,
      brief({ tagline: "x" }),
      1,
    );
    expect(second.revision).toBe(2);

    await expect(
      store.update(userA, draft.id, brief({ tagline: "y" }), 1),
    ).rejects.toBeInstanceOf(DraftConflictError);

    expect(await store.get(userB, draft.id)).toBeNull();
    expect(await store.delete(userA, draft.id)).toBe(true);
    expect(await store.get(userA, draft.id)).toBeNull();
  });
});
