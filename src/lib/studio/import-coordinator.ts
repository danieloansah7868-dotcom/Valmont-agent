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
 *     commits.
 *
 * If anything fails at any checkpoint — or the process dies mid-import — the
 * job is still on disk with enough information to roll both stores back to
 * their exact previous state. Recovery runs automatically at the start of the
 * next import, so an interrupted import is cleaned up after a restart before
 * anything new is written.
 *
 * Success is reported only after both halves have committed and the job is
 * marked `completed`. A failure rolls both stores back and is reported as a
 * plain failure (`ImportFailedError`), never as a partial success.
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

const JOB_STATUSES: readonly ImportJobStatus[] = [
  "prepared",
  "chat-committed",
  "studio-committed",
  "completed",
  "restoring",
  "restored",
  "failed",
];

/** Creates the coordinator table on the shared SQLite connection. */
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
  `);
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
  return (
    (db
      .prepare("SELECT * FROM backup_import_jobs WHERE id = ?")
      .get(jobId) as unknown as ImportJobRecord | undefined) ?? null
  );
}

/** All recorded jobs, newest first, optionally for one owner. */
export function listImportJobs(ownerId?: string): ImportJobRecord[] {
  const db = getSqliteChatStore().connection;
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

/**
 * Stage 1: validate-and-stage before any write. Captures the durable
 * pre-import state of both stores, stores the whole payload, and records the
 * job as `prepared`. Returns the job id.
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
  return id;
}

export function markChatCommitted(jobId: string): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "chat-committed");
}

export function markStudioCommitted(jobId: string): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "studio-committed");
}

export function markCompleted(jobId: string): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "completed");
}

export function markFailed(jobId: string, error: unknown): void {
  setJobStatus(getSqliteChatStore().connection, jobId, "failed", error);
}

/**
 * Rolls a job back: resets the owner's chat state (one SQLite transaction)
 * and the owner's PostgreSQL drafts (one PostgreSQL transaction) to the
 * snapshot captured before the import started. Idempotent — running it again
 * simply resets to the same snapshot.
 */
export async function restoreJob(job: ImportJobRecord): Promise<void> {
  if (job.status === "restored" || job.status === "completed") return;
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  setJobStatus(store.connection, job.id, "restoring");
  const pre = JSON.parse(job.pre_state_json) as ImportPreState;
  try {
    // Chat half: chat, memories and the memory preference all live in SQLite,
    // so one transaction covers them. Chat rows are keyed by the session-level
    // user id, which is not the same as the canonical Studio owner id.
    store.runInTransaction(() => {
      store.restoreUserSync(job.chat_user_id, pre.chat);
    });
    // Studio half: drafts live in PostgreSQL when the coordinator is used.
    await restoreStudioState(job.owner_id, pre.studio);
    setJobStatus(store.connection, job.id, "restored");
  } catch (error) {
    // Stay in "restoring": recovery retries on the next import. The original
    // failure is preserved so an operator can see what is being cleaned up.
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

/**
 * Rolls back every job an interrupted or failed import left behind. Runs
 * automatically at the start of each import, so a process that died between
 * checkpoints — or an earlier rollback that could not complete because a store
 * was unreachable — is cleaned up before anything new is written. Idempotent.
 *
 * A pending job created in mixed mode (PostgreSQL) cannot be rolled back when
 * `DATABASE_URL` is no longer configured — its studio half is unreachable — so
 * recovery refuses rather than silently proceeding.
 */
export async function recoverPendingImports(): Promise<void> {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  const jobs = store.connection
    .prepare(
      `SELECT * FROM backup_import_jobs
        WHERE status IN
          ('prepared','chat-committed','studio-committed','restoring','failed')
        ORDER BY created_at`,
    )
    .all() as unknown as ImportJobRecord[];
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
}
