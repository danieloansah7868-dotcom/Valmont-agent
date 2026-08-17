/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  siteBriefSchemaV1,
  type SiteBriefV1,
  type StudioDraft,
} from "./site-brief/schema";
import { canonicalUserId } from "@/lib/user-identity";
import type { SessionUser } from "@/lib/auth";
import { getDatabase } from "@/db";
import { studioDrafts } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";

export interface StudioDraftStore {
  create(user: SessionUser, brief: Partial<SiteBriefV1>): Promise<StudioDraft>;
  get(user: SessionUser, id: string): Promise<StudioDraft | null>;
  list(user: SessionUser): Promise<StudioDraft[]>;
  update(
    user: SessionUser,
    id: string,
    brief: Partial<SiteBriefV1>,
    expectedRevision: number,
  ): Promise<StudioDraft>;
  delete(user: SessionUser, id: string): Promise<boolean>;
}

function validatedBrief(input: Partial<SiteBriefV1>): SiteBriefV1 {
  return siteBriefSchemaV1.parse(input);
}

function nowIso() {
  return new Date().toISOString();
}

// ---- SQLite (co-located with chat-store.sqlite) ----
function sqlitePath(): string {
  // Reuse existing CHAT_SQLITE_PATH logic; Studio tables live in same file.
  const legacy =
    process.env.CHAT_STORE_PATH ||
    path.join(process.cwd(), ".data", "chat-store.json");
  const sqlite =
    process.env.CHAT_SQLITE_PATH ||
    legacy.replace(/\.json$/, ".sqlite") ||
    `${legacy}.sqlite`;
  // Ensure distinct handled by chat-store; just return resolved
  return sqlite;
}

let sqliteDb: DatabaseSync | undefined;
function getSqliteDb(): DatabaseSync {
  if (sqliteDb) return sqliteDb;
  const p = sqlitePath();
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  sqliteDb = new DatabaseSync(p);
  sqliteDb.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
  );
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS studio_drafts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      template_version INTEGER NOT NULL DEFAULT 1,
      theme_version INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      brief_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_drafts_owner_updated ON studio_drafts(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO studio_meta(key,value) VALUES ('studio_schema_version','1');
  `);
  return sqliteDb;
}

class SqliteStudioDraftStore implements StudioDraftStore {
  async create(
    user: SessionUser,
    brief: Partial<SiteBriefV1>,
  ): Promise<StudioDraft> {
    const vb = validatedBrief(brief);
    const ownerId = canonicalUserId(user);
    const id = randomUUID();
    const ts = nowIso();
    const draft: StudioDraft = {
      id,
      ownerId,
      schemaVersion: 1,
      templateRegistryVersion: 1,
      themeRegistryVersion: 1,
      revision: 1,
      createdAt: ts,
      updatedAt: ts,
      brief: vb,
    };
    const db = getSqliteDb();
    db.prepare(
      "INSERT INTO studio_drafts(id,owner_id,schema_version,template_version,theme_version,revision,created_at,updated_at,brief_json) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, ownerId, 1, 1, 1, 1, ts, ts, JSON.stringify(vb));
    return draft;
  }
  async get(user: SessionUser, id: string): Promise<StudioDraft | null> {
    const ownerId = canonicalUserId(user);
    const row = getSqliteDb()
      .prepare("SELECT * FROM studio_drafts WHERE id=? AND owner_id=?")
      .get(id, ownerId) as any;
    if (!row) return null;
    return rowToDraft(row);
  }
  async list(user: SessionUser): Promise<StudioDraft[]> {
    const ownerId = canonicalUserId(user);
    const rows = getSqliteDb()
      .prepare(
        "SELECT * FROM studio_drafts WHERE owner_id=? ORDER BY updated_at DESC",
      )
      .all(ownerId) as any[];
    return rows.map(rowToDraft);
  }
  async update(
    user: SessionUser,
    id: string,
    brief: Partial<SiteBriefV1>,
    expectedRevision: number,
  ): Promise<StudioDraft> {
    const vb = validatedBrief(brief);
    const ownerId = canonicalUserId(user);
    const db = getSqliteDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT revision FROM studio_drafts WHERE id=? AND owner_id=?")
        .get(id, ownerId) as any;
      if (!row) {
        db.exec("ROLLBACK");
        throw new Error("Draft not found");
      }
      if (row.revision !== expectedRevision) {
        db.exec("ROLLBACK");
        const e = new Error(
          "Conflict: draft was modified elsewhere. Reload and retry.",
        );
        (e as any).status = 409;
        throw e;
      }
      const ts = nowIso();
      const newRev = expectedRevision + 1;
      const changes = db
        .prepare(
          "UPDATE studio_drafts SET brief_json=?, revision=?, updated_at=? WHERE id=? AND owner_id=? AND revision=?",
        )
        .run(JSON.stringify(vb), newRev, ts, id, ownerId, expectedRevision);
      if (Number((changes as any).changes) === 0) {
        db.exec("ROLLBACK");
        const e = new Error("Conflict");
        (e as any).status = 409;
        throw e;
      }
      db.exec("COMMIT");
      return (await this.get(user, id))!;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
  async delete(user: SessionUser, id: string): Promise<boolean> {
    const ownerId = canonicalUserId(user);
    const r = getSqliteDb()
      .prepare("DELETE FROM studio_drafts WHERE id=? AND owner_id=?")
      .run(id, ownerId);
    return Number((r as any).changes) > 0;
  }
}

class PostgresStudioDraftStore implements StudioDraftStore {
  async create(
    user: SessionUser,
    brief: Partial<SiteBriefV1>,
  ): Promise<StudioDraft> {
    const vb = validatedBrief(brief);
    const ownerId = canonicalUserId(user);
    // ensure users row
    const { ensureStudioUser } = await import("@/lib/user-identity");
    await ensureStudioUser(user);
    const id = randomUUID();
    const ts = new Date();
    await getDatabase()
      .insert(studioDrafts)
      .values({
        id,
        ownerId,
        schemaVersion: 1,
        templateVersion: 1,
        themeVersion: 1,
        revision: 1,
        createdAt: ts,
        updatedAt: ts,
        brief: vb as any,
      });
    return {
      id,
      ownerId,
      schemaVersion: 1,
      templateRegistryVersion: 1,
      themeRegistryVersion: 1,
      revision: 1,
      createdAt: ts.toISOString(),
      updatedAt: ts.toISOString(),
      brief: vb,
    };
  }
  async get(user: SessionUser, id: string): Promise<StudioDraft | null> {
    const ownerId = canonicalUserId(user);
    const [row] = await getDatabase()
      .select()
      .from(studioDrafts)
      .where(and(eq(studioDrafts.id, id), eq(studioDrafts.ownerId, ownerId)))
      .limit(1);
    if (!row) return null;
    return pgRowToDraft(row);
  }
  async list(user: SessionUser): Promise<StudioDraft[]> {
    const ownerId = canonicalUserId(user);
    const rows = await getDatabase()
      .select()
      .from(studioDrafts)
      .where(eq(studioDrafts.ownerId, ownerId))
      .orderBy(desc(studioDrafts.updatedAt));
    return rows.map(pgRowToDraft);
  }
  async update(
    user: SessionUser,
    id: string,
    brief: Partial<SiteBriefV1>,
    expectedRevision: number,
  ): Promise<StudioDraft> {
    const vb = validatedBrief(brief);
    const ownerId = canonicalUserId(user);
    const db = getDatabase();
    const [existing] = await db
      .select()
      .from(studioDrafts)
      .where(and(eq(studioDrafts.id, id), eq(studioDrafts.ownerId, ownerId)))
      .limit(1);
    if (!existing) throw new Error("Draft not found");
    if (existing.revision !== expectedRevision) {
      const e = new Error(
        "Conflict: draft was modified elsewhere. Reload and retry.",
      );
      (e as any).status = 409;
      throw e;
    }
    const ts = new Date();
    await db
      .update(studioDrafts)
      .set({ brief: vb as any, revision: expectedRevision + 1, updatedAt: ts })
      .where(
        and(
          eq(studioDrafts.id, id),
          eq(studioDrafts.revision, expectedRevision),
        ),
      );
    return (await this.get(user, id))!;
  }
  async delete(user: SessionUser, id: string): Promise<boolean> {
    const ownerId = canonicalUserId(user);
    const r = await getDatabase()
      .delete(studioDrafts)
      .where(and(eq(studioDrafts.id, id), eq(studioDrafts.ownerId, ownerId)));
    return (r as any).rowCount > 0;
  }
}

function rowToDraft(row: any): StudioDraft {
  return {
    id: row.id,
    ownerId: row.owner_id,
    schemaVersion: row.schema_version,
    templateRegistryVersion: row.template_version,
    themeRegistryVersion: row.theme_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    brief: JSON.parse(row.brief_json),
  };
}
function pgRowToDraft(row: any): StudioDraft {
  return {
    id: row.id,
    ownerId: row.ownerId,
    schemaVersion: row.schemaVersion,
    templateRegistryVersion: row.templateVersion,
    themeRegistryVersion: row.themeVersion,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    brief: row.brief as SiteBriefV1,
  };
}

export function getStudioDraftStore(): StudioDraftStore {
  if (process.env.DATABASE_URL) return new PostgresStudioDraftStore();
  return new SqliteStudioDraftStore();
}

// for tests: reset sqlite handle
export function _resetStudioSqliteForTests() {
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch {}
    sqliteDb = undefined;
  }
}
