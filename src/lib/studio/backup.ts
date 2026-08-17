import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "@/lib/auth";
import { getSqliteChatStore, type ChatMemory } from "@/lib/chat-store";
import type { ChatSession } from "@/lib/types";
import { canonicalUserId } from "@/lib/user-identity";
import { siteBriefSchemaV1, type StudioDraft } from "./site-brief/schema";
import {
  draftIdExists,
  ensureStudioSchema,
  getStudioSqliteStore,
  insertDraftRow,
  PostgresStudioDraftStore,
  STUDIO_SCHEMA_VERSION,
} from "./draft-store";

export const BACKUP_VERSION = 2 as const;
export const CHAT_SECTION_VERSION = 1 as const;
export const STUDIO_SECTION_VERSION = 1 as const;

/** Raised for input the import route must refuse *before* writing anything. */
export class BackupValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

const isoTimestamp = z.string().datetime();

const chatMessageSchema = z.object({
  id: z.string().max(200),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
  createdAt: isoTimestamp,
  model: z.string().max(200).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

const chatSessionSchema = z.object({
  id: z.string().max(200),
  // Present in the file but deliberately ignored: the importing user always
  // becomes the owner. Kept in the schema so old files still validate.
  userId: z.string().max(200).optional(),
  title: z.string().max(120),
  repository: z
    .object({
      id: z.string().max(120),
      owner: z.string().max(120),
      name: z.string().max(120),
      fullName: z.string().max(250),
      baseBranch: z.string().max(200),
    })
    .optional(),
  messages: z.array(chatMessageSchema).max(100_000),
  archivedAt: isoTimestamp.optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

const chatMemorySchema = z.object({
  id: z.string().max(200),
  scope: z.enum(["personal", "repository"]),
  repositoryId: z.string().max(120).optional(),
  category: z.enum(["preference", "fact", "decision", "project"]),
  content: z.string().max(1000),
  sourceSessionId: z.string().max(200).optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

/** The chat half of a backup. Identical in shape to the v1 memories export. */
export const chatSectionSchema = z.object({
  version: z.literal(1),
  sessions: z.array(chatSessionSchema).max(10_000),
  memories: z.array(chatMemorySchema).max(100_000),
  memoryEnabled: z.boolean().optional(),
});

/**
 * Draft ids must be UUIDs. The PostgreSQL column is `uuid`, so a hand-edited
 * file containing `"id": "d1"` would otherwise reach the driver and fail
 * mid-import, leaking the driver's message through the 400. Rejecting the id
 * during validation keeps every malformed file a clean pre-write refusal.
 *
 * The rule matches the 8-4-4-4-12 hex form this codebase produces — every id
 * comes from `randomUUID()` — rather than Zod's `.uuid()`, which additionally
 * demands RFC-4122 version and variant bits and would reject ids the database
 * itself stores happily, including ones written by earlier versions.
 *
 * It is not full parity with PostgreSQL's `uuid_in`, which also accepts the
 * braced form, the 32-hex-digit form with no dashes, and mixed dash placement.
 * Refusing those is deliberate: no legitimate round-tripped id is written that
 * way, so the only thing narrower parsing rejects is a hand-crafted file.
 */
const draftId = z
  .string()
  .regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "must be a UUID");

const studioDraftSchema = z.object({
  id: draftId,
  // Ignored on import — reassigned to the authenticated user.
  ownerId: z.string().max(200).optional(),
  schemaVersion: z.number().int().min(1).max(STUDIO_SCHEMA_VERSION),
  templateRegistryVersion: z.number().int().min(1).optional(),
  themeRegistryVersion: z.number().int().min(1).optional(),
  revision: z.number().int().min(1).optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  brief: siteBriefSchemaV1,
});

export const studioSectionSchema = z.object({
  version: z.literal(1),
  schemaVersion: z.literal(1),
  drafts: z.array(studioDraftSchema).max(5_000),
});

/** A complete backup: chat, memories and website drafts together. */
export const backupV2Schema = z.object({
  backupVersion: z.literal(2),
  exportedAt: isoTimestamp,
  chat: chatSectionSchema,
  studio: studioSectionSchema,
});

/** The older chat-only file produced by /api/memories/export. */
export const backupV1Schema = chatSectionSchema;

export type BackupV2 = z.infer<typeof backupV2Schema>;
export type StudioSection = z.infer<typeof studioSectionSchema>;

export interface NormalizedBackup {
  chat: z.infer<typeof chatSectionSchema>;
  studio: StudioSection;
  sourceVersion: 1 | 2;
}

/**
 * Checks the version *first*, then validates the whole file. Nothing is written
 * until this function has returned successfully, so a bad file can never leave
 * a half-finished import behind.
 */
export function parseBackup(input: unknown): NormalizedBackup {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BackupValidationError("Backup file is not valid JSON data.");
  }
  const record = input as Record<string, unknown>;
  const declared = record.backupVersion ?? record.version;

  if (declared === 2) {
    const parsed = backupV2Schema.safeParse(record);
    if (!parsed.success) throw validationFailure(parsed.error);
    return {
      chat: parsed.data.chat,
      studio: parsed.data.studio,
      sourceVersion: 2,
    };
  }

  if (declared === 1) {
    const parsed = backupV1Schema.safeParse(record);
    if (!parsed.success) throw validationFailure(parsed.error);
    return {
      chat: parsed.data,
      studio: { version: 1, schemaVersion: 1, drafts: [] },
      sourceVersion: 1,
    };
  }

  throw new BackupValidationError(
    "Unsupported backup version. This app can import version 1 (chat only) and version 2 (complete) backups.",
  );
}

/**
 * Reports *where* a file is wrong without ever echoing the value found there.
 * Field paths are safe to show; the user's own business details are not.
 */
function validationFailure(error: z.ZodError): BackupValidationError {
  const fields = Array.from(
    new Set(
      error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join(".") || "(top level)"),
    ),
  );
  return new BackupValidationError(
    `Backup file is not valid. Check these fields: ${fields.join(", ")}.`,
  );
}

export async function buildBackup(user: SessionUser): Promise<BackupV2> {
  if (process.env.DATABASE_URL) {
    const chat = await getSqliteChatStore().exportUser(user.id);
    const drafts = await new PostgresStudioDraftStore().list(user);
    return assembleBackup(chat, drafts);
  }

  // Chat and drafts are read back to back from the one shared connection.
  // Note this is NOT wrapped in an explicit transaction: an export is a
  // read-only snapshot for one user, and Phase 1 has no concurrent writer that
  // could interleave with it. Do not describe it as transactionally consistent.
  const store = getStudioSqliteStore();
  const chat = await store.exportUser(user.id);
  const ownerId = canonicalUserId(user);
  const rows = store.connection
    .prepare(
      "SELECT * FROM studio_drafts WHERE owner_id = ? ORDER BY updated_at DESC",
    )
    .all(ownerId) as unknown as Array<Record<string, string | number>>;
  const drafts: StudioDraft[] = rows.map((row) => ({
    id: String(row.id),
    ownerId: String(row.owner_id),
    schemaVersion: Number(row.schema_version),
    templateRegistryVersion: Number(row.template_version),
    themeRegistryVersion: Number(row.theme_version),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    brief: JSON.parse(String(row.brief_json)),
  }));
  return assembleBackup(chat, drafts);
}

function assembleBackup(
  chat: {
    version: number;
    sessions: ChatSession[];
    memories: ChatMemory[];
    memoryEnabled: boolean;
  },
  drafts: StudioDraft[],
): BackupV2 {
  return {
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    chat: {
      version: CHAT_SECTION_VERSION,
      sessions: chat.sessions,
      memories: chat.memories,
      memoryEnabled: chat.memoryEnabled,
    },
    studio: {
      version: STUDIO_SECTION_VERSION,
      schemaVersion: 1,
      drafts,
    },
  };
}

export interface ImportSummary {
  sourceVersion: 1 | 2;
  /** Chat sessions actually written, not the number the file contained. */
  chatSessions: number;
  /** Memories actually written. Excludes any counted in `skippedMemories`. */
  memories: number;
  /**
   * Memories present in the file but deliberately not imported because their
   * text matched a secret-redaction pattern. Reported so the owner is told the
   * record was dropped rather than silently losing it.
   */
  skippedMemories: number;
  studioDrafts: number;
  /** Drafts whose id already existed and were given a fresh id. */
  remappedDraftIds: number;
  /**
   * How the two halves were committed.
   *
   * - `"single-transaction"` (SQLite): chat, memories and drafts share one
   *   connection and one transaction. A failure rolls back everything.
   * - `"staged"` (PostgreSQL): chat lives in SQLite and studio in PostgreSQL,
   *   so there is no distributed transaction. Each half is individually atomic
   *   and they are committed in order.
   */
  atomicity: "single-transaction" | "staged";
}

/**
 * Raised when the chat half of a staged (PostgreSQL) import committed but the
 * studio half did not. The message tells the user exactly what landed, because
 * "import failed" would be untrue and would invite a destructive retry.
 */
export class PartialImportError extends Error {
  readonly status = 500;
  readonly committed: { chat: boolean; studio: boolean };
  constructor(cause: unknown) {
    super(
      "Your chats and memories were imported, but the website drafts could not be saved. " +
        "Nothing was lost from the backup file. Re-importing the same file will restore the " +
        "drafts and will create a second copy of the chats.",
    );
    this.name = "PartialImportError";
    this.committed = { chat: true, studio: false };
    this.cause = cause;
  }
}

/**
 * Writes a validated backup for the authenticated user.
 *
 * **SQLite** (default): chat, memories and studio drafts share one connection,
 * so the whole import is a single transaction. A failure anywhere rolls back
 * everything.
 *
 * **PostgreSQL** (`DATABASE_URL` set): chat history still lives in SQLite while
 * studio drafts live in PostgreSQL. Two engines cannot share a transaction and
 * this codebase deliberately does not add a distributed-transaction layer in
 * Phase 1. The import is therefore *staged*: each half is individually atomic,
 * chat commits first, and if the studio half then fails the caller receives a
 * `PartialImportError` naming exactly what was written. It is never reported as
 * a clean failure.
 *
 * Owner ids inside the file are never trusted. Chat rows are reassigned by the
 * chat store, studio rows by this function.
 */
export async function importBackup(
  user: SessionUser,
  backup: NormalizedBackup,
  options: { failAfterInsertForTests?: () => void } = {},
): Promise<ImportSummary> {
  // Counts start empty and are filled in from what each store reports it wrote.
  // Trusting the file's own lengths is what previously let a dropped memory be
  // reported as restored.
  const summary: ImportSummary = {
    sourceVersion: backup.sourceVersion,
    chatSessions: 0,
    memories: 0,
    skippedMemories: 0,
    studioDrafts: 0,
    remappedDraftIds: 0,
    atomicity: process.env.DATABASE_URL ? "staged" : "single-transaction",
  };

  if (process.env.DATABASE_URL) {
    await importIntoPostgres(user, backup, summary, options);
    return summary;
  }

  const store = getStudioSqliteStore();
  const ownerId = canonicalUserId(user);
  const db = store.connection;

  // One transaction covering both halves, on the one shared connection. The
  // synchronous import core is required here: an awaited call would let the
  // transaction commit before the studio rows are written.
  store.runInTransaction(() => {
    const counts = store.importUserSync(user.id, {
      sessions: backup.chat.sessions as ChatSession[],
      memories: backup.chat.memories as ChatMemory[],
      memoryEnabled: backup.chat.memoryEnabled,
    });
    summary.chatSessions = counts.chatSessions;
    summary.memories = counts.memories;
    summary.skippedMemories = counts.skippedMemories;
    importStudioDrafts(db, ownerId, backup.studio, summary);
    // Test hook: proves a failure after inserts rolls the whole import back.
    options.failAfterInsertForTests?.();
  });

  return summary;
}

/**
 * Inserts studio drafts under the authenticated owner. An id that is already
 * taken gets a fresh one, so importing your own backup twice never overwrites
 * or merges the existing copy.
 */
export function importStudioDrafts(
  db: DatabaseSync,
  ownerId: string,
  studio: StudioSection,
  summary: ImportSummary,
): void {
  ensureStudioSchema(db);
  for (const incoming of studio.drafts) {
    const collides = draftIdExists(db, incoming.id);
    if (collides) summary.remappedDraftIds += 1;
    insertDraftRow(db, {
      id: collides ? randomUUID() : incoming.id,
      // The owner in the file is ignored on purpose.
      ownerId,
      schemaVersion: incoming.schemaVersion,
      templateRegistryVersion: incoming.templateRegistryVersion ?? 1,
      themeRegistryVersion: incoming.themeRegistryVersion ?? 1,
      revision: incoming.revision ?? 1,
      createdAt: incoming.createdAt,
      updatedAt: incoming.updatedAt,
      brief: incoming.brief,
    });
    summary.studioDrafts += 1;
  }
}

async function importIntoPostgres(
  user: SessionUser,
  backup: NormalizedBackup,
  summary: ImportSummary,
  options: { failAfterInsertForTests?: () => void },
): Promise<void> {
  const { getDatabase } = await import("@/db");
  const { studioDrafts } = await import("@/db/schema");
  const { ensureStudioUser } = await import("@/lib/user-identity");
  const { eq } = await import("drizzle-orm");
  const ownerId = await ensureStudioUser(user);

  // Chat history still lives in SQLite even when studio uses PostgreSQL, so it
  // keeps its own transaction; the studio half below is fully transactional.
  const chatCounts = await getSqliteChatStore().importUser(user.id, {
    sessions: backup.chat.sessions as ChatSession[],
    memories: backup.chat.memories as ChatMemory[],
    memoryEnabled: backup.chat.memoryEnabled,
  });
  summary.chatSessions = chatCounts.chatSessions;
  summary.memories = chatCounts.memories;
  summary.skippedMemories = chatCounts.skippedMemories;

  // From here the chat half is committed and cannot be rolled back by the
  // PostgreSQL transaction below. Any failure is surfaced as a PartialImport-
  // Error so the user is told precisely which half landed.
  try {
    await runStudioImportTransaction();
  } catch (cause) {
    throw new PartialImportError(cause);
  }

  async function runStudioImportTransaction(): Promise<void> {
    let insertedDrafts = 0;
    await getDatabase().transaction(async (tx) => {
      for (const incoming of backup.studio.drafts) {
        const [existing] = await tx
          .select({ id: studioDrafts.id })
          .from(studioDrafts)
          .where(eq(studioDrafts.id, incoming.id))
          .limit(1);
        if (existing) summary.remappedDraftIds += 1;
        await tx.insert(studioDrafts).values({
          id: existing ? randomUUID() : incoming.id,
          ownerId,
          schemaVersion: incoming.schemaVersion,
          templateVersion: incoming.templateRegistryVersion ?? 1,
          themeVersion: incoming.themeRegistryVersion ?? 1,
          revision: incoming.revision ?? 1,
          createdAt: new Date(incoming.createdAt),
          updatedAt: new Date(incoming.updatedAt),
          brief: incoming.brief,
        });
        insertedDrafts += 1;
      }
      options.failAfterInsertForTests?.();
    });
    // Only credited once the transaction above has committed.
    summary.studioDrafts = insertedDrafts;
  }
}
