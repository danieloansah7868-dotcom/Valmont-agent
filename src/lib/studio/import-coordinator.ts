import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "@/lib/auth";
import type { ChatMemory } from "@/lib/chat-store";
import { getSqliteChatStore } from "@/lib/chat-store";
import type { ChatSession } from "@/lib/types";
import { type SiteBriefV1 } from "./site-brief/schema";
import type { NormalizedBackup } from "./backup";

/**
 * Durable cross-store recovery coordinator for complete-backup imports.
 *
 * When `DATABASE_URL` is set, Chat lives in SQLite while Studio drafts live in
 * PostgreSQL: two engines cannot share one transaction. To keep the import
 * all-or-nothing anyway, the coordinator records every import as a job *in
 * SQLite before any write happens*:
 *
 *  1. the whole validated payload (staged),
 *  2. a durable snapshot of the owner's pre-import state in both stores,
 *  3. the job's status, advanced through durable checkpoints as each half
 *     commits,
 *  4. an owner-level lock so a second import cannot start until this one
 *     finishes or is fully rolled back.
 *
 * If anything fails at any checkpoint — or the process dies mid-import — the
 * job is still on disk with enough information to roll both stores back to
 * their exact previous state. Recovery runs automatically at process start
 * (best-effort) and at the start of the next import for that owner.
 *
 * After a successful commit or a successful rollback, the staged payload and
 * pre-import snapshot are logically deleted from the journal (replaced with
 * empty strings). Only non-sensitive metadata remains. This is not a
 * guarantee of physical erasure from SQLite pages or filesystem backups.
 *
 * An unresolved rollback failure keeps the snapshot so recovery can retry,
 * and the owner lock stays held so a new import cannot overwrite it.
 */

export type ImportJobStatus =
  | "prepared" // job recorded; nothing written yet
  | "chat-committed" // chat half committed (SQLite)
  | "studio-committed" // studio half committed (PostgreSQL)
  | "completed" // both halves committed and the job is done
  | "restoring" // a failure was detected; rollback in progress
  | "restored" // both stores rolled back to the pre-import state (terminal)
  | "failed"; // rollback itself failed (terminal; needs operator attention)

export interface ImportJobRecord {
  id: string;
  /** Canonical owner id — the Studio/PostgreSQL identity. */
  owner_id: string;
  /**
   * The session-level user id — the identity Chat rows are stored under.
   * In mixed mode these differ (chat uses the raw session id, studio uses the
   * deterministic canonical id), so the job records both.
   */
  chat_user_id: string;
  mode: string;
  source_version: number;
  status: ImportJobStatus;
  created_at: string;
  updated_at: string;
  payload_json: string;
  pre_state_json: string;
  error_json: string | null;
  chat_sessions: number | null;
  memories: number | null;
  studio_drafts: number | null;
}

export interface ChatPreState {
  sessions: ChatSession[];
  memories: ChatMemory[];
  memoryEnabled: boolean;
}

export interface StudioPreState {
  drafts: Array<{
    id: string;
    ownerId: string;
    schemaVersion: number;
    templateRegistryVersion: number;
    themeRegistryVersion: number;
    revision: number;
    createdAt: string;
    updatedAt: string;
    brief: SiteBriefV1;
  }>;
}

export interface ImportPreState {
  chat: ChatPreState;
  studio: StudioPreState;
}

export interface ImportJobCounts {
  chatSessions: number;
  memories: number;
  studioDrafts: number;
}

/**
 * Another complete-backup import is already running for this owner, or a
 * previous import could not be rolled back and still holds the owner lock.
 */
export class ImportInProgressError extends Error {
  readonly status = 409;
  constructor(
    message = "An import is already in progress for this account. Wait for it to finish.",
  ) {
    super(message);
    this.name = "ImportInProgressError";
  }
}

const JOB_STATUSES: readonly ImportJobStatus[] = [
  "prepared",
  "chat-committed",
  "studio-committed",
  "completed",
  "restoring",
  "restored",
  "failed",
];

const ACTIVE_STATUSES: readonly ImportJobStatus[] = [
  "prepared",
  "chat-committed",
  "studio-committed",
];

const BLOCKING_STATUSES: readonly ImportJobStatus[] = ["restoring", "failed"];

/** Creates the coordinator tables on the shared SQLite connection. */
export function ensureCoordinatorSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_import_jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      chat_user_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (${JOB_STATUSES.map((s) => `'${s}'`).join(",")})),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      pre_state_json TEXT NOT NULL,
      error_json TEXT
    );
    CREATE TABLE IF NOT EXISTS backup_import_locks (
      owner_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );
  `);
  for (const column of [
    "chat_sessions",
    "memories",
    "studio_drafts",
  ] as const) {
    try {
      db.exec(`ALTER TABLE backup_import_jobs ADD COLUMN ${column} INTEGER`);
    } catch {
      // Column already exists on an upgraded database.
    }
  }
}

function setJobStatus(
  db: DatabaseSync,
  jobId: string,
  status: ImportJobStatus,
  error?: unknown,
): void {
  db.prepare(
    "UPDATE backup_import_jobs SET status = ?, error_json = ?, updated_at = ? WHERE id = ?",
  ).run(
    status,
    error === undefined ? null : JSON.stringify(String(error)),
    new Date().toISOString(),
    jobId,
  );
}

export function getImportJob(jobId: string): ImportJobRecord | null {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  return (
    (db
      .prepare("SELECT * FROM backup_import_jobs WHERE id = ?")
      .get(jobId) as unknown as ImportJobRecord | undefined) ?? null
  );
}

/** All recorded jobs, newest first, optionally for one owner. */
export function listImportJobs(ownerId?: string): ImportJobRecord[] {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  const rows = (ownerId
    ? db
        .prepare(
          "SELECT * FROM backup_import_jobs WHERE owner_id = ? ORDER BY created_at DESC",
        )
        .all(ownerId)
    : db
        .prepare("SELECT * FROM backup_import_jobs ORDER BY created_at DESC")
        .all()) as unknown as ImportJobRecord[];
  return rows;
}

export function getOwnerImportLock(
  ownerId: string,
): { owner_id: string; job_id: string; acquired_at: string } | null {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  return (
    (db
      .prepare("SELECT * FROM backup_import_locks WHERE owner_id = ?")
      .get(ownerId) as
      { owner_id: string; job_id: string; acquired_at: string } | undefined) ??
    null
  );
}

/**
 * Concatenates every journal payload/snapshot column. Tests use this to prove
 * a sentinel is gone after sanitization. Never log the result.
 */
export function journalSensitiveBlob(): string {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  const rows = db
    .prepare("SELECT payload_json, pre_state_json FROM backup_import_jobs")
    .all() as Array<{ payload_json: string; pre_state_json: string }>;
  return rows
    .map((row) => `${row.payload_json}\n${row.pre_state_json}`)
    .join("\n");
}

/**
 * Captures the owner's current PostgreSQL drafts. Runs before anything is
 * written, so the snapshot is the exact state a failed import must return to.
 */
async function captureStudioPreState(ownerId: string): Promise<StudioPreState> {
  const { getDatabase } = await import("@/db");
  const { studioDrafts } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await getDatabase()
    .select()
    .from(studioDrafts)
    .where(eq(studioDrafts.ownerId, ownerId));
  return {
    drafts: rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      schemaVersion: row.schemaVersion,
      templateRegistryVersion: row.templateVersion,
      themeRegistryVersion: row.themeVersion,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      brief: row.brief as SiteBriefV1,
    })),
  };
}

function releaseLock(db: DatabaseSync, ownerId: string, jobId: string): void {
  db.prepare(
    "DELETE FROM backup_import_locks WHERE owner_id = ? AND job_id = ?",
  ).run(ownerId, jobId);
}

/**
 * Logically deletes the staged payload and pre-import snapshot, keeps
 * non-sensitive metadata, and releases the owner lock. Does not claim the
 * bytes have been wiped from SQLite pages.
 */
export function sanitizeAndReleaseJob(
  jobId: string,
  status: "completed" | "restored",
  counts?: ImportJobCounts,
): void {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  const job = getImportJob(jobId);
  if (!job) return;
  store.runInTransaction(() => {
    store.connection
      .prepare(
        `UPDATE backup_import_jobs
            SET status = ?,
                payload_json = '',
                pre_state_json = '',
                error_json = NULL,
                chat_sessions = ?,
                memories = ?,
                studio_drafts = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        counts?.chatSessions ?? job.chat_sessions,
        counts?.memories ?? job.memories,
        counts?.studioDrafts ?? job.studio_drafts,
        new Date().toISOString(),
        jobId,
      );
    releaseLock(store.connection, job.owner_id, jobId);
  });
}

/**
 * Stage 1: validate-and-stage before any write. Captures the durable
 * pre-import state of both stores, stores the whole payload, records the
 * job as `prepared`, and takes the owner lock in the same SQLite write
 * transaction. Returns the job id.
 */
export async function beginImportJob(
  user: SessionUser,
  ownerId: string,
  backup: NormalizedBackup,
): Promise<string> {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  const chat = store.captureUserStateSync(user.id);
  const studio = await captureStudioPreState(ownerId);
  const id = randomUUID();
  const now = new Date().toISOString();

  store.runInTransaction(() => {
    const existingLock = store.connection
      .prepare("SELECT * FROM backup_import_locks WHERE owner_id = ?")
      .get(ownerId) as
      { owner_id: string; job_id: string; acquired_at: string } | undefined;
    if (existingLock) {
      const held = store.connection
        .prepare("SELECT * FROM backup_import_jobs WHERE id = ?")
        .get(existingLock.job_id) as unknown as ImportJobRecord | undefined;
      if (held && (ACTIVE_STATUSES as string[]).includes(held.status)) {
        throw new ImportInProgressError();
      }
      if (held && (BLOCKING_STATUSES as string[]).includes(held.status)) {
        throw new ImportInProgressError(
          "A previous import could not be rolled back. Recovery must finish before you can import again.",
        );
      }
      // Stale lock (terminal job, or the job row is gone).
      store.connection
        .prepare("DELETE FROM backup_import_locks WHERE owner_id = ?")
        .run(ownerId);
    }

    const blocking = store.connection
      .prepare(
        `SELECT id FROM backup_import_jobs
          WHERE owner_id = ? AND status IN ('restoring','failed')
          LIMIT 1`,
      )
      .get(ownerId);
    if (blocking) {
      throw new ImportInProgressError(
        "A previous import could not be rolled back. Recovery must finish before you can import again.",
      );
    }

    store.connection
      .prepare(
        `INSERT INTO backup_import_jobs
           (id, owner_id, chat_user_id, mode, source_version, status, created_at, updated_at, payload_json, pre_state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ownerId,
        user.id,
        "mixed",
        backup.sourceVersion,
        "prepared",
        now,
        now,
        JSON.stringify(backup),
        JSON.stringify({ chat, studio }),
      );
    try {
      store.connection
        .prepare(
          "INSERT INTO backup_import_locks (owner_id, job_id, acquired_at) VALUES (?, ?, ?)",
        )
        .run(ownerId, id, now);
    } catch {
      throw new ImportInProgressError();
    }
  });
  return id;
}

export function markChatCommitted(jobId: string): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "chat-committed");
}

export function markStudioCommitted(jobId: string): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "studio-committed");
}

export function markCompleted(jobId: string, counts?: ImportJobCounts): void {
  sanitizeAndReleaseJob(jobId, "completed", counts);
}

export function markFailed(jobId: string, error: unknown): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "failed", error);
}

/**
 * Rolls a job back: resets the owner's chat state (one SQLite transaction)
 * and the owner's PostgreSQL drafts (one PostgreSQL transaction) to the
 * snapshot captured before the import started. Idempotent — running it again
 * simply resets to the same snapshot (or is a no-op once sanitized).
 */
export async function restoreJob(job: ImportJobRecord): Promise<void> {
  if (job.status === "restored" || job.status === "completed") return;
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  setJobStatus(store.connection, job.id, "restoring");
  const snapshot = job.pre_state_json;
  if (!snapshot) {
    // Nothing left to restore; treat as already cleaned up.
    sanitizeAndReleaseJob(job.id, "restored");
    return;
  }
  const pre = JSON.parse(snapshot) as ImportPreState;
  try {
    // Chat half: chat, memories and the memory preference all live in SQLite,
    // so one transaction covers them. Chat rows are keyed by the session-level
    // user id, which is not the same as the canonical Studio owner id.
    store.runInTransaction(() => {
      store.restoreUserSync(job.chat_user_id, pre.chat);
    });
    // Studio half: drafts live in PostgreSQL when the coordinator is used.
    await restoreStudioState(job.owner_id, pre.studio);
    sanitizeAndReleaseJob(job.id, "restored");
  } catch (error) {
    // Stay in "restoring": recovery retries on the next import / startup.
    // Keep the snapshot and the owner lock so a new import cannot start.
    setJobStatus(store.connection, job.id, "restoring", error);
    throw error;
  }
}

async function restoreStudioState(
  ownerId: string,
  pre: StudioPreState,
): Promise<void> {
  const { getDatabase } = await import("@/db");
  const { studioDrafts } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await getDatabase().transaction(async (tx) => {
    await tx.delete(studioDrafts).where(eq(studioDrafts.ownerId, ownerId));
    for (const draft of pre.drafts) {
      await tx.insert(studioDrafts).values({
        id: draft.id,
        ownerId,
        schemaVersion: draft.schemaVersion,
        templateVersion: draft.templateRegistryVersion,
        themeVersion: draft.themeRegistryVersion,
        revision: draft.revision,
        createdAt: new Date(draft.createdAt),
        updatedAt: new Date(draft.updatedAt),
        brief: draft.brief,
      });
    }
  });
}

let recoveryInFlight: Promise<void> | null = null;

/**
 * Rolls back every job an interrupted or failed import left behind. Runs
 * automatically at process start and at the start of each import, so a
 * process that died between checkpoints — or an earlier rollback that could
 * not complete because a store was unreachable — is cleaned up before
 * anything new is written. Idempotent. Concurrent callers share one in-flight
 * pass so two imports cannot recover the same job twice in parallel.
 *
 * A pending job created in mixed mode (PostgreSQL) cannot be rolled back when
 * `DATABASE_URL` is no longer configured — its studio half is unreachable — so
 * recovery refuses rather than silently proceeding.
 */
export async function recoverPendingImports(ownerId?: string): Promise<void> {
  if (recoveryInFlight) {
    await recoveryInFlight;
    if (!ownerId) return;
  }
  const run = (async () => {
    const store = getSqliteChatStore();
    ensureCoordinatorSchema(store.connection);
    const jobs = (ownerId
      ? store.connection
          .prepare(
            `SELECT * FROM backup_import_jobs
                WHERE owner_id = ?
                  AND status IN
                    ('prepared','chat-committed','studio-committed','restoring','failed')
                ORDER BY created_at`,
          )
          .all(ownerId)
      : store.connection
          .prepare(
            `SELECT * FROM backup_import_jobs
                WHERE status IN
                  ('prepared','chat-committed','studio-committed','restoring','failed')
                ORDER BY created_at`,
          )
          .all()) as unknown as ImportJobRecord[];
    for (const job of jobs) {
      if (job.mode === "mixed" && !process.env.DATABASE_URL) {
        throw new Error(
          "An interrupted mixed-store import was found, but DATABASE_URL is not configured, " +
            "so its PostgreSQL half cannot be rolled back. Restore the PostgreSQL configuration " +
            "and run the import again.",
        );
      }
      await restoreJob(job);
    }
  })();
  recoveryInFlight = run;
  try {
    await run;
  } finally {
    if (recoveryInFlight === run) recoveryInFlight = null;
  }
}

let startupRecoveryScheduled = false;

/** Best-effort recovery when the Studio store is first opened. */
export function scheduleStartupImportRecovery(): void {
  if (startupRecoveryScheduled) return;
  if (!process.env.DATABASE_URL) return;
  startupRecoveryScheduled = true;
  void recoverPendingImports().catch(() => {
    // The next import for the affected owner retries. Do not log snapshots.
  });
}
