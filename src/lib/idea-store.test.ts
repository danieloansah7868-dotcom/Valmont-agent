import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureIdeaSchema, SqliteIdeaStore } from "@/lib/idea-store";

const dirs: string[] = [];
let db: DatabaseSync;
let store: SqliteIdeaStore;

function freshStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-ideas-"));
  dirs.push(dir);
  db = new DatabaseSync(path.join(dir, "ideas.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  ensureIdeaSchema(db);
  store = new SqliteIdeaStore(db);
}

beforeEach(freshStore);

afterEach(() => {
  db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("SqliteIdeaStore", () => {
  it("creates an idea with defaults", async () => {
    const idea = await store.create("user-a", { title: "First idea" });
    expect(idea.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(idea.userId).toBe("user-a");
    expect(idea.title).toBe("First idea");
    expect(idea.details).toBe("");
    expect(idea.status).toBe("idea");
    expect(idea.priority).toBe(2);
    expect(idea.createdAt).toBe(idea.updatedAt);
  });

  it("creates with every field provided", async () => {
    const idea = await store.create("user-a", {
      title: "Ship the thing",
      details: "with all the parts",
      status: "planned",
      priority: 1,
    });
    expect(idea.status).toBe("planned");
    expect(idea.priority).toBe(1);
    expect(idea.details).toBe("with all the parts");
  });

  it("lists only the caller's ideas, newest update first", async () => {
    const first = await store.create("user-a", { title: "Older" });
    await store.create("user-b", { title: "Not mine" });
    // Small delay so the ISO timestamps differ.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await store.update("user-a", first.id, {
      status: "building",
    });
    expect(updated?.status).toBe("building");

    const list = await store.list("user-a");
    expect(list.map((idea) => idea.title)).toEqual(["Older"]);
    expect(list[0]!.status).toBe("building");
    expect(updated!.updatedAt >= first.updatedAt).toBe(true);

    const listB = await store.list("user-b");
    expect(listB.map((idea) => idea.title)).toEqual(["Not mine"]);
  });

  it("patches individual fields and bumps updated_at", async () => {
    const idea = await store.create("user-a", {
      title: "Rename me",
      details: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const patched = await store.update("user-a", idea.id, {
      title: "Renamed",
    });
    expect(patched?.title).toBe("Renamed");
    expect(patched?.details).toBe("");
    expect((patched?.updatedAt ?? "") >= idea.updatedAt).toBe(true);

    const detailsPatch = await store.update("user-a", idea.id, {
      details: "now with notes",
    });
    expect(detailsPatch?.details).toBe("now with notes");
    expect(detailsPatch?.title).toBe("Renamed");

    const priorityPatch = await store.update("user-a", idea.id, {
      priority: 3,
    });
    expect(priorityPatch?.priority).toBe(3);
  });

  it("returns null when updating another user's idea", async () => {
    const idea = await store.create("user-a", { title: "Secret plan" });
    const stolen = await store.update("user-b", idea.id, {
      title: "Hijacked",
    });
    expect(stolen).toBeNull();
    const untouched = await store.list("user-a");
    expect(untouched[0]!.title).toBe("Secret plan");
  });

  it("returns null when updating a missing idea", async () => {
    expect(
      await store.update("user-a", "does-not-exist", { title: "x" }),
    ).toBeNull();
  });

  it("deletes the caller's idea and reports true", async () => {
    const idea = await store.create("user-a", { title: "Doomed" });
    expect(await store.remove("user-a", idea.id)).toBe(true);
    expect(await store.list("user-a")).toEqual([]);
    // Deleting again reports false.
    expect(await store.remove("user-a", idea.id)).toBe(false);
  });

  it("cannot delete another user's idea", async () => {
    const idea = await store.create("user-a", { title: "Protected" });
    expect(await store.remove("user-b", idea.id)).toBe(false);
    expect((await store.list("user-a")).length).toBe(1);
  });

  it("creates the table idempotently (CREATE TABLE IF NOT EXISTS)", () => {
    expect(() => ensureIdeaSchema(db)).not.toThrow();
    expect(() => ensureIdeaSchema(db)).not.toThrow();
  });

  it("rejects an out-of-range status or priority at the database boundary", () => {
    // The API validates these with zod; the SQLite CHECK constraints are the
    // second line of defence, exercised directly here.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ideas(id, user_id, title, details, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, '', 'nonsense', 2, ?, ?)`,
        )
        .run(
          "22222222-2222-4222-8222-222222222222",
          "user-a",
          "Bad status",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO ideas(id, user_id, title, details, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, '', 'idea', 9, ?, ?)`,
        )
        .run(
          "33333333-3333-4333-8333-333333333333",
          "user-a",
          "Bad priority",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
    ).toThrow();
  });

  it("upserts imported ideas under the importing user only", async () => {
    const foreign = await store.create("user-a", { title: "A existing" });
    const written = store.importForUserSync("user-b", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "user-a",
        title: "From a backup",
        details: "owner must be forced to user-b",
        status: "planned",
        priority: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        // Collides with an existing id belonging to user-a: must be remapped
        // to a fresh id rather than overwriting or failing.
        id: foreign.id,
        userId: "user-a",
        title: "Colliding import",
        details: "",
        status: "idea",
        priority: 2,
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
    ]);
    expect(written).toBe(2);
    const listB = await store.list("user-b");
    expect(listB.map((idea) => idea.title).sort()).toEqual([
      "Colliding import",
      "From a backup",
    ]);
    for (const idea of listB) expect(idea.userId).toBe("user-b");
    // User-a's original row is untouched.
    const listA = await store.list("user-a");
    expect(listA.length).toBe(1);
    expect(listA[0]!.title).toBe("A existing");
  });
});
