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
 * Owner imports are gated by a lease: owner id, job id, a cryptographically
 * random lock token, a heartbeat/expiry, and a monotonically increasing
 * generation. A second import for the same owner inspects that lease and
 * returns 409 while it is still active. It never restores a live job and
 * never clears another process's lock.
 *
 * Recovery may claim a job only after the lease has expired, and only by an
 * atomic compare-and-swap on the existing token and generation. An old
 * process that later wakes up cannot write, commit, sanitize or release the
 * replacement lock because every mutation names the token it was issued.
 *
 * After a successful commit or a successful rollback, the staged payload and
 * pre-import snapshot are logically deleted from the journal (replaced with
 * empty strings). Only non-sensitive metadata remains. This is not a
 * guarantee of physical erasure from SQLite pages or filesystem backups.
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

export interface ImportLockLease {
  ownerId: string;
  jobId: string;
  lockToken: string;
  generation: number;
}

export interface OwnerImportLockRow {
  owner_id: string;
  job_id: string;
  lock_token: string;
  generation: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface StartedImportJob {
  jobId: string;
  lease: ImportLockLease;
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

/**
 * This process no longer holds the owner lease. Another worker claimed it
 * after expiry (or the lock was released). The caller must stop writing and
 * must not sanitize or release the replacement lock.
 */
export class ImportLostLeaseError extends Error {
  readonly status = 409;
  constructor(message = "This import is no longer holding the owner lock.") {
    super(message);
    this.name = "ImportLostLeaseError";
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

const PENDING_STATUSES: readonly ImportJobStatus[] = [
  "prepared",
  "chat-committed",
  "studio-committed",
  "restoring",
  "failed",
];

export const DEFAULT_IMPORT_LEASE_MS = 15_000;

let leaseDurationMs = DEFAULT_IMPORT_LEASE_MS;

/** Test helper: shorten or restore the owner-import lease. */
export function setImportLeaseMsForTests(ms: number | null): void {
  leaseDurationMs = ms === null ? DEFAULT_IMPORT_LEASE_MS : ms;
}

export function importLeaseMs(): number {
  return leaseDurationMs;
}

function nowMs(): number {
  return Date.now();
}

function nowIso(at = nowMs()): string {
  return new Date(at).toISOString();
}

function expiresIso(at = nowMs()): string {
  return new Date(at + leaseDurationMs).toISOString();
}

function isExpired(lock: OwnerImportLockRow, at = nowMs()): boolean {
  if (!lock.expires_at) return true;
  const expires = Date.parse(lock.expires_at);
  return Number.isNaN(expires) || expires <= at;
}

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
      lock_token TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT ''
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
  ensureLockColumns(db);
}

function ensureLockColumns(db: DatabaseSync): void {
  const cols = db
    .prepare("PRAGMA table_info(backup_import_locks)")
    .all() as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((column) => column.name));
  const additions: Array<[string, string]> = [
    ["lock_token", "TEXT NOT NULL DEFAULT ''"],
    ["generation", "INTEGER NOT NULL DEFAULT 0"],
    ["heartbeat_at", "TEXT NOT NULL DEFAULT ''"],
    ["expires_at", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of additions) {
    if (!names.has(name)) {
      db.exec(
        `ALTER TABLE backup_import_locks ADD COLUMN ${name} ${definition}`,
      );
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
    nowIso(),
    jobId,
  );
}

function readLock(
  db: DatabaseSync,
  ownerId: string,
): OwnerImportLockRow | null {
  return (
    (db
      .prepare("SELECT * FROM backup_import_locks WHERE owner_id = ?")
      .get(ownerId) as OwnerImportLockRow | undefined) ?? null
  );
}

function readJob(db: DatabaseSync, jobId: string): ImportJobRecord | null {
  return (
    (db
      .prepare("SELECT * FROM backup_import_jobs WHERE id = ?")
      .get(jobId) as unknown as ImportJobRecord | undefined) ?? null
  );
}

export function getImportJob(jobId: string): ImportJobRecord | null {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  return readJob(db, jobId);
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

export function getOwnerImportLock(ownerId: string): OwnerImportLockRow | null {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  return readLock(db, ownerId);
}

export function ownerImportLeaseIsActive(ownerId: string): boolean {
  const lock = getOwnerImportLock(ownerId);
  return Boolean(lock && !isExpired(lock));
}

/**
 * 409 immediately when this owner already has an unexpired lease. Does not
 * restore anything and does not touch either store.
 */
export function refuseIfOwnerImportActive(ownerId: string): void {
  if (ownerImportLeaseIsActive(ownerId)) {
    throw new ImportInProgressError();
  }
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
 * Captures the owner's current PostgreSQL drafts. Runs after the owner lock
 * is held, so a concurrent import cannot change this snapshot.
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

function changesOf(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

export function assertOwnsImportLease(lease: ImportLockLease): void {
  const lock = getOwnerImportLock(lease.ownerId);
  if (
    !lock ||
    lock.job_id !== lease.jobId ||
    lock.lock_token !== lease.lockToken ||
    Number(lock.generation) !== lease.generation
  ) {
    throw new ImportLostLeaseError();
  }
}

export function renewImportLease(lease: ImportLockLease): void {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  const at = nowMs();
  const result = store.connection
    .prepare(
      `UPDATE backup_import_locks
          SET heartbeat_at = ?, expires_at = ?
        WHERE owner_id = ? AND job_id = ? AND lock_token = ? AND generation = ?`,
    )
    .run(
      nowIso(at),
      expiresIso(at),
      lease.ownerId,
      lease.jobId,
      lease.lockToken,
      lease.generation,
    );
  if (changesOf(result) !== 1) throw new ImportLostLeaseError();
}

/**
 * Acquire a new owner lease. Uses INSERT ... ON CONFLICT DO NOTHING so a
 * unique conflict is a 409 and any other database error propagates unchanged.
 */
export function acquireNewImportLock(
  ownerId: string,
  jobId: string,
): ImportLockLease {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  return store.runInTransaction(() => {
    const existing = readLock(store.connection, ownerId);
    if (existing && !isExpired(existing)) {
      throw new ImportInProgressError();
    }
    if (existing && isExpired(existing)) {
      const held = existing.job_id
        ? readJob(store.connection, existing.job_id)
        : null;
      if (held && (PENDING_STATUSES as string[]).includes(held.status)) {
        throw new ImportInProgressError(
          "A previous import could not be rolled back. Recovery must finish before you can import again.",
        );
      }
      const removed = store.connection
        .prepare(
          `DELETE FROM backup_import_locks
            WHERE owner_id = ? AND lock_token = ? AND generation = ? AND expires_at <= ?`,
        )
        .run(ownerId, existing.lock_token, existing.generation, nowIso());
      if (changesOf(removed) !== 1) throw new ImportInProgressError();
    }

    const token = randomUUID();
    const at = nowMs();
    const inserted = store.connection
      .prepare(
        `INSERT INTO backup_import_locks
           (owner_id, job_id, lock_token, generation, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(owner_id) DO NOTHING`,
      )
      .run(ownerId, jobId, token, nowIso(at), nowIso(at), expiresIso(at));
    if (changesOf(inserted) !== 1) {
      throw new ImportInProgressError();
    }
    return {
      ownerId,
      jobId,
      lockToken: token,
      generation: 1,
    };
  });
}

/**
 * Atomically claim an expired (or missing) owner lock for recovery. Returns
 * null when another worker won the compare-and-swap or the lease is still live.
 */
export function tryClaimExpiredOwnerLock(
  ownerId: string,
  jobId: string,
): ImportLockLease | null {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  return store.runInTransaction(() => {
    const existing = readLock(store.connection, ownerId);
    const at = nowMs();
    if (!existing) {
      const token = randomUUID();
      const inserted = store.connection
        .prepare(
          `INSERT INTO backup_import_locks
             (owner_id, job_id, lock_token, generation, acquired_at, heartbeat_at, expires_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(owner_id) DO NOTHING`,
        )
        .run(ownerId, jobId, token, nowIso(at), nowIso(at), expiresIso(at));
      if (changesOf(inserted) !== 1) return null;
      return { ownerId, jobId, lockToken: token, generation: 1 };
    }
    if (!isExpired(existing, at)) return null;
    const token = randomUUID();
    const newGeneration = Number(existing.generation) + 1;
    const updated = store.connection
      .prepare(
        `UPDATE backup_import_locks
            SET lock_token = ?, generation = ?, job_id = ?,
                acquired_at = ?, heartbeat_at = ?, expires_at = ?
          WHERE owner_id = ?
            AND lock_token = ?
            AND generation = ?
            AND expires_at <= ?`,
      )
      .run(
        token,
        newGeneration,
        jobId,
        nowIso(at),
        nowIso(at),
        expiresIso(at),
        ownerId,
        existing.lock_token,
        existing.generation,
        nowIso(at),
      );
    if (changesOf(updated) !== 1) return null;
    return {
      ownerId,
      jobId,
      lockToken: token,
      generation: newGeneration,
    };
  });
}

export function releaseImportLock(lease: ImportLockLease): boolean {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  const result = store.connection
    .prepare(
      `DELETE FROM backup_import_locks
        WHERE owner_id = ? AND job_id = ? AND lock_token = ? AND generation = ?`,
    )
    .run(lease.ownerId, lease.jobId, lease.lockToken, lease.generation);
  return changesOf(result) === 1;
}

/** Test helper: mark the owner's lease expired without changing its token. */
export function expireOwnerLockForTests(ownerId: string): void {
  const db = getSqliteChatStore().connection;
  ensureCoordinatorSchema(db);
  db.prepare(
    "UPDATE backup_import_locks SET expires_at = ? WHERE owner_id = ?",
  ).run("1970-01-01T00:00:00.000Z", ownerId);
}

const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

function heartbeatKey(lease: ImportLockLease): string {
  return `${lease.ownerId}:${lease.jobId}:${lease.lockToken}:${lease.generation}`;
}

export function startImportLeaseHeartbeat(lease: ImportLockLease): void {
  stopImportLeaseHeartbeat(lease);
  const period = Math.max(20, Math.floor(importLeaseMs() / 3));
  const timer = setInterval(() => {
    try {
      renewImportLease(lease);
    } catch {
      stopImportLeaseHeartbeat(lease);
    }
  }, period);
  timer.unref?.();
  heartbeats.set(heartbeatKey(lease), timer);
}

export function stopImportLeaseHeartbeat(lease: ImportLockLease): void {
  const key = heartbeatKey(lease);
  const timer = heartbeats.get(key);
  if (timer) {
    clearInterval(timer);
    heartbeats.delete(key);
  }
}

/**
 * Logically deletes the staged payload and pre-import snapshot, keeps
 * non-sensitive metadata, and releases the owner lock — only if `lease`
 * still matches. Does not claim the bytes have been wiped from SQLite pages.
 */
export function sanitizeAndReleaseJob(
  jobId: string,
  status: "completed" | "restored",
  counts: ImportJobCounts | undefined,
  lease: ImportLockLease,
): void {
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  const job = readJob(store.connection, jobId);
  if (!job) {
    releaseImportLock(lease);
    return;
  }
  store.runInTransaction(() => {
    assertOwnsImportLease(lease);
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
        nowIso(),
        jobId,
      );
    if (!releaseImportLock(lease)) throw new ImportLostLeaseError();
  });
}

/**
 * Stage 1: take the owner lock *before* capturing pre-state or writing
 * either store. Then record the job as `prepared`. Returns the job id and
 * the lease this process must present for every later mutation.
 */
export async function beginImportJob(
  user: SessionUser,
  ownerId: string,
  backup: NormalizedBackup,
  mode: "mixed" | "sqlite" = "mixed",
): Promise<StartedImportJob> {
  refuseIfOwnerImportActive(ownerId);
  await recoverPendingImports(ownerId);
  refuseIfOwnerImportActive(ownerId);

  const jobId = randomUUID();
  const lease = acquireNewImportLock(ownerId, jobId);
  startImportLeaseHeartbeat(lease);
  try {
    renewImportLease(lease);
    const store = getSqliteChatStore();
    ensureCoordinatorSchema(store.connection);
    const chat = store.captureUserStateSync(user.id);
    const studio =
      mode === "mixed" ? await captureStudioPreState(ownerId) : { drafts: [] };
    renewImportLease(lease);
    const now = nowIso();
    store.runInTransaction(() => {
      assertOwnsImportLease(lease);
      store.connection
        .prepare(
          `INSERT INTO backup_import_jobs
             (id, owner_id, chat_user_id, mode, source_version, status, created_at, updated_at, payload_json, pre_state_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          ownerId,
          user.id,
          mode,
          backup.sourceVersion,
          "prepared",
          now,
          now,
          JSON.stringify(backup),
          JSON.stringify({ chat, studio }),
        );
    });
    return { jobId, lease };
  } catch (error) {
    stopImportLeaseHeartbeat(lease);
    releaseImportLock(lease);
    throw error;
  }
}

export function markChatCommitted(jobId: string, lease: ImportLockLease): void {
  renewImportLease(lease);
  setJobStatus(getSqliteChatStore().connection, jobId, "chat-committed");
}

export function markStudioCommitted(
  jobId: string,
  lease: ImportLockLease,
): void {
  renewImportLease(lease);
  setJobStatus(getSqliteChatStore().connection, jobId, "studio-committed");
}

export function markCompleted(
  jobId: string,
  counts: ImportJobCounts | undefined,
  lease: ImportLockLease,
): void {
  renewImportLease(lease);
  sanitizeAndReleaseJob(jobId, "completed", counts, lease);
  stopImportLeaseHeartbeat(lease);
}

export function markFailed(
  jobId: string,
  error: unknown,
  lease: ImportLockLease,
): void {
  try {
    renewImportLease(lease);
    setJobStatus(getSqliteChatStore().connection, jobId, "failed", error);
  } catch (lost) {
    if (lost instanceof ImportLostLeaseError) return;
    throw lost;
  }
}

/**
 * Rolls a job back. Requires a live lease for this job. An obsolete token
 * is refused before any store is touched.
 */
export async function restoreJob(
  job: ImportJobRecord,
  lease: ImportLockLease,
): Promise<void> {
  if (job.status === "restored" || job.status === "completed") return;
  renewImportLease(lease);
  const store = getSqliteChatStore();
  ensureCoordinatorSchema(store.connection);
  setJobStatus(store.connection, job.id, "restoring");
  const snapshot = job.pre_state_json;
  if (!snapshot) {
    sanitizeAndReleaseJob(job.id, "restored", undefined, lease);
    stopImportLeaseHeartbeat(lease);
    return;
  }
  const pre = JSON.parse(snapshot) as ImportPreState;
  try {
    renewImportLease(lease);
    store.runInTransaction(() => {
      assertOwnsImportLease(lease);
      store.restoreUserSync(job.chat_user_id, pre.chat);
    });
    if (job.mode === "mixed") {
      renewImportLease(lease);
      await restoreStudioState(job.owner_id, pre.studio);
    }
    renewImportLease(lease);
    sanitizeAndReleaseJob(job.id, "restored", undefined, lease);
    stopImportLeaseHeartbeat(lease);
  } catch (error) {
    if (error instanceof ImportLostLeaseError) throw error;
    try {
      setJobStatus(store.connection, job.id, "restoring", error);
    } catch {
      // Keep the original restore error.
    }
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
 * Rolls back every job whose lease has expired (or that has no live lock).
 * Unexpired leases are skipped: a live import is not a crash, and a draft
 * GET / startup scan must not roll it back.
 *
 * Claiming uses compare-and-swap on the lock token and generation so only
 * one recovery worker can restore a given owner.
 */
export async function recoverPendingImports(ownerId?: string): Promise<void> {
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
    const lock = readLock(store.connection, job.owner_id);
    if (lock && !isExpired(lock)) {
      // Live lease — whether it is this job or another. Do not restore.
      continue;
    }
    if (job.mode === "mixed" && !process.env.DATABASE_URL) {
      throw new Error(
        "An interrupted mixed-store import was found, but DATABASE_URL is not configured, " +
          "so its PostgreSQL half cannot be rolled back. Restore the PostgreSQL configuration " +
          "and run the import again.",
      );
    }
    const claimed = tryClaimExpiredOwnerLock(job.owner_id, job.id);
    if (!claimed) continue;
    startImportLeaseHeartbeat(claimed);
    try {
      await restoreJob(job, claimed);
    } catch (error) {
      stopImportLeaseHeartbeat(claimed);
      throw error;
    }
  }
}

let startupRecoveryScheduled = false;

/** Best-effort recovery when the Studio store is first opened. */
export function scheduleStartupImportRecovery(): void {
  if (startupRecoveryScheduled) return;
  startupRecoveryScheduled = true;
  void recoverPendingImports().catch(() => {
    // The next import for the affected owner retries. Do not log snapshots.
  });
}

/** Test helper: allow another startup scan in the same process. */
export function resetStartupImportRecoveryForTests(): void {
  startupRecoveryScheduled = false;
}
