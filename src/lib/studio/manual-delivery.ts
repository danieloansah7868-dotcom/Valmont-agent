/**
 * Stage 6c — the shop's manual delivery actions.
 *
 * A Starter Shop's bundle rows are born `provider = "manual"` and wait at
 * "pending" until a person does something about them (Stage 6a). This module
 * is that "something": the shop admin marks a top-up delivered (they sent it
 * by hand) or failed (they could not). The Studio side never calls these —
 * manual rows are the shop's to finish.
 *
 * Discipline, exactly like `claimForDispatch` in `bundle-delivery.ts`:
 *
 *  - **One atomic UPDATE per mark.** The allowed-transition guards live inside
 *    the WHERE clause, so two people clicking at once (or a double-submit)
 *    can never both move the same row: exactly one UPDATE changes a row, the
 *    loser sees zero rows and is answered with the matching plain-language
 *    409. Delivered stays terminal everywhere (invariant I3) because a
 *    delivered row matches neither guard.
 *  - **Allowed transitions only.** pending+manual → delivered; pending+manual
 *    → failed; failed (any provider) → delivered. Everything else is refused
 *    with wording that tells the shop what to do instead.
 *  - **No provider is involved.** Provider and provider reference are never
 *    touched, attempts are never bumped (nothing was sent), and no merchant
 *    alert fires — the shop did this itself, so there is nobody to alert.
 *
 * SQLite and PostgreSQL each get the same guarded UPDATE; which one runs is
 * decided by `DATABASE_URL`, exactly like `getBundleDeliveriesStore`.
 */

import { and, eq, or } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDeliveries } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/api-errors";
import { getSqliteChatStore } from "@/lib/chat-store";
import {
  ensureBundleDeliveriesSchema,
  getBundleDeliveriesStore,
  MANUAL_PROVIDER_ID,
  type BundleDeliveryRecord,
} from "./bundle-delivery";

// ---------------------------------------------------------------------------
// Plain-language answers (constants live here, never in a route file)
// ---------------------------------------------------------------------------

/** The row is already delivered — delivered is terminal (I3). */
export const MARK_ALREADY_DELIVERED_MESSAGE =
  "This top-up is already delivered.";

/** An automatic row in flight; the shop's buttons are Mark and Check status. */
export const MARK_PROCESSING_MESSAGE =
  "This top-up is being sent automatically - use Check status.";

/** A pending row the dispatcher will pick up; marking it by hand would race it. */
export const MARK_PENDING_AUTOMATIC_MESSAGE =
  "This top-up is queued for automatic sending - use Check status.";

/** The row is already failed; there is nothing left to mark. */
export const MARK_ALREADY_FAILED_MESSAGE =
  "This top-up is already marked as failed.";

/** `last_error` when the shop marks a failed top-up without typing a note. */
export const DEFAULT_MARK_FAILED_NOTE = "Marked as not sent by the shop.";

/**
 * Retry on a Starter Shop: there is no automatic provider to retry through,
 * so the shop is told to use the mark buttons instead.
 */
export const SHOP_RETRY_MANUAL_MESSAGE =
  "This shop sends bundles by hand - mark the top-up delivered instead.";

/**
 * Stage 6c rate limits, shared by the shop's delivery routes. Retry and
 * Check status share ONE bucket because both can spend the website's
 * TechChief allowance; marking is its own, cheaper bucket. Both are keyed on
 * the website id (per website, not per person).
 */
export const SHOP_ORDER_DELIVERY_RATE_LIMIT_OPERATION = "shop-order-delivery";
export const SHOP_ORDER_DELIVERY_RATE_LIMIT_PER_HOUR = 40;
export const SHOP_DELIVERY_MARK_RATE_LIMIT_OPERATION = "shop-delivery-mark";
export const SHOP_DELIVERY_MARK_RATE_LIMIT_PER_HOUR = 60;

/** Refused mark: a 409 with one of the sentences above. */
export class ManualDeliveryMarkError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ManualDeliveryMarkError";
  }
}

// ---------------------------------------------------------------------------
// The two atomic writes
// ---------------------------------------------------------------------------

/**
 * Maps a re-read row to the 409 the browser should see after a zero-row
 * UPDATE. Called only when the guarded write matched nothing, so every
 * reachable row state has its own plain sentence.
 */
function refusalFor(
  row: BundleDeliveryRecord | null,
  wanted: "delivered" | "failed",
): Error {
  if (!row) return new NotFoundError();
  if (row.status === "delivered") {
    return new ManualDeliveryMarkError(MARK_ALREADY_DELIVERED_MESSAGE);
  }
  if (row.status === "processing") {
    return new ManualDeliveryMarkError(MARK_PROCESSING_MESSAGE);
  }
  if (row.status === "pending" && row.provider !== MANUAL_PROVIDER_ID) {
    return new ManualDeliveryMarkError(MARK_PENDING_AUTOMATIC_MESSAGE);
  }
  if (row.status === "failed" && wanted === "failed") {
    return new ManualDeliveryMarkError(MARK_ALREADY_FAILED_MESSAGE);
  }
  // Unreachable in practice (the guard would have matched); never 200 anyway.
  return new ManualDeliveryMarkError(
    "This top-up changed while you were marking it. Reload the order and try again.",
  );
}

/**
 * pending+manual → delivered, or failed → delivered, atomically. Sets
 * `delivered_at`, clears `last_error`, and leaves provider, provider
 * reference and attempts exactly as they were — nothing was sent by a
 * provider, a person just confirmed the hand-send.
 */
export async function markDeliveryDeliveredByShop(
  id: string,
): Promise<BundleDeliveryRecord> {
  const now = new Date().toISOString();
  let changed: number;
  if (process.env.DATABASE_URL) {
    const claimed = await getDatabase()
      .update(studioDeliveries)
      .set({
        status: "delivered",
        deliveredAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDeliveries.id, id),
          or(
            and(
              eq(studioDeliveries.status, "pending"),
              eq(studioDeliveries.provider, MANUAL_PROVIDER_ID),
            ),
            eq(studioDeliveries.status, "failed"),
          ),
        ),
      )
      .returning({ id: studioDeliveries.id });
    changed = claimed.length;
  } else {
    const db = getSqliteChatStore();
    ensureBundleDeliveriesSchema(db.connection);
    const result = db.connection
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'delivered', delivered_at = ?, last_error = NULL,
                updated_at = ?
          WHERE id = ?
            AND ((status = 'pending' AND provider = 'manual') OR status = 'failed')`,
      )
      .run(now, now, id);
    changed = Number(result.changes);
  }
  const row = await getBundleDeliveriesStore().getById(id);
  if (changed !== 1 || !row) throw refusalFor(row, "delivered");
  return row;
}

/**
 * pending+manual → failed, atomically. `last_error` becomes the trimmed note
 * or the plain default sentence; provider, provider reference, attempts and
 * `delivered_at` are untouched (a pending manual row never has any).
 */
export async function markDeliveryFailedByShop(
  id: string,
  note: string,
): Promise<BundleDeliveryRecord> {
  const now = new Date().toISOString();
  const error = note.trim() === "" ? DEFAULT_MARK_FAILED_NOTE : note.trim();
  let changed: number;
  if (process.env.DATABASE_URL) {
    const marked = await getDatabase()
      .update(studioDeliveries)
      .set({
        status: "failed",
        lastError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDeliveries.id, id),
          eq(studioDeliveries.status, "pending"),
          eq(studioDeliveries.provider, MANUAL_PROVIDER_ID),
        ),
      )
      .returning({ id: studioDeliveries.id });
    changed = marked.length;
  } else {
    const db = getSqliteChatStore();
    ensureBundleDeliveriesSchema(db.connection);
    const result = db.connection
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'failed', last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND provider = 'manual'`,
      )
      .run(error, now, id);
    changed = Number(result.changes);
  }
  const row = await getBundleDeliveriesStore().getById(id);
  if (changed !== 1 || !row) throw refusalFor(row, "failed");
  return row;
}
