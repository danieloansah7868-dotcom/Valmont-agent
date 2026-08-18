/**
 * Explicit Studio SQLite schema-version handling.
 *
 * The Studio schema on the shared SQLite file is versioned in a dedicated
 * `studio_meta` table and upgraded through sequential, transactional
 * migrations. These tests cover: fresh databases, chat-only databases,
 * upgrades of old Studio databases, failed upgrades (schema and metadata roll
 * back together), rejection of newer schemas, and repeated startup.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  ensureStudioSchema,
  migrateStudioSchema,
  readStudioSchemaVersion,
  STUDIO_SCHEMA_VERSION,
} from "./draft-store";
import { getSqliteChatStore } from "@/lib/chat-store";

const dirs: string[] = [];
let dbPath = "";
let legacyPath = "";

function freshDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-studio-migr-"));
  dirs.push(dir);
  dbPath = path.join(dir, "chat-store.sqlite");
  legacyPath = path.join(dir, "chat-store.json");
  // The chat store creates the chat schema; the Studio schema is a separate,
  // later concern that ensureStudioSchema adds to the same file.
  const store = new SqliteChatStore(dbPath, legacyPath);
  setSqliteChatStoreForTests(store);
}

afterEach(() => {
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((row) => String((row as { name: string }).name))
      .sort() ?? []
  );
}

describe("Studio schema migrations", () => {
  it("migrates a fresh database to the current version in one step", () => {
    freshDatabase();
    const db = getSqliteChatStore().connection;
    expect(tables(db)).not.toContain("studio_drafts");

    ensureStudioSchema(db);

    expect(tables(db)).toContain("studio_drafts");
    expect(tables(db)).toContain("studio_meta");
    expect(readStudioSchemaVersion(db)).toBe(STUDIO_SCHEMA_VERSION);
  });

  it("upgrades a chat-only database without touching chat data", async () => {
    freshDatabase();
    const store = getSqliteChatStore();
    const db = store.connection;
    store.create({ userId: "u1", title: "Existing chat" });
    const chatTableNames = tables(db);
    expect(chatTableNames).toContain("chat_sessions");
    expect(chatTableNames).not.toContain("studio_drafts");

    ensureStudioSchema(db);

    expect(tables(db)).toContain("studio_drafts");
    expect(readStudioSchemaVersion(db)).toBe(STUDIO_SCHEMA_VERSION);
    // The chat rows are untouched by the migration.
    await expect(store.list("u1")).resolves.toHaveLength(1);
  });

  it("upgrades an old Studio database that records version 0", () => {
    freshDatabase();
    const db = getSqliteChatStore().connection;
    // Simulate a half-created Studio schema: the meta table exists and says 0.
    db.exec(
      "CREATE TABLE studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO studio_meta(key, value) VALUES (?, ?)").run(
      "studio-schema-version",
      "0",
    );

    migrateStudioSchema(db);

    expect(tables(db)).toContain("studio_drafts");
    expect(readStudioSchemaVersion(db)).toBe(STUDIO_SCHEMA_VERSION);
  });

  it("honours the legacy chat_meta marker and moves it into studio_meta", () => {
    freshDatabase();
    const db = getSqliteChatStore().connection;
    // A database created by an earlier Phase 1 build: studio tables exist and
    // the version lives in chat_meta, not studio_meta.
    db.exec(`
      CREATE TABLE studio_drafts (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        template_version INTEGER NOT NULL DEFAULT 1,
        theme_version INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, brief_json TEXT NOT NULL
      );
      INSERT INTO chat_meta(key, value) VALUES ('studio-schema-version', '1');
    `);

    migrateStudioSchema(db);

    // No migration re-ran, the legacy marker was moved into studio_meta, and
    // the schema version is unchanged.
    expect(readStudioSchemaVersion(db)).toBe(1);
    const row = db
      .prepare("SELECT value FROM studio_meta WHERE key = ?")
      .get("studio-schema-version") as { value: string } | undefined;
    expect(row?.value).toBe("1");
  });

  it("rolls schema and metadata back together when an upgrade fails", () => {
    freshDatabase();
    const db = getSqliteChatStore().connection;
    // An object named studio_drafts already exists, so the migration's index
    // creation fails inside the upgrade transaction.
    db.exec("CREATE VIEW studio_drafts AS SELECT 1 AS id");

    expect(() => migrateStudioSchema(db)).toThrow();

    // Nothing of the failed upgrade survived: no studio tables, no recorded
    // version, and the pre-existing object is still there.
    expect(tables(db)).not.toContain("studio_meta");
    expect(tables(db)).toContain("studio_drafts"); // the view
    expect(readStudioSchemaVersion(db)).toBe(0);
  });

  it("rejects a database recorded with a newer schema version", () => {
    freshDatabase();
    const db = getSqliteChatStore().connection;
    db.exec(
      "CREATE TABLE studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO studio_meta(key, value) VALUES (?, ?)").run(
      "studio-schema-version",
      String(STUDIO_SCHEMA_VERSION + 1),
    );

    expect(() => ensureStudioSchema(db)).toThrow(/newer/);
    // Refusing to run is the whole point: nothing was written or changed.
    expect(readStudioSchemaVersion(db)).toBe(STUDIO_SCHEMA_VERSION + 1);
  });

  it("is a no-op across repeated startups", () => {
    freshDatabase();
    const first = getSqliteChatStore().connection;
    ensureStudioSchema(first);
    ensureStudioSchema(first);

    // "Restart": a brand-new connection to the same file runs the check again
    // and finds the schema already current.
    setSqliteChatStoreForTests(null);
    const reopened = new SqliteChatStore(dbPath, legacyPath);
    setSqliteChatStoreForTests(reopened);
    const reopenedDb = reopened.connection;
    expect(() => ensureStudioSchema(reopenedDb)).not.toThrow();
    expect(readStudioSchemaVersion(reopenedDb)).toBe(STUDIO_SCHEMA_VERSION);
    expect(tables(reopenedDb)).toContain("studio_drafts");
  });
});
