import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { ideas } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";

/**
 * The owner's private notebook of ideas and future plans.
 *
 * Ideas are scoped to the signed-in account exactly like chat memories: every
 * query binds the user id, and an id that belongs to another account is
 * invisible — updates return null and deletions return false. Nothing stored
 * here is ever fed to the chat model.
 */
export const IDEA_STATUSES = [
  "idea",
  "planned",
  "building",
  "done",
  "dropped",
] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** Priority levels: 1 = Now, 2 = Soon, 3 = Later. */
export const IDEA_PRIORITIES = [1, 2, 3] as const;
export type IdeaPriority = (typeof IDEA_PRIORITIES)[number];

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return (
    typeof value === "string" &&
    (IDEA_STATUSES as readonly string[]).includes(value)
  );
}

export interface IdeaRecord {
  id: string;
  userId: string;
  title: string;
  details: string;
  status: IdeaStatus;
  priority: IdeaPriority;
  createdAt: string;
  updatedAt: string;
}

export interface NewIdeaInput {
  title: string;
  details?: string;
  status?: IdeaStatus;
  priority?: IdeaPriority;
}

export type IdeaPatch = Partial<
  Pick<IdeaRecord, "title" | "details" | "status" | "priority">
>;

export interface IdeaStore {
  list(userId: string): Promise<IdeaRecord[]>;
  create(userId: string, input: NewIdeaInput): Promise<IdeaRecord>;
  update(
    userId: string,
    id: string,
    patch: IdeaPatch,
  ): Promise<IdeaRecord | null>;
  remove(userId: string, id: string): Promise<boolean>;
}

function ideaFromRow(row: Record<string, unknown>): IdeaRecord {
  const status = String(row.status);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    details: row.details === null ? "" : String(row.details),
    status: (IDEA_STATUSES as readonly string[]).includes(status)
      ? (status as IdeaStatus)
      : "idea",
    priority: IDEA_PRIORITIES.includes(Number(row.priority) as IdeaPriority)
      ? (Number(row.priority) as IdeaPriority)
      : 2,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Creates the `ideas` table on the shared chat-store SQLite connection if it is
 * not already there. Uses `CREATE TABLE IF NOT EXISTS` exactly like the Studio
 * stores, so a fresh file and an existing file both open without migrations.
 * Exported so the complete-backup export can ensure the table before opening
 * its read transaction (DDL inside a read snapshot would fail under
 * concurrency).
 */
export function ensureIdeaSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','planned','building','done','dropped')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1,2,3)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ideas_user_status_updated ON ideas(user_id, status, updated_at DESC);
  `);
}

/**
 * Local SQLite store. Lives on the SAME shared connection as chat memories and
 * the Studio stores (`getSqliteChatStore()`), so an idea write participates in
 * the same all-or-nothing transactions as a complete-backup import.
 */
export class SqliteIdeaStore implements IdeaStore {
  private readonly db: DatabaseSync;

  constructor(connection?: DatabaseSync) {
    this.db = connection ?? getSqliteChatStore().connection;
    ensureIdeaSchema(this.db);
  }

  async list(userId: string): Promise<IdeaRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM ideas WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(ideaFromRow);
  }

  async create(userId: string, input: NewIdeaInput): Promise<IdeaRecord> {
    const now = new Date().toISOString();
    const idea: IdeaRecord = {
      id: randomUUID(),
      userId,
      title: input.title,
      details: input.details ?? "",
      status: input.status ?? "idea",
      priority: input.priority ?? 2,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO ideas(id, user_id, title, details, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        idea.id,
        idea.userId,
        idea.title,
        idea.details,
        idea.status,
        idea.priority,
        idea.createdAt,
        idea.updatedAt,
      );
    return idea;
  }

  async update(
    userId: string,
    id: string,
    patch: IdeaPatch,
  ): Promise<IdeaRecord | null> {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.details !== undefined) {
      sets.push("details = ?");
      values.push(patch.details);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.priority !== undefined) {
      sets.push("priority = ?");
      values.push(patch.priority);
    }
    if (sets.length === 0) {
      const row = this.db
        .prepare("SELECT * FROM ideas WHERE id = ? AND user_id = ?")
        .get(id, userId) as Record<string, unknown> | undefined;
      return row ? ideaFromRow(row) : null;
    }
    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    values.push(now);
    const result = this.db
      .prepare(
        `UPDATE ideas SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
      )
      .run(...values, id, userId);
    if (Number(result.changes) === 0) return null;
    const row = this.db
      .prepare("SELECT * FROM ideas WHERE id = ? AND user_id = ?")
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? ideaFromRow(row) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM ideas WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return Number(result.changes) > 0;
  }

  /** Reads every idea belonging to one user, for backup export. */
  listForExportSync(userId: string): IdeaRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM ideas WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(ideaFromRow);
  }

  /**
   * Upserts backup ideas for the importing user. The owner in the file is
   * never trusted: every row is forced to `userId`. An id that already exists
   * (any user) is replaced with a fresh UUID so importing your own backup
   * twice never collides or merges.
   */
  importForUserSync(userId: string, incoming: IdeaRecord[]): number {
    const insert = this.db.prepare(
      `INSERT INTO ideas(id, user_id, title, details, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    for (const idea of incoming.slice(0, 10_000)) {
      const collides = this.db
        .prepare("SELECT 1 FROM ideas WHERE id = ?")
        .get(idea.id);
      const id = collides ? randomUUID() : idea.id;
      insert.run(
        id,
        userId,
        idea.title.slice(0, 120),
        idea.details.slice(0, 4000),
        isIdeaStatus(idea.status) ? idea.status : "idea",
        IDEA_PRIORITIES.includes(idea.priority) ? idea.priority : 2,
        idea.createdAt,
        idea.updatedAt,
      );
      written += 1;
    }
    return written;
  }
}

/** PostgreSQL counterpart; used when `DATABASE_URL` is set. */
export class PostgresIdeaStore implements IdeaStore {
  async list(userId: string): Promise<IdeaRecord[]> {
    const rows = await getDatabase()
      .select()
      .from(ideas)
      .where(eq(ideas.userId, userId))
      .orderBy(desc(ideas.updatedAt));
    return rows.map(pgRowToIdea);
  }

  async create(userId: string, input: NewIdeaInput): Promise<IdeaRecord> {
    const [row] = await getDatabase()
      .insert(ideas)
      .values({
        userId,
        title: input.title,
        details: input.details ?? "",
        status: input.status ?? "idea",
        priority: input.priority ?? 2,
      })
      .returning();
    return pgRowToIdea(row!);
  }

  async update(
    userId: string,
    id: string,
    patch: IdeaPatch,
  ): Promise<IdeaRecord | null> {
    const sets: Partial<typeof ideas.$inferInsert> = {};
    if (patch.title !== undefined) sets.title = patch.title;
    if (patch.details !== undefined) sets.details = patch.details;
    if (patch.status !== undefined) sets.status = patch.status;
    if (patch.priority !== undefined) sets.priority = patch.priority;
    if (Object.keys(sets).length > 0) {
      sets.updatedAt = new Date();
      await getDatabase()
        .update(ideas)
        .set(sets)
        .where(and(eq(ideas.id, id), eq(ideas.userId, userId)));
    }
    const [row] = await getDatabase()
      .select()
      .from(ideas)
      .where(and(eq(ideas.id, id), eq(ideas.userId, userId)))
      .limit(1);
    return row ? pgRowToIdea(row) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = await getDatabase()
      .delete(ideas)
      .where(and(eq(ideas.id, id), eq(ideas.userId, userId)))
      .returning({ id: ideas.id });
    return result.length > 0;
  }
}

function pgRowToIdea(row: typeof ideas.$inferSelect): IdeaRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    details: row.details ?? "",
    status: (IDEA_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as IdeaStatus)
      : "idea",
    priority: IDEA_PRIORITIES.includes(Number(row.priority) as IdeaPriority)
      ? (Number(row.priority) as IdeaPriority)
      : 2,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ideaStoreGlobal = globalThis as typeof globalThis & {
  __valmontIdeaStore?: IdeaStore;
};

/** Picks SQLite or PostgreSQL exactly like `getOrdersStore()`. */
export function getIdeaStore(): IdeaStore {
  if (process.env.DATABASE_URL) return new PostgresIdeaStore();
  return (ideaStoreGlobal.__valmontIdeaStore ??= new SqliteIdeaStore());
}

/** Test-only: inject a store double or reset the singleton. */
export function setIdeaStoreForTests(store: IdeaStore | null): void {
  if (store) ideaStoreGlobal.__valmontIdeaStore = store;
  else delete ideaStoreGlobal.__valmontIdeaStore;
}
