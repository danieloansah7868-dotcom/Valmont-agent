import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "@/lib/auth";
import { getSqliteChatStore, type ChatMemory } from "@/lib/chat-store";
import type { ChatSession } from "@/lib/types";
import { canonicalUserId } from "@/lib/user-identity";
import { siteBriefSchemaV1, type StudioDraft } from "./site-brief/schema";
import type { ImportJobRecord, ImportLockLease } from "./import-coordinator";
import {
  acquireNewImportLock,
  beginImportJob,
  getImportJob,
  ImportInProgressError,
  ImportLostLeaseError,
  markChatCommitted,
  markCompleted,
  markFailed,
  markStudioCommitted,
  recoverPendingImports,
  refuseIfOwnerImportActive,
  releaseImportLock,
  renewImportLease,
  restoreJob,
  startImportLeaseHeartbeat,
  stopImportLeaseHeartbeat,
} from "./import-coordinator";
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

export async function buildBackup(
  user: SessionUser,
  options: { afterChatReadForTests?: () => void } = {},
): Promise<BackupV2> {
  if (process.env.DATABASE_URL) {
    const chat = await getSqliteChatStore().exportUser(user.id);
    const drafts = await new PostgresStudioDraftStore().list(user);
    return assembleBackup(chat, drafts);
  }

  // Chat and drafts are read back to back from the one shared connection
  // inside a single read transaction. The snapshot is fixed at the first read,
  // so a writer committing on another connection between the chat read and the
  // draft read cannot leak a later state into the export: the file is either
  // entirely "before" or entirely "after", never a mixture of the two.
  const store = getStudioSqliteStore();
  const ownerId = canonicalUserId(user);
  let chat: {
    version: number;
    sessions: ChatSession[];
    memories: ChatMemory[];
    memoryEnabled: boolean;
  };
  let drafts: StudioDraft[] = [];
  store.runInReadTransaction(() => {
    chat = store.exportUserSync(user.id);
    // Test hook: proves the export cannot combine records from different
    // points in time by letting another connection commit mid-export.
    options.afterChatReadForTests?.();
    const rows = store.connection
      .prepare(
        "SELECT * FROM studio_drafts WHERE owner_id = ? ORDER BY updated_at DESC",
      )
      .all(ownerId) as unknown as Array<Record<string, string | number>>;
    drafts = rows.map((row) => ({
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
  });
  return assembleBackup(chat!, drafts);
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
   * How the import was made atomic across stores.
   *
   * - `"single-transaction"` (SQLite): chat, memories and drafts share one
   *   connection and one transaction. A failure rolls back everything.
   * - `"coordinated"` (PostgreSQL): chat lives in SQLite and studio in
   *   PostgreSQL, so there is no distributed transaction. The durable
   *   cross-store coordinator in `import-coordinator.ts` records a staged
   *   payload and a pre-import snapshot of both stores before any write, then
   *   advances through durable checkpoints. Any failure — or an interrupted
   *   import after a restart — rolls both stores back to their exact previous
   *   state; success is reported only after both halves committed.
   */
  atomicity: "single-transaction" | "coordinated";
}

/**
 * Raised when an import failed AND rolling it back also failed. This is the
 * catastrophic, exceptional case: the normal outcome of a partly-committed
 * import is a successful rollback plus `ImportFailedError`. Only when the
 * rollback itself cannot complete (for example PostgreSQL is unreachable) does
 * this error escape, naming exactly which half is known to have committed so
 * the owner is told what may have landed.
 */
export class PartialImportError extends Error {
  readonly status = 500;
  readonly committed: { chat: boolean; studio: boolean };
  constructor(cause: unknown, committed: { chat: boolean; studio: boolean }) {
    super(
      "The import failed and, separately, rolling it back also failed, so your data may be " +
        "partly imported. The recovery record is on disk and will be rolled back by the next " +
        "import attempt once the database is reachable again. Re-importing the same file now " +
        "could create duplicate copies, so wait for recovery to finish first.",
    );
    this.name = "PartialImportError";
    this.committed = committed;
    this.cause = cause;
  }
}

/**
 * Raised when an import failed at any checkpoint but every write that had
 * already happened was rolled back. Both stores are back to their exact
 * previous state, so this is a plain failure — never a partial success.
 */
export class ImportFailedError extends Error {
  readonly status = 500;
  constructor(cause: unknown) {
    super(
      "The import did not complete and everything it had written was rolled back. " +
        "Your chats, memories and website drafts are unchanged. Try the import again.",
    );
    this.name = "ImportFailedError";
    this.cause = cause;
  }
}

/**
 * The durable checkpoints of a coordinated (mixed SQLite/PostgreSQL) import.
 * Tests inject a failure at each one and prove both stores are rolled back.
 */
export type ImportCheckpoint =
  | "job-created"
  | "chat-imported"
  | "chat-committed"
  | "studio-imported"
  | "studio-committed"
  | "completed";

export interface ImportOptions {
  /** SQLite path only: throws inside the single import transaction. */
  failAfterInsertForTests?: () => void;
  /**
   * Mixed path only: called at each durable checkpoint. Throwing here
   * simulates a failure at that exact stage of the import.
   */
  onCheckpoint?: (checkpoint: ImportCheckpoint) => void | Promise<void>;
  /**
   * Called after the owner lock (and, on the mixed path, the job row) is
   * durably acquired and before either store is written. Tests use this as
   * an explicit latch instead of sleeping.
   */
  onLockAcquired?: () => void | Promise<void>;
}

/**
 * Writes a validated backup for the authenticated user.
 *
 * **SQLite** (default): chat, memories and studio drafts share one connection,
 * so the whole import is a single transaction. A failure anywhere rolls back
 * everything.
 *
 * **PostgreSQL** (`DATABASE_URL` set): chat history still lives in SQLite while
 * studio drafts live in PostgreSQL. Two engines cannot share a transaction, so
 * the durable cross-store coordinator records the staged payload and a
 * pre-import snapshot of both stores before any write, then advances through
 * durable checkpoints. Any failure at any checkpoint — or an interruption that
 * kills the process mid-import — rolls both stores back to their exact previous
 * state, either immediately or on the next import attempt after a restart.
 * Success is reported only after both halves have committed.
 *
 * Owner ids inside the file are never trusted. Chat rows are reassigned by the
 * chat store, studio rows by this function.
 */
export async function importBackup(
  user: SessionUser,
  backup: NormalizedBackup,
  options: ImportOptions = {},
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
    atomicity: process.env.DATABASE_URL ? "coordinated" : "single-transaction",
  };

  if (process.env.DATABASE_URL) {
    await importIntoPostgres(user, backup, summary, options);
    return summary;
  }

  await importIntoSqlite(user, backup, summary, options);
  return summary;
}

async function importIntoSqlite(
  user: SessionUser,
  backup: NormalizedBackup,
  summary: ImportSummary,
  options: ImportOptions,
): Promise<void> {
  const store = getStudioSqliteStore();
  const ownerId = canonicalUserId(user);
  const db = store.connection;

  refuseIfOwnerImportActive(ownerId);
  await recoverPendingImports(ownerId);
  refuseIfOwnerImportActive(ownerId);

  const jobId = randomUUID();
  const lease = acquireNewImportLock(ownerId, jobId);
  startImportLeaseHeartbeat(lease);
  try {
    await options.onLockAcquired?.();
    renewImportLease(lease);
    // One transaction covering both halves, on the one shared connection. The
    // synchronous import core is required here: an awaited call would let the
    // transaction commit before the studio rows are written.
    store.runInTransaction(() => {
      renewImportLease(lease);
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
    releaseImportLock(lease);
  } catch (cause) {
    if (cause instanceof ImportInProgressError) throw cause;
    try {
      releaseImportLock(lease);
    } catch {
      // Lost the lease; do not touch the replacement lock.
    }
    throw cause;
  } finally {
    stopImportLeaseHeartbeat(lease);
  }
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
  options: ImportOptions,
): Promise<void> {
  const { getDatabase } = await import("@/db");
  const { studioDrafts } = await import("@/db/schema");
  const { ensureStudioUser } = await import("@/lib/user-identity");
  const { eq } = await import("drizzle-orm");

  const ownerId = await ensureStudioUser(user);
  // Live leases 409 before recovery. Expired leases are claimed atomically
  // and rolled back before a new import can start.
  refuseIfOwnerImportActive(ownerId);
  await recoverPendingImports(ownerId);

  const started = await beginImportJob(user, ownerId, backup, "mixed");
  const { jobId, lease } = started;

  try {
    await options.onLockAcquired?.();
    renewImportLease(lease);
    await options.onCheckpoint?.("job-created");
    renewImportLease(lease);
    // Chat half: chat history and memories live in SQLite even when studio
    // uses PostgreSQL. The transaction is owned here so a checkpoint failure
    // can prove the chat transaction itself rolls back.
    const store = getSqliteChatStore();
    const chatCounts = store.runInTransaction(() => {
      renewImportLease(lease);
      const counts = store.importUserSync(user.id, {
        sessions: backup.chat.sessions as ChatSession[],
        memories: backup.chat.memories as ChatMemory[],
        memoryEnabled: backup.chat.memoryEnabled,
      });
      // Must stay synchronous: an await would commit the SQLite transaction
      // before this function returns.
      const maybe = options.onCheckpoint?.("chat-imported");
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        throw new Error(
          "onCheckpoint('chat-imported') must be synchronous because it runs inside a SQLite transaction.",
        );
      }
      return counts;
    });
    summary.chatSessions = chatCounts.chatSessions;
    summary.memories = chatCounts.memories;
    summary.skippedMemories = chatCounts.skippedMemories;
    markChatCommitted(jobId, lease);
    await options.onCheckpoint?.("chat-committed");

    // Studio half: drafts live in PostgreSQL; one transaction, then the
    // durable checkpoint.
    await runStudioImportTransaction(lease);
    await options.onCheckpoint?.("studio-committed");
    await options.onCheckpoint?.("completed");
    markCompleted(
      jobId,
      {
        chatSessions: summary.chatSessions,
        memories: summary.memories,
        studioDrafts: summary.studioDrafts,
      },
      lease,
    );
  } catch (cause) {
    if (cause instanceof ImportInProgressError) throw cause;
    if (cause instanceof ImportLostLeaseError) {
      // Another worker claimed the expired lease. Do not restore, sanitize
      // or release — that worker owns the lock now.
      throw new ImportFailedError(cause);
    }
    // The job's status before the rollback decides which halves were already
    // committed — capture it first, because restoreJob moves the status to
    // "restoring" as soon as it starts.
    const committedBeforeRollback = coordinatorJob(jobId).status;
    try {
      await restoreJob(coordinatorJob(jobId), lease);
    } catch (restoreCause) {
      if (restoreCause instanceof ImportFailedError) throw restoreCause;
      if (restoreCause instanceof ImportLostLeaseError) {
        throw new ImportFailedError(restoreCause);
      }
      markFailed(jobId, restoreCause, lease);
      throw new PartialImportError(restoreCause, {
        chat: committedBeforeRollback !== "prepared",
        studio: committedBeforeRollback === "studio-committed",
      });
    }
    throw new ImportFailedError(cause);
  } finally {
    stopImportLeaseHeartbeat(lease);
  }

  function coordinatorJob(jobId: string): ImportJobRecord {
    const job = getImportJob(jobId);
    if (!job) {
      throw new Error(
        `Import coordinator lost its job record ${jobId}; recovery cannot roll the import back.`,
      );
    }
    return job;
  }

  async function runStudioImportTransaction(
    held: ImportLockLease,
  ): Promise<void> {
    renewImportLease(held);
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
      // A throw here rolls the PostgreSQL transaction back; the coordinator
      // still restores the already-committed chat half.
      options.onCheckpoint?.("studio-imported");
    });
    // Only credited once the transaction above has committed.
    summary.studioDrafts = insertedDrafts;
    markStudioCommitted(jobId, held);
  }
}
