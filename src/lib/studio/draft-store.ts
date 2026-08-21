import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  siteBriefSchemaV1,
  type SiteBriefV1,
  type StudioDraft,
} from "./site-brief/schema";
import { canonicalUserId } from "@/lib/user-identity";
import type { SessionUser } from "@/lib/auth";
import { getDatabase } from "@/db";
import { studioDrafts } from "@/db/schema";
import { and, eq, desc, sql } from "drizzle-orm";
import { getSqliteChatStore, type SqliteChatStore } from "@/lib/chat-store";

export const STUDIO_SCHEMA_VERSION = 1;

/**
 * Sequential Studio schema migrations, indexed by the version being migrated
 * FROM: `STUDIO_MIGRATIONS[v]` upgrades version `v` to `v + 1`. Each entry must
 * run on a database whose schema is exactly version `v` and leave it at `v+1`.
 * The recorded version is written only after the whole chain succeeded, and a
 * failure rolls back both the DDL and the metadata (SQLite DDL is
 * transactional).
 */
export const STUDIO_MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  // 0 -> 1: create the studio tables on the shared chat database. Studio has
  // no database file of its own: it uses exactly the same SQLite file as Chat,
  // resolved once by "@/lib/sqlite-path".
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    `);
  },
];

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

/**
 * Reads the recorded Studio schema version from the dedicated `studio_meta`
 * table. Databases created by earlier Phase 1 builds recorded the version in
 * Chat's `chat_meta` table instead; that marker is honoured as a fallback so
 * an upgrade never re-runs work that already happened. A database with neither
 * table is treated as version 0 (fresh, or pre-Studio).
 */
export function readStudioSchemaVersion(db: DatabaseSync): number {
  if (tableExists(db, "studio_meta")) {
    const row = db
      .prepare("SELECT value FROM studio_meta WHERE key = ?")
      .get("studio-schema-version") as { value: string } | undefined;
    if (row) return Number(row.value);
  }
  if (tableExists(db, "chat_meta")) {
    const legacy = db
      .prepare("SELECT value FROM chat_meta WHERE key = ?")
      .get("studio-schema-version") as { value: string } | undefined;
    if (legacy) return Number(legacy.value);
  }
  return 0;
}

function writeStudioSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO studio_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("studio-schema-version", String(version));
}

/**
 * Brings the shared SQLite connection's Studio schema up to date.
 *
 * - A recorded version newer than this build supports is rejected: refusing to
 *   run against a schema we do not understand beats corrupting it.
 * - Upgrades run sequentially inside one transaction on the shared connection;
 *   the recorded version is updated only after every migration succeeded, and
 *   a failure rolls the schema and the metadata back together.
 * - Idempotent: a version at the current value is a no-op, so repeated
 *   startup is safe.
 */
export function migrateStudioSchema(db: DatabaseSync): void {
  const current = readStudioSchemaVersion(db);
  if (current > STUDIO_SCHEMA_VERSION) {
    throw new Error(
      `The Studio database records schema version ${current}, but this app only supports up to ${STUDIO_SCHEMA_VERSION}. ` +
        "Refusing to open a newer schema; upgrade this app first.",
    );
  }
  if (current === STUDIO_SCHEMA_VERSION) {
    // Databases created by earlier Phase 1 builds recorded the version in
    // Chat's chat_meta table. Bring the marker into the dedicated studio_meta
    // table without re-running any migration.
    if (!tableExists(db, "studio_meta")) {
      getSqliteChatStore().runInTransaction(() => {
        if (tableExists(db, "studio_meta")) return;
        db.exec(
          "CREATE TABLE IF NOT EXISTS studio_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        );
        writeStudioSchemaVersion(db, STUDIO_SCHEMA_VERSION);
      });
    }
    return;
  }

  getSqliteChatStore().runInTransaction(() => {
    // Re-check inside the transaction: another connection may have migrated
    // while this process waited for the write lock.
    const now = readStudioSchemaVersion(db);
    if (now === STUDIO_SCHEMA_VERSION) return;
    if (now > STUDIO_SCHEMA_VERSION) {
      throw new Error(
        `The Studio database records schema version ${now}, but this app only supports up to ${STUDIO_SCHEMA_VERSION}. ` +
          "Refusing to open a newer schema; upgrade this app first.",
      );
    }
    for (let version = now; version < STUDIO_SCHEMA_VERSION; version += 1) {
      STUDIO_MIGRATIONS[version]!(db);
    }
    writeStudioSchemaVersion(db, STUDIO_SCHEMA_VERSION);
  });
}

/** Creates the Studio tables on the shared chat database. */
export function ensureStudioSchema(db: DatabaseSync): void {
  migrateStudioSchema(db);
}

/**
 * Raised when a write loses an optimistic-concurrency race. Callers map this to
 * HTTP 409 by type, never by matching the message text.
 */
export class DraftConflictError extends Error {
  readonly status = 409;
  constructor(
    message = "This draft was changed somewhere else. Reload to see the latest version.",
  ) {
    super(message);
    this.name = "DraftConflictError";
  }
}

/**
 * Raised for a draft that does not exist *or* belongs to somebody else. Both
 * cases deliberately produce the identical error so a signed-in user cannot
 * probe for the existence of another owner's drafts.
 */
export class DraftNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Draft not found") {
    super(message);
    this.name = "DraftNotFoundError";
  }
}

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

function nowIso(): string {
  return new Date().toISOString();
}

interface StudioDraftRow {
  id: string;
  owner_id: string;
  schema_version: number;
  template_version: number;
  theme_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  brief_json: string;
}

/**
 * Returns the single shared SQLite connection, guaranteeing the studio tables
 * exist on it. Reusing Chat's handle is what lets a complete-backup import put
 * chat, memories and studio drafts inside one transaction.
 */
export function getStudioSqliteStore(): SqliteChatStore {
  const store = getSqliteChatStore();
  ensureStudioSchema(store.connection);
  return store;
}

export function getStudioSqliteDb(): DatabaseSync {
  return getStudioSqliteStore().connection;
}

export class SqliteStudioDraftStore implements StudioDraftStore {
  private get db(): DatabaseSync {
    return getStudioSqliteDb();
  }

  async create(
    user: SessionUser,
    brief: Partial<SiteBriefV1>,
  ): Promise<StudioDraft> {
    const validated = validatedBrief(brief);
    const draft = newDraftRecord(canonicalUserId(user), validated);
    insertDraftRow(this.db, draft);
    return draft;
  }

  async get(user: SessionUser, id: string): Promise<StudioDraft | null> {
    const row = this.db
      .prepare("SELECT * FROM studio_drafts WHERE id = ? AND owner_id = ?")
      .get(id, canonicalUserId(user)) as unknown as StudioDraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  async list(user: SessionUser): Promise<StudioDraft[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_drafts WHERE owner_id = ? ORDER BY updated_at DESC",
      )
      .all(canonicalUserId(user)) as unknown as StudioDraftRow[];
    return rows.map(rowToDraft);
  }

  async update(
    user: SessionUser,
    id: string,
    brief: Partial<SiteBriefV1>,
    expectedRevision: number,
  ): Promise<StudioDraft> {
    const validated = validatedBrief(brief);
    const ownerId = canonicalUserId(user);

    // One atomic conditional update. The revision guard is part of the WHERE
    // clause, so two writers holding the same revision can never both succeed —
    // whoever runs second updates zero rows.
    const updated = this.db
      .prepare(
        `UPDATE studio_drafts
            SET brief_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND owner_id = ? AND revision = ?
      RETURNING *`,
      )
      .all(
        JSON.stringify(validated),
        nowIso(),
        id,
        ownerId,
        expectedRevision,
      ) as unknown as StudioDraftRow[];

    if (updated.length === 1) return rowToDraft(updated[0]!);
    if (updated.length > 1) {
      // Impossible with a primary-key match, but never return success blindly.
      throw new Error("Draft update matched more than one row");
    }

    // Zero rows: either the draft is gone/foreign (404) or the revision is
    // stale (409). Distinguish with an owner-scoped existence check only.
    const exists = this.db
      .prepare("SELECT 1 FROM studio_drafts WHERE id = ? AND owner_id = ?")
      .get(id, ownerId);
    if (!exists) throw new DraftNotFoundError();
    throw new DraftConflictError();
  }

  async delete(user: SessionUser, id: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM studio_drafts WHERE id = ? AND owner_id = ?")
      .run(id, canonicalUserId(user));
    return Number(result.changes) > 0;
  }
}

export class PostgresStudioDraftStore implements StudioDraftStore {
  async create(
    user: SessionUser,
    brief: Partial<SiteBriefV1>,
  ): Promise<StudioDraft> {
    const validated = validatedBrief(brief);
    const { ensureStudioUser } = await import("@/lib/user-identity");
    const ownerId = await ensureStudioUser(user);
    const id = randomUUID();
    const timestamp = new Date();
    await getDatabase().insert(studioDrafts).values({
      id,
      ownerId,
      schemaVersion: STUDIO_SCHEMA_VERSION,
      templateVersion: 1,
      themeVersion: 1,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      brief: validated,
    });
    return {
      id,
      ownerId,
      schemaVersion: STUDIO_SCHEMA_VERSION,
      templateRegistryVersion: 1,
      themeRegistryVersion: 1,
      revision: 1,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      brief: validated,
    };
  }

  async get(user: SessionUser, id: string): Promise<StudioDraft | null> {
    const ownerId = canonicalUserId(user);
    const [row] = await getDatabase()
      .select()
      .from(studioDrafts)
      .where(and(eq(studioDrafts.id, id), eq(studioDrafts.ownerId, ownerId)))
      .limit(1);
    return row ? pgRowToDraft(row) : null;
  }

  /**
   * Unlike every other method here, this deliberately does not call
   * `ensureStudioUser`. The upsert exists to satisfy the
   * `studio_drafts.owner_id -> users.id` foreign key before a write; a SELECT
   * has no such constraint, and someone who has never created a draft should
   * not have a row written into `users` merely for opening the Studio page.
   * A missing user row simply yields no drafts, which is the correct answer.
   *
   * Do not copy this omission into anything that inserts or updates.
   */
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
    const validated = validatedBrief(brief);
    const ownerId = canonicalUserId(user);
    const db = getDatabase();

    // Single atomic statement; PostgreSQL takes the row lock, so exactly one of
    // two simultaneous same-revision writers gets a row back.
    const updated = await db
      .update(studioDrafts)
      .set({
        brief: validated,
        revision: sql`${studioDrafts.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDrafts.id, id),
          eq(studioDrafts.ownerId, ownerId),
          eq(studioDrafts.revision, expectedRevision),
        ),
      )
      .returning();

    if (updated.length === 1) return pgRowToDraft(updated[0]!);
    if (updated.length > 1) {
      throw new Error("Draft update matched more than one row");
    }

    const [exists] = await db
      .select({ id: studioDrafts.id })
      .from(studioDrafts)
      .where(and(eq(studioDrafts.id, id), eq(studioDrafts.ownerId, ownerId)))
      .limit(1);
    if (!exists) throw new DraftNotFoundError();
    throw new DraftConflictError();
  }

  async delete(user: SessionUser, id: string): Promise<boolean> {
    const ownerId = canonicalUserId(user);
    const deleted = await getDatabase()
      .delete(studioDrafts)
      .where(and(eq(studioDrafts.id, id), eq(studioDrafts.ownerId, ownerId)))
      .returning({ id: studioDrafts.id });
    return deleted.length > 0;
  }
}

export function newDraftRecord(
  ownerId: string,
  brief: SiteBriefV1,
  overrides: Partial<Pick<StudioDraft, "id" | "createdAt" | "updatedAt">> = {},
): StudioDraft {
  const timestamp = nowIso();
  return {
    id: overrides.id ?? randomUUID(),
    ownerId,
    schemaVersion: STUDIO_SCHEMA_VERSION,
    templateRegistryVersion: 1,
    themeRegistryVersion: 1,
    revision: 1,
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
    brief,
  };
}

/** Low-level insert used by create() and by complete-backup import. */
export function insertDraftRow(db: DatabaseSync, draft: StudioDraft): void {
  db.prepare(
    "INSERT INTO studio_drafts(id,owner_id,schema_version,template_version,theme_version,revision,created_at,updated_at,brief_json) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    draft.id,
    draft.ownerId,
    draft.schemaVersion,
    draft.templateRegistryVersion,
    draft.themeRegistryVersion,
    draft.revision,
    draft.createdAt,
    draft.updatedAt,
    JSON.stringify(draft.brief),
  );
}

export function draftIdExists(db: DatabaseSync, id: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM studio_drafts WHERE id = ?").get(id),
  );
}

/**
 * Brings a stored brief up to the current shape so no read path has to defend
 * against fields added in a later phase.
 *
 * - Phase 2 added `assets`; a pre-Phase-2 draft gets an empty assets object.
 * - Phase 3 added `items` (a priced catalogue) and `payments`. A pre-Phase-3
 *   draft has neither, so the name-only `products` list is carried forward into
 *   `items` (each becomes an unpriced item) and the payments block is filled
 *   with safe, disabled defaults. This means list/get/update/create,
 *   backup import and the public reader all return the same complete shape.
 */
export function normalizeBrief(brief: SiteBriefV1): SiteBriefV1 {
  const next: SiteBriefV1 = { ...brief };

  if (!next.assets) {
    next.assets = { logo: null, photos: [] };
  } else if (!next.assets.photos) {
    next.assets = { logo: next.assets.logo ?? null, photos: [] };
  }

  if (!Array.isArray(next.items)) {
    next.items = [];
  }
  // Carry legacy name-only products into the priced catalogue once, so a draft
  // created before Phase 3 shows its products in the shop even before the owner
  // adds prices. Only done when items is still empty to avoid duplication.
  if (
    next.items.length === 0 &&
    Array.isArray(next.products) &&
    next.products.length > 0
  ) {
    next.items = next.products.map((product, index) => ({
      id: `legacy-${index}`,
      name: product.name,
      category: product.category,
    }));
  }

  if (!next.payments) {
    next.payments = {
      enabled: false,
      methods: [],
      valmontPay: { provisioned: false },
      delivery: { enabled: false, fee: 0, minimumOrder: 0 },
      notifications: {},
      staged: { enabled: false, stages: [] },
    };
  }

  return next;
}

function rowToDraft(row: StudioDraftRow): StudioDraft {
  return {
    id: row.id,
    ownerId: row.owner_id,
    schemaVersion: row.schema_version,
    templateRegistryVersion: row.template_version,
    themeRegistryVersion: row.theme_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    brief: normalizeBrief(JSON.parse(row.brief_json) as SiteBriefV1),
  };
}

function pgRowToDraft(row: typeof studioDrafts.$inferSelect): StudioDraft {
  return {
    id: row.id,
    ownerId: row.ownerId,
    schemaVersion: row.schemaVersion,
    templateRegistryVersion: row.templateVersion,
    themeRegistryVersion: row.themeVersion,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    brief: normalizeBrief(row.brief as SiteBriefV1),
  };
}

export function getStudioDraftStore(): StudioDraftStore {
  if (process.env.DATABASE_URL) {
    void import("./import-coordinator").then((mod) => {
      mod.scheduleStartupImportRecovery();
    });
    return new PostgresStudioDraftStore();
  }
  return new SqliteStudioDraftStore();
}
