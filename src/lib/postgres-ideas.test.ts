/**
 * PostgreSQL contract tests for the owner's idea notebook.
 *
 * These use the real PostgresIdeaStore against the real Drizzle schema. They
 * are skipped when no throwaway database is supplied rather than pretending
 * SQLite coverage proves the PostgreSQL queries behave the same way.
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;

describe.runIf(connectionString)("PostgreSQL idea store", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let getDatabase: any;
  let closeDatabase: any;
  let ideasTable: any;
  let eq: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const userA = "pg-ideas-user-a";
  const userB = "pg-ideas-user-b";

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    const ideaStore = await import("./idea-store");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");

    store = new ideaStore.PostgresIdeaStore();
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    ideasTable = schema.ideas;
    eq = drizzle.eq;
  });

  afterEach(async () => {
    for (const userId of [userA, userB]) {
      await getDatabase()
        .delete(ideasTable)
        .where(eq(ideasTable.userId, userId));
    }
  });

  afterAll(async () => {
    await closeDatabase?.();
    delete process.env.DATABASE_URL;
  });

  it("creates with defaults and lists only the caller's ideas", async () => {
    const idea = await store.create(userA, { title: "A's idea" });
    expect(idea.status).toBe("idea");
    expect(idea.priority).toBe(2);
    expect(idea.details).toBe("");

    await store.create(userB, { title: "B's idea", priority: 1 });

    const listA = await store.list(userA);
    expect(listA).toHaveLength(1);
    expect(listA[0].title).toBe("A's idea");
    expect(listA[0].userId).toBe(userA);

    const listB = await store.list(userB);
    expect(listB).toHaveLength(1);
    expect(listB[0].priority).toBe(1);
  });

  it("updates the caller's idea and not another user's", async () => {
    const idea = await store.create(userA, { title: "Rename me" });
    const updated = await store.update(userA, idea.id, {
      title: "Renamed",
      status: "building",
      priority: 1,
      details: "now with notes",
    });
    expect(updated).toMatchObject({
      title: "Renamed",
      status: "building",
      priority: 1,
      details: "now with notes",
    });

    // Cross-user update returns null and changes nothing.
    expect(
      await store.update(userB, idea.id, { title: "Hijacked" }),
    ).toBeNull();
    const untouched = await store.list(userA);
    expect(untouched[0].title).toBe("Renamed");
  });

  it("deletes the caller's idea and refuses another user's", async () => {
    const idea = await store.create(userA, { title: "Doomed" });
    expect(await store.remove(userB, idea.id)).toBe(false);
    expect(await store.list(userA)).toHaveLength(1);
    expect(await store.remove(userA, idea.id)).toBe(true);
    expect(await store.list(userA)).toHaveLength(0);
    // Second delete reports false.
    expect(await store.remove(userA, idea.id)).toBe(false);
  });
});
