import { sql, type SQL } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  ImportLostLeaseError,
  type ImportLockLease,
} from "./import-coordinator";

/**
 * Durable PostgreSQL-side import fence.
 *
 * The SQLite lease alone cannot fence PostgreSQL Studio writes: a lease can
 * expire and be replaced *after* a SQLite token check but *before* the
 * PostgreSQL COMMIT, letting an obsolete transaction commit late writes over
 * a finished recovery. The `studio_import_fences` row closes that gap with
 * PostgreSQL's own transactional guarantees:
 *
 * - Every import transaction ends with {@link touchStudioImportFenceInTx} —
 *   a conditional UPDATE … RETURNING on the held owner/job/token/generation,
 *   executed immediately before commit. The UPDATE takes the fence row's
 *   lock, so the check and the commit are a single serialized unit: if the
 *   fence was advanced, zero rows match and the whole transaction rolls back.
 * - Recovery advances the fence with {@link advanceStudioImportFenceInTx}
 *   inside the same transaction that restores the pre-import Studio state.
 *   Advancing also takes the row lock, so recovery queues behind any
 *   in-flight import transaction that already touched the fence.
 *
 * Both orderings are therefore safe: if recovery's fence advance commits
 * first, the obsolete transaction fails its final touch and rolls back; if
 * the obsolete transaction wins the row-lock race and commits first,
 * recovery serializes strictly after it and its restore overwrites the late
 * writes with the exact pre-import snapshot. Once the replacement fence is
 * installed, no obsolete transaction can commit at all.
 *
 * The fence row persists after a successful release so per-owner generations
 * stay monotonic even if the SQLite file is replaced. It contains identity
 * only — owner id, job id, random lock token, generation, update timestamp —
 * never a payload, snapshot, credential or any other sensitive data, and it
 * is never included in exported backups.
 */

/** Anything that can run raw SQL: the Drizzle database or a transaction. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export interface StudioImportFenceRow {
  ownerId: string;
  jobId: string;
  lockToken: string;
  generation: number;
  updatedAt: string;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : [];
}

/** Reads the owner's fence row, or null when no import has ever run. */
export async function readStudioImportFence(
  ownerId: string,
): Promise<StudioImportFenceRow | null> {
  const rows = rowsOf(
    await getDatabase().execute(
      sql`SELECT owner_id, job_id, lock_token, generation, updated_at
            FROM studio_import_fences
           WHERE owner_id = ${ownerId}`,
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ownerId: String(row.owner_id),
    jobId: String(row.job_id),
    lockToken: String(row.lock_token),
    generation: Number(row.generation),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Installs or advances the owner's fence to this lease's identity.
 *
 * The upsert succeeds only when the stored generation is older, or when the
 * row already carries exactly this lease (an idempotent retry by the same
 * holder). A newer fence means another worker replaced this lease — the
 * caller gets {@link ImportLostLeaseError} and must stop.
 *
 * Run inside a transaction this takes the fence row's lock until commit,
 * which is exactly what recovery uses to serialize against an in-flight
 * import transaction.
 */
export async function advanceStudioImportFenceInTx(
  executor: SqlExecutor,
  lease: ImportLockLease,
): Promise<void> {
  const rows = rowsOf(
    await executor.execute(
      sql`INSERT INTO studio_import_fences (owner_id, job_id, lock_token, generation, updated_at)
          VALUES (${lease.ownerId}, ${lease.jobId}, ${lease.lockToken}, ${lease.generation}, now())
          ON CONFLICT (owner_id) DO UPDATE
            SET job_id = excluded.job_id,
                lock_token = excluded.lock_token,
                generation = excluded.generation,
                updated_at = now()
          WHERE studio_import_fences.generation < excluded.generation
             OR (studio_import_fences.generation = excluded.generation
                 AND studio_import_fences.lock_token = excluded.lock_token
                 AND studio_import_fences.job_id = excluded.job_id)
          RETURNING generation`,
    ),
  );
  if (rows.length !== 1) {
    throw new ImportLostLeaseError(
      "A newer import fence is installed for this owner; this lease is obsolete.",
    );
  }
}

/** Advances the fence in its own short transaction (single statement). */
export async function advanceStudioImportFence(
  lease: ImportLockLease,
): Promise<void> {
  await advanceStudioImportFenceInTx(getDatabase(), lease);
}

/**
 * Non-locking verification that the fence still carries exactly this lease.
 * Used at the start of an import transaction for an early, cheap refusal —
 * the authoritative check is {@link touchStudioImportFenceInTx} at the end.
 */
export async function verifyStudioImportFenceInTx(
  executor: SqlExecutor,
  lease: ImportLockLease,
): Promise<void> {
  const rows = rowsOf(
    await executor.execute(
      sql`SELECT 1 AS ok
            FROM studio_import_fences
           WHERE owner_id = ${lease.ownerId}
             AND job_id = ${lease.jobId}
             AND lock_token = ${lease.lockToken}
             AND generation = ${lease.generation}`,
    ),
  );
  if (rows.length !== 1) {
    throw new ImportLostLeaseError(
      "The PostgreSQL import fence no longer carries this lease.",
    );
  }
}

/**
 * The final fence check of an import/restore transaction. Must be the last
 * statement before COMMIT. The conditional UPDATE takes the fence row's lock
 * and matches only the exact held owner/job/token/generation, so either this
 * transaction commits with the fence provably current, or it observes the
 * replacement fence, throws, and PostgreSQL rolls back everything it wrote.
 */
export async function touchStudioImportFenceInTx(
  executor: SqlExecutor,
  lease: ImportLockLease,
): Promise<void> {
  const rows = rowsOf(
    await executor.execute(
      sql`UPDATE studio_import_fences
             SET updated_at = now()
           WHERE owner_id = ${lease.ownerId}
             AND job_id = ${lease.jobId}
             AND lock_token = ${lease.lockToken}
             AND generation = ${lease.generation}
          RETURNING generation`,
    ),
  );
  if (rows.length !== 1) {
    throw new ImportLostLeaseError(
      "The PostgreSQL import fence was advanced by another worker; rolling this transaction back.",
    );
  }
}
