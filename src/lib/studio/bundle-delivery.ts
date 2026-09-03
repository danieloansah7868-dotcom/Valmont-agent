/**
 * Data-bundles Stage 4 — the bundle delivery engine (simulator first).
 *
 * When a bundle order is paid, the engine turns every purchased bundle UNIT
 * into a delivery row and asks a provider to top up the recipient's phone.
 * Two providers exist today:
 *
 *  - {@link SimulatedProvider} (default): accepts every top-up as
 *    "processing" and reports it "delivered" on the next status check, so the
 *    whole lifecycle is exercisable with no external account and no real data
 *    moving — the exact analogue of the payment simulator. Test hooks:
 *    a recipient ending `0000` always fails; one ending `9999` stays
 *    "processing" for 60 seconds, so "Failed → Retry" and slow delivery can
 *    be rehearsed by hand.
 *  - {@link TechChiefProvider}: a stub. The TechChief integration document
 *    (API spec, auth, pricing, callback format) has not landed (Stage 5), so
 *    every send fails fast with an owner-visible error instead of pretending
 *    to deliver. Nothing in the codebase substitutes for that document.
 *
 * The engine is held to six invariants. Each has a dedicated test in
 * `bundle-delivery.test.ts`:
 *
 *  I1  Paid-first, and live-money safety. No delivery row is created and the
 *      provider is never called before the order is paid. And when an order
 *      was paid with REAL money (`payment_mode === "live"`), the engine only
 *      dispatches through a provider that is itself live — until a real
 *      provider key exists (Stage 5), checkout refuses live bundle orders
 *      with 409 before any order row, and the engine's backstop records a
 *      failed row saying nothing was sent rather than dispatching through
 *      the simulator.
 *  I2  Idempotent, also under concurrency. Exactly one delivery row per
 *      purchased bundle unit, guaranteed by the unique
 *      (order_id, line_index, unit_index) index, and a row is handed to the
 *      provider exactly once per attempt: `claimForDispatch` moves
 *      pending|failed → processing atomically, so a webhook replay and a
 *      simultaneous customer page load can never both send the same unit.
 *  I3  Terminal success. "delivered" is final. Rechecks, retries and
 *      provider callbacks never move, modify or re-dispatch a delivered row.
 *  I4  Isolated failure. A provider failure is recorded on the row
 *      (status "failed" + an owner-readable error, and an aggregated
 *      merchant alert) and is never thrown back into the caller: the payment
 *      webhook still answers 200 and the order stays paid. Only "failed"
 *      rows can be retried, and only by the owner.
 *  I5  Bundle-only. Deliveries exist only for data-bundles orders (recipient
 *      phone + resolvable bundle lines). Every other website type is
 *      untouched — no rows, no provider calls, no rendering changes, no
 *      alerts.
 *  I6  Guest privacy. Unauthenticated surfaces show one masked aggregate line
 *      ("3GB of data to 024 ••• 0001 — delivered"). Full numbers, provider
 *      references, attempt counts and error text appear only on the
 *      authenticated owner page and in the merchant's own alert.
 *
 * Entry points:
 *
 *  - {@link dispatchBundleDeliveriesForOrder} — fired (fire-and-forget) by
 *    the payments webhook right after an order flips to "paid".
 *  - {@link recheckBundleDeliveriesForOrder} — runs on order-page loads:
 *    creates missing rows for a paid order (recovery after an outage),
 *    flushes any rows stuck at "pending", and asks the provider about rows
 *    at "processing". Never throws, so a page can never break on delivery.
 *  - {@link retryBundleDeliveryFailures} — the owner's Retry action for rows
 *    at "failed".
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDeliveries } from "@/db/schema";
import { ConflictError } from "@/lib/api-errors";
import { getSqliteChatStore } from "@/lib/chat-store";
import {
  formatDataMb,
  getBundleNetwork,
  guessDataMbFromItem,
  isBundleNetworkId,
  isValidGhanaMobile,
  maskGhanaMobile,
  type BundleNetworkId,
} from "./bundles";
import { publicGetDraft } from "./draft-public";
import {
  notifyMerchantDeliveryFailed,
  type MerchantDeliveryFailureInput,
} from "./notifications";
import {
  getOrdersStore,
  type OrderLine,
  type OrderRecord,
  type OrdersStore,
  type OrderStatus,
} from "./orders";
import type { CatalogItem } from "./site-brief/schema";

// ---------------------------------------------------------------------------
// Records and statuses
// ---------------------------------------------------------------------------

export const DELIVERY_STATUSES = [
  "pending",
  "processing",
  "delivered",
  "failed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return (
    typeof value === "string" &&
    (DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** Plain-language labels for the owner panel. */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Waiting to send",
  processing: "Sending",
  delivered: "Delivered",
  failed: "Failed",
};

/** One purchased bundle unit that the provider must top up. */
export interface BundleDeliveryRecord {
  id: string;
  orderId: string;
  ownerId: string;
  /** Position of the order line and of the unit inside that line. */
  lineIndex: number;
  unitIndex: number;
  /** Catalogue line id and display name, snapshotted at dispatch time. */
  itemId: string;
  itemName: string;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
  /** Full recipient number — server-side only; guest pages mask it (I6). */
  recipientPhone: string;
  /** Provider id that made the latest dispatch attempt. */
  provider: string;
  status: DeliveryStatus;
  attempts: number;
  providerRef?: string;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields needed to open a delivery row. Status starts at "pending". */
export interface NewBundleDeliveryInput {
  orderId: string;
  ownerId: string;
  lineIndex: number;
  unitIndex: number;
  itemId: string;
  itemName: string;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
  recipientPhone: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** What the engine hands to a provider for one top-up (one bundle unit). */
export interface BundleDeliveryDispatchRequest {
  orderId: string;
  deliveryId: string;
  /** 1-based attempt number (a retry is attempt ≥ 2). */
  attempt: number;
  /** Which order line and unit this top-up covers — a natural idempotency key. */
  lineIndex: number;
  unitIndex: number;
  recipientPhone: string;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
}

export type BundleDeliverySendResult =
  { ok: true; providerRef?: string } | { ok: false; error: string };

export interface BundleDeliveryStatusRequest {
  providerRef: string;
}

export type BundleDeliveryStatusResult =
  | { status: "processing" }
  | { status: "delivered" }
  | { status: "failed"; error: string };

/**
 * A top-up provider. Implementations must be cheap to construct and must
 * report outcomes through their return values — the engine owns the row
 * lifecycle, and a throw is always recorded as a delivery failure (I4).
 */
export interface BundleDeliveryProvider {
  readonly id: string;
  sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult>;
  checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult>;
}

/** Recipient suffixes the simulator uses to rehearse failure and slowness. */
export const SIMULATED_FAIL_SUFFIX = "0000";
export const SIMULATED_SLOW_SUFFIX = "9999";
/** How long a `9999` top-up reports "processing" after it was accepted. */
export const SIMULATED_SLOW_MS = 60_000;

export const SIMULATED_FAIL_MESSAGE =
  "Simulated failure (test number ending 0000)";

/**
 * The default provider. It accepts every top-up as "processing" and answers
 * the next status check with "delivered" — deterministic, offline, and safe:
 * no real data can ever move while it is active. It exists so owners can
 * rehearse the full paid → top-up → delivered flow before TechChief is
 * connected, exactly like the payment simulator stands in for Valmont Pay.
 *
 * Rehearsal hooks (test numbers only):
 *  - recipient ending {@link SIMULATED_FAIL_SUFFIX}: the send is refused, so
 *    the row goes "failed" and the owner can rehearse the alert and Retry.
 *  - recipient ending {@link SIMULATED_SLOW_SUFFIX}: the send is accepted but
 *    reports "processing" for {@link SIMULATED_SLOW_MS} after acceptance. The
 *    acceptance time is encoded in the provider reference
 *    (`sim-slow-<epochMs>-<uuid>`), so no in-memory state survives a restart.
 */
export class SimulatedProvider implements BundleDeliveryProvider {
  readonly id = "simulator";

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    // The checkout route validates the recipient long before a delivery row
    // exists; this is the last-line check so a malformed legacy row can never
    // be reported as sent.
    if (!isValidGhanaMobile(request.recipientPhone)) {
      return {
        ok: false,
        error: "The recipient is not a valid Ghana mobile number.",
      };
    }
    const cleaned = request.recipientPhone.replace(/[\s\-()]/g, "");
    if (cleaned.endsWith(SIMULATED_FAIL_SUFFIX)) {
      return { ok: false, error: SIMULATED_FAIL_MESSAGE };
    }
    if (cleaned.endsWith(SIMULATED_SLOW_SUFFIX)) {
      return {
        ok: true,
        providerRef: `sim-slow-${Date.now()}-${randomUUID()}`,
      };
    }
    return { ok: true, providerRef: `sim-${randomUUID()}` };
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    const slow = /^sim-slow-(\d+)-/.exec(request.providerRef);
    if (slow) {
      return Date.now() - Number(slow[1]) >= SIMULATED_SLOW_MS
        ? { status: "delivered" }
        : { status: "processing" };
    }
    if (request.providerRef.startsWith("sim-")) {
      return { status: "delivered" };
    }
    return { status: "processing" };
  }
}

export const TECHCHIEF_NOT_CONNECTED_MESSAGE =
  "TechChief delivery is not connected yet: the integration document (API spec, authentication, pricing and callback format) is still pending, so this top-up was not sent. It can be retried once the connection is live.";

/**
 * Stub for the real wholesaler. Until the TechChief integration document
 * arrives (Stage 5) there is no endpoint, credential or callback contract to
 * implement against, so every send fails fast and says why. Selecting
 * `techchief` early therefore produces loud, retryable failures — never a
 * fabricated delivery.
 */
export class TechChiefProvider implements BundleDeliveryProvider {
  readonly id = "techchief";

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    void request;
    return { ok: false, error: TECHCHIEF_NOT_CONNECTED_MESSAGE };
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    void request;
    return { status: "processing" };
  }
}

/**
 * Fail-closed answer to an unknown `BUNDLE_DELIVERY_PROVIDER` value. A typo
 * must never silently fall back to the simulator, or a production deployment
 * could record fake deliveries for real money (the exact failure mode the
 * payments layer refuses with its live-misconfigured rule).
 */
export class MisconfiguredDeliveryProvider implements BundleDeliveryProvider {
  readonly id = "misconfigured";
  constructor(private readonly configuredValue: string) {}

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    void request;
    return {
      ok: false,
      error: `BUNDLE_DELIVERY_PROVIDER is set to an unknown provider "${this.configuredValue}". No top-up was sent; set it to "simulator" or "techchief".`,
    };
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    void request;
    return { status: "processing" };
  }
}

export const BUNDLE_DELIVERY_PROVIDER_ENV = "BUNDLE_DELIVERY_PROVIDER";

/**
 * Resolves the configured provider. Default (unset or "simulator") is the
 * simulated provider; "techchief" selects the Stage 5 stub; anything else
 * fails closed.
 */
export function getBundleDeliveryProvider(): BundleDeliveryProvider {
  const raw = (process.env[BUNDLE_DELIVERY_PROVIDER_ENV] ?? "simulator")
    .trim()
    .toLowerCase();
  if (raw === "" || raw === "simulator") return new SimulatedProvider();
  if (raw === "techchief") return new TechChiefProvider();
  return new MisconfiguredDeliveryProvider(raw);
}

export interface BundleDeliveryAvailability {
  /** Which provider is currently selected ("simulator", "techchief", …). */
  provider: string;
  /**
   * True only when the selected provider moves REAL data for real money.
   * Everything available today — the simulator, the TechChief stub and the
   * misconfigured fail-closed provider — is not live; Stage 5 returns true
   * here once a real TechChief key is provisioned. The checkout route refuses
   * live-money bundle orders while this is false.
   */
  live: boolean;
}

export function bundleDeliveryAvailability(
  provider: BundleDeliveryProvider = getBundleDeliveryProvider(),
): BundleDeliveryAvailability {
  return { provider: provider.id, live: false };
}

/** Status checks go to the provider that owns the row's reference. */
function providerForRow(
  row: BundleDeliveryRecord,
  configured: BundleDeliveryProvider,
): BundleDeliveryProvider | null {
  if (row.provider === configured.id) return configured;
  if (row.provider === "simulator") return new SimulatedProvider();
  if (row.provider === "techchief") return new TechChiefProvider();
  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface BundleDeliveriesStore {
  /**
   * Idempotent row creation (I2): rows that already exist for
   * (order_id, line_index, unit_index) are left alone; returns the full list
   * for the order.
   */
  createMany(inputs: NewBundleDeliveryInput[]): Promise<BundleDeliveryRecord[]>;
  listForOrder(orderId: string): Promise<BundleDeliveryRecord[]>;
  getById(id: string): Promise<BundleDeliveryRecord | null>;
  /**
   * pending | failed → processing, atomically, counting the attempt. Returns
   * true only for the one caller that actually moved the row — the single
   * mechanism that makes a concurrent webhook dispatch and page-load recheck
   * (or two retries) unable to hand the same unit to the provider twice (I2).
   * The provider reference is cleared here and re-set by `setProviderRef`
   * once the provider has accepted the send.
   */
  claimForDispatch(id: string, patch: { provider: string }): Promise<boolean>;
  /** Records the provider's reference after a successful send. */
  setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null>;
  /**
   * → failed: an attempt went wrong (I4). Accepts pending (never-yet-sent
   * rows, e.g. the live-provider backstop), processing and failed (a retry
   * that failed again — the error is refreshed in place). Attempt counting
   * lives in `claimForDispatch`, so this never bumps the counter.
   */
  markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null>;
  /** pending | processing → delivered: terminal (I3); failed rows are not resurrectable — only an explicit retry moves them. */
  markDelivered(id: string): Promise<BundleDeliveryRecord | null>;
}

// ----------------------------- SQLite --------------------------------------

interface DeliveryRow {
  id: string;
  order_id: string;
  owner_id: string;
  line_index: number;
  unit_index: number;
  item_id: string;
  item_name: string;
  network: string;
  data_mb: number;
  validity: string | null;
  recipient_phone: string;
  provider: string;
  status: string;
  attempts: number;
  provider_ref: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDelivery(row: DeliveryRow): BundleDeliveryRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    ownerId: row.owner_id,
    lineIndex: row.line_index,
    unitIndex: row.unit_index,
    itemId: row.item_id,
    itemName: row.item_name,
    network: row.network as BundleNetworkId,
    dataMb: row.data_mb,
    validity: row.validity ?? undefined,
    recipientPhone: row.recipient_phone,
    provider: row.provider,
    status: isDeliveryStatus(row.status) ? row.status : "pending",
    attempts: row.attempts,
    providerRef: row.provider_ref ?? undefined,
    lastError: row.last_error ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates the deliveries table on the shared SQLite connection. Idempotent —
 * safe to call on every store access, like the orders schema.
 */
export function ensureBundleDeliveriesSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_deliveries (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      unit_index INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      network TEXT NOT NULL,
      data_mb INTEGER NOT NULL,
      validity TEXT,
      recipient_phone TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'simulator',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_ref TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_deliveries_order ON studio_deliveries(order_id);
    CREATE INDEX IF NOT EXISTS studio_deliveries_owner_created ON studio_deliveries(owner_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_deliveries_order_line_unit ON studio_deliveries(order_id, line_index, unit_index);
  `);
}

export class SqliteBundleDeliveriesStore implements BundleDeliveriesStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensureBundleDeliveriesSchema(store.connection);
    return store.connection;
  }

  async createMany(
    inputs: NewBundleDeliveryInput[],
  ): Promise<BundleDeliveryRecord[]> {
    if (inputs.length === 0) return [];
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO studio_deliveries(
         id, order_id, owner_id, line_index, unit_index, item_id, item_name,
         network, data_mb, validity, recipient_phone, provider, status,
         attempts, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?)`,
    );
    for (const input of inputs) {
      insert.run(
        randomUUID(),
        input.orderId,
        input.ownerId,
        input.lineIndex,
        input.unitIndex,
        input.itemId,
        input.itemName,
        input.network,
        input.dataMb,
        input.validity ?? null,
        input.recipientPhone,
        input.provider,
        now,
        now,
      );
    }
    return this.listForOrder(inputs[0].orderId);
  }

  async listForOrder(orderId: string): Promise<BundleDeliveryRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_deliveries WHERE order_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(orderId) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  async getById(id: string): Promise<BundleDeliveryRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM studio_deliveries WHERE id = ?")
      .get(id) as unknown as DeliveryRow | undefined;
    return row ? rowToDelivery(row) : null;
  }

  async claimForDispatch(
    id: string,
    patch: { provider: string },
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'processing', provider = ?, provider_ref = NULL,
                last_error = NULL, delivered_at = NULL,
                attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status IN ('pending','failed')`,
      )
      .run(patch.provider, new Date().toISOString(), id);
    return result.changes === 1;
  }

  async setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null> {
    this.db
      .prepare(
        `UPDATE studio_deliveries
            SET provider_ref = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'`,
      )
      .run(providerRef, new Date().toISOString(), id);
    return this.getById(id);
  }

  async markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null> {
    this.db
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'failed', last_error = ?, delivered_at = NULL,
                updated_at = ?
          WHERE id = ? AND status IN ('pending','processing','failed')`,
      )
      .run(patch.error, new Date().toISOString(), id);
    return this.getById(id);
  }

  async markDelivered(id: string): Promise<BundleDeliveryRecord | null> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'delivered', delivered_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','processing')`,
      )
      .run(now, now, id);
    return this.getById(id);
  }
}

// --------------------------- PostgreSQL ------------------------------------

function pgRowToDelivery(
  row: typeof studioDeliveries.$inferSelect,
): BundleDeliveryRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    ownerId: row.ownerId,
    lineIndex: row.lineIndex,
    unitIndex: row.unitIndex,
    itemId: row.itemId,
    itemName: row.itemName,
    network: row.network as BundleNetworkId,
    dataMb: row.dataMb,
    validity: row.validity ?? undefined,
    recipientPhone: row.recipientPhone,
    provider: row.provider,
    status: isDeliveryStatus(row.status) ? row.status : "pending",
    attempts: row.attempts,
    providerRef: row.providerRef ?? undefined,
    lastError: row.lastError ?? undefined,
    deliveredAt: row.deliveredAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresBundleDeliveriesStore implements BundleDeliveriesStore {
  async createMany(
    inputs: NewBundleDeliveryInput[],
  ): Promise<BundleDeliveryRecord[]> {
    if (inputs.length === 0) return [];
    await getDatabase()
      .insert(studioDeliveries)
      .values(
        inputs.map((input) => ({
          orderId: input.orderId,
          ownerId: input.ownerId,
          lineIndex: input.lineIndex,
          unitIndex: input.unitIndex,
          itemId: input.itemId,
          itemName: input.itemName,
          network: input.network,
          dataMb: input.dataMb,
          validity: input.validity ?? null,
          recipientPhone: input.recipientPhone,
          provider: input.provider,
        })),
      )
      .onConflictDoNothing({
        target: [
          studioDeliveries.orderId,
          studioDeliveries.lineIndex,
          studioDeliveries.unitIndex,
        ],
      });
    return this.listForOrder(inputs[0].orderId);
  }

  async listForOrder(orderId: string): Promise<BundleDeliveryRecord[]> {
    const rows = await getDatabase()
      .select()
      .from(studioDeliveries)
      .where(eq(studioDeliveries.orderId, orderId))
      .orderBy(asc(studioDeliveries.createdAt), asc(studioDeliveries.id));
    return rows.map(pgRowToDelivery);
  }

  async getById(id: string): Promise<BundleDeliveryRecord | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioDeliveries)
      .where(eq(studioDeliveries.id, id))
      .limit(1);
    return row ? pgRowToDelivery(row) : null;
  }

  async claimForDispatch(
    id: string,
    patch: { provider: string },
  ): Promise<boolean> {
    const claimed = await getDatabase()
      .update(studioDeliveries)
      .set({
        status: "processing",
        provider: patch.provider,
        providerRef: null,
        lastError: null,
        deliveredAt: null,
        attempts: sql`${studioDeliveries.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDeliveries.id, id),
          inArray(studioDeliveries.status, ["pending", "failed"]),
        ),
      )
      .returning({ id: studioDeliveries.id });
    return claimed.length === 1;
  }

  async setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null> {
    await getDatabase()
      .update(studioDeliveries)
      .set({ providerRef, updatedAt: new Date() })
      .where(
        and(
          eq(studioDeliveries.id, id),
          eq(studioDeliveries.status, "processing"),
        ),
      );
    return this.getById(id);
  }

  async markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null> {
    await getDatabase()
      .update(studioDeliveries)
      .set({
        status: "failed",
        lastError: patch.error,
        deliveredAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDeliveries.id, id),
          inArray(studioDeliveries.status, ["pending", "processing", "failed"]),
        ),
      );
    return this.getById(id);
  }

  async markDelivered(id: string): Promise<BundleDeliveryRecord | null> {
    const now = new Date();
    await getDatabase()
      .update(studioDeliveries)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(
        and(
          eq(studioDeliveries.id, id),
          inArray(studioDeliveries.status, ["pending", "processing"]),
        ),
      );
    return this.getById(id);
  }
}

export function getBundleDeliveriesStore(): BundleDeliveriesStore {
  if (process.env.DATABASE_URL) return new PostgresBundleDeliveriesStore();
  return new SqliteBundleDeliveriesStore();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Injectable seams for tests; production callers use the defaults. */
export interface BundleDeliveryDeps {
  orders?: OrdersStore;
  deliveries?: BundleDeliveriesStore;
  provider?: BundleDeliveryProvider;
  /** Replaces the merchant alert in tests; defaults to the real notifier. */
  notifyDeliveryFailed?: (
    input: MerchantDeliveryFailureInput,
  ) => Promise<unknown>;
}

interface ResolvedBundleLine {
  line: OrderLine;
  lineIndex: number;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
}

/** True when any order line lacks a usable checkout-time bundle snapshot. */
function needsCatalogueFallback(order: OrderRecord): boolean {
  return order.lines.some((line) => {
    const networkOk =
      !!line.bundle?.network && isBundleNetworkId(line.bundle.network);
    const dataOk =
      typeof line.bundle?.dataMb === "number" && line.bundle.dataMb > 0;
    return !networkOk || !dataOk;
  });
}

/**
 * Resolves what each line must deliver. The checkout-time snapshot on the
 * order line is authoritative — a later catalogue edit can never change what
 * a paid order owes the customer. The draft catalogue is only consulted for
 * orders paid before Stage 4 (their lines carry no snapshot yet).
 */
function resolveBundleLines(
  order: OrderRecord,
  draftItems: Map<string, CatalogItem> | null,
): ResolvedBundleLine[] {
  const resolved: ResolvedBundleLine[] = [];
  order.lines.forEach((line, lineIndex) => {
    let network: BundleNetworkId | null = null;
    let dataMb: number | null = null;
    let validity: string | undefined;

    if (line.bundle) {
      if (line.bundle.network && isBundleNetworkId(line.bundle.network)) {
        network = line.bundle.network;
      }
      if (
        typeof line.bundle.dataMb === "number" &&
        Number.isFinite(line.bundle.dataMb) &&
        line.bundle.dataMb > 0
      ) {
        dataMb = Math.round(line.bundle.dataMb);
      }
      validity = line.bundle.validity || undefined;
    }

    if ((!network || !dataMb) && draftItems) {
      const item = draftItems.get(line.itemId);
      if (item) {
        if (!network) network = getBundleNetwork(item);
        if (!dataMb) dataMb = guessDataMbFromItem(item);
        if (!validity) validity = item.bundle?.validity || undefined;
      }
    }

    if (network && dataMb) {
      resolved.push({ line, lineIndex, network, dataMb, validity });
    }
  });
  return resolved;
}

/**
 * Ensures the one-row-per-paid-bundle-unit state exists (I1, I2, I5): every
 * resolved order line is expanded into `quantity` unit rows. Returns null
 * when the order is not deliverable — not paid, no recipient, or not a
 * data-bundles order — so callers share one cheap shape for "nothing to do".
 */
async function ensureBundleDeliveryRows(
  order: OrderRecord,
  provider: BundleDeliveryProvider,
  store: BundleDeliveriesStore,
): Promise<BundleDeliveryRecord[] | null> {
  // I1: payment first. Replay-safe because markPaid only ever transitions
  // pending/payment_failed → paid, so this runs exactly when money arrived.
  if (order.status !== "paid") return null;
  // I5 fast gate: only bundle checkouts ever store a recipient number.
  const recipientPhone = order.recipientPhone;
  if (!recipientPhone) return null;

  let draftItems: Map<string, CatalogItem> | null = null;
  if (needsCatalogueFallback(order)) {
    const draft = await publicGetDraft(order.draftId).catch(() => null);
    // A deleted draft blocks the legacy fallback, never the page or webhook.
    if (!draft) return null;
    // I5 explicit veto behind the legacy path: only data-bundles websites.
    if (draft.brief.category !== "data-bundles") return null;
    draftItems = new Map(draft.brief.items.map((item) => [item.id, item]));
  }

  const resolved = resolveBundleLines(order, draftItems);
  if (resolved.length === 0) return null;

  const inputs: NewBundleDeliveryInput[] = [];
  for (const { line, lineIndex, network, dataMb, validity } of resolved) {
    const quantity =
      Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1;
    for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
      inputs.push({
        orderId: order.id,
        ownerId: order.ownerId,
        lineIndex,
        unitIndex,
        itemId: line.itemId,
        itemName: line.name,
        network,
        dataMb,
        validity,
        recipientPhone,
        provider: provider.id,
      });
    }
  }
  return store.createMany(inputs);
}

/** A provider throw is a delivery failure, never a caller failure (I4). */
async function safeSend(
  provider: BundleDeliveryProvider,
  request: BundleDeliveryDispatchRequest,
): Promise<BundleDeliverySendResult> {
  try {
    return await provider.sendBundle(request);
  } catch {
    return {
      ok: false,
      error:
        "The delivery provider could not be reached. The top-up was not sent.",
    };
  }
}

/** Live-money orders must never be sent through a non-live provider (I1). */
export const NO_LIVE_DELIVERY_PROVIDER_MESSAGE =
  "No real delivery provider is connected; nothing was sent.";

/**
 * What a live-money bundle checkout is told while no live delivery provider
 * exists (Stage 5 makes it live-capable). Shown before any order row exists.
 */
export const LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE =
  "This shop cannot send bundles automatically yet. Please contact the shop.";

interface EnginePassContext {
  provider: BundleDeliveryProvider;
  deliveries: BundleDeliveriesStore;
  /** True when the order was paid with real money but no live provider exists. */
  liveBlocked: boolean;
  /** Rows that entered "failed" during this pass (alert candidates, I4). */
  newlyFailed: BundleDeliveryRecord[];
}

function dispatchRequestFor(
  row: BundleDeliveryRecord,
): BundleDeliveryDispatchRequest {
  return {
    orderId: row.orderId,
    deliveryId: row.id,
    attempt: row.attempts + 1,
    lineIndex: row.lineIndex,
    unitIndex: row.unitIndex,
    recipientPhone: row.recipientPhone,
    network: row.network,
    dataMb: row.dataMb,
    validity: row.validity,
  };
}

/** Sends every "pending" unit row to the provider and records the outcome. */
async function dispatchPendingRows(
  rows: BundleDeliveryRecord[],
  ctx: EnginePassContext,
): Promise<void> {
  for (const row of rows) {
    if (row.status !== "pending") continue;
    if (ctx.liveBlocked) {
      const failed = await ctx.deliveries.markFailed(row.id, {
        error: NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
      });
      if (failed) ctx.newlyFailed.push(failed);
      continue;
    }
    // Claim-before-send: exactly one concurrent caller moves the row to
    // "processing" and gets to send; every loser simply skips this unit (I2).
    if (
      !(await ctx.deliveries.claimForDispatch(row.id, {
        provider: ctx.provider.id,
      }))
    ) {
      continue;
    }
    const result = await safeSend(ctx.provider, dispatchRequestFor(row));
    if (result.ok) {
      await ctx.deliveries.setProviderRef(row.id, result.providerRef ?? null);
    } else {
      const failed = await ctx.deliveries.markFailed(row.id, {
        error: result.error,
      });
      if (failed) ctx.newlyFailed.push(failed);
    }
  }
}

/** Polls the provider for "processing" rows; transient outages are simply retried on the next recheck. */
async function refreshProcessingRows(
  rows: BundleDeliveryRecord[],
  ctx: EnginePassContext,
): Promise<void> {
  if (ctx.liveBlocked) return; // nothing to poll without a live provider
  for (const row of rows) {
    if (row.status !== "processing") continue;
    const rowProvider = providerForRow(row, ctx.provider);
    if (!rowProvider || !row.providerRef) continue;
    let outcome: BundleDeliveryStatusResult;
    try {
      outcome = await rowProvider.checkStatus({
        providerRef: row.providerRef,
      });
    } catch {
      continue;
    }
    if (outcome.status === "delivered") {
      await ctx.deliveries.markDelivered(row.id); // terminal (I3)
    } else if (outcome.status === "failed") {
      const failed = await ctx.deliveries.markFailed(row.id, {
        error: outcome.error || "The delivery provider reported a failure.",
      });
      if (failed) ctx.newlyFailed.push(failed);
    }
  }
}

/**
 * One aggregated merchant alert per engine pass when at least one row
 * entered "failed" during this pass (I4). Rows that were already failed when
 * the pass started are never re-alerted. Alerts are best-effort and can
 * never break the engine — same discipline as the new-order notification.
 */
async function alertMerchantIfNeeded(
  order: OrderRecord,
  ctx: EnginePassContext,
  deps: BundleDeliveryDeps,
): Promise<void> {
  if (ctx.newlyFailed.length === 0) return;
  try {
    const draft = await publicGetDraft(order.draftId).catch(() => null);
    if (!draft) return;
    const total = (await ctx.deliveries.listForOrder(order.id)).length;
    const notify = deps.notifyDeliveryFailed ?? notifyMerchantDeliveryFailed;
    await notify({
      order,
      brief: draft.brief,
      deliveries: ctx.newlyFailed,
      total,
    }).catch(() => "failed");
  } catch {
    /* An alert must never break the engine (I4). */
  }
}

function passContext(
  order: OrderRecord,
  provider: BundleDeliveryProvider,
  deliveries: BundleDeliveriesStore,
): EnginePassContext {
  return {
    provider,
    deliveries,
    liveBlocked:
      order.paymentMode === "live" &&
      !bundleDeliveryAvailability(provider).live,
    newlyFailed: [],
  };
}

/**
 * Creates (idempotently) and dispatches the deliveries for a paid bundle
 * order. Called fire-and-forget by the payments webhook immediately after
 * `markPaid`: the webhook's caller must never wait on — or be failed by — the
 * delivery provider, and replayed webhooks re-run this safely.
 */
export async function dispatchBundleDeliveriesForOrder(
  orderId: string,
  deps: BundleDeliveryDeps = {},
): Promise<BundleDeliveryRecord[]> {
  const orders = deps.orders ?? getOrdersStore();
  const deliveries = deps.deliveries ?? getBundleDeliveriesStore();
  const order = await orders.getById(orderId);
  if (!order) return [];
  const provider = deps.provider ?? getBundleDeliveryProvider();
  const rows = await ensureBundleDeliveryRows(order, provider, deliveries);
  if (!rows) return [];
  const ctx = passContext(order, provider, deliveries);
  await dispatchPendingRows(rows, ctx);
  await alertMerchantIfNeeded(order, ctx, deps);
  return deliveries.listForOrder(order.id);
}

/**
 * Reconciliation pass for order-page loads ("recheckPending"). It recovers
 * rows that could not be created or dispatched when payment landed (process
 * restart, provider outage), flushes anything stuck at "pending", and polls
 * the provider about anything "processing". It never throws: the owner order
 * page and the guest confirmation page render with or without it.
 */
export async function recheckBundleDeliveriesForOrder(
  orderId: string,
  deps: BundleDeliveryDeps = {},
): Promise<BundleDeliveryRecord[]> {
  try {
    const orders = deps.orders ?? getOrdersStore();
    const deliveries = deps.deliveries ?? getBundleDeliveriesStore();
    const order = await orders.getById(orderId);
    if (!order) return [];
    const provider = deps.provider ?? getBundleDeliveryProvider();
    const rows = await ensureBundleDeliveryRows(order, provider, deliveries);
    if (!rows) return [];
    const ctx = passContext(order, provider, deliveries);
    await dispatchPendingRows(rows, ctx);
    await refreshProcessingRows(await deliveries.listForOrder(order.id), ctx);
    await alertMerchantIfNeeded(order, ctx, deps);
    return deliveries.listForOrder(order.id);
  } catch {
    return [];
  }
}

/** Raised when Retry is requested for an order whose payment is not settled. */
export class BundleDeliveryRetryError extends ConflictError {
  constructor(status: OrderStatus) {
    super(
      `Bundle top-ups can only be retried on a paid order; this order is "${status}".`,
    );
    this.name = "BundleDeliveryRetryError";
  }
}

/**
 * The owner's Retry button. Re-dispatches only the rows at "failed" (I4) on
 * an explicit request; rows at "processing" are left to rechecks and rows at
 * "delivered" are never touched (I3). Returns null for a cross-tenant or
 * unknown order — owner scoping happens before any delivery is revealed.
 */
export async function retryBundleDeliveryFailures(
  ownerId: string,
  orderId: string,
  deps: BundleDeliveryDeps = {},
): Promise<{
  order: OrderRecord;
  deliveries: BundleDeliveryRecord[];
} | null> {
  const orders = deps.orders ?? getOrdersStore();
  const deliveries = deps.deliveries ?? getBundleDeliveriesStore();
  const order = await orders.getForOwner(ownerId, orderId);
  if (!order) return null;
  if (order.status !== "paid") throw new BundleDeliveryRetryError(order.status);

  const provider = deps.provider ?? getBundleDeliveryProvider();
  const rows = await deliveries.listForOrder(order.id);
  const ctx = passContext(order, provider, deliveries);
  for (const row of rows) {
    if (row.status !== "failed") continue;
    if (ctx.liveBlocked) {
      // Never pretend a send happened: row stays failed with the reason.
      await deliveries.markFailed(row.id, {
        error: NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
      });
      continue;
    }
    if (!(await deliveries.claimForDispatch(row.id, { provider: provider.id })))
      continue;
    const result = await safeSend(provider, dispatchRequestFor(row));
    if (result.ok) {
      await deliveries.setProviderRef(row.id, result.providerRef ?? null);
    } else {
      const failed = await deliveries.markFailed(row.id, {
        error: result.error,
      });
      if (failed) ctx.newlyFailed.push(failed);
    }
  }
  await alertMerchantIfNeeded(order, ctx, deps);
  return { order, deliveries: await deliveries.listForOrder(order.id) };
}

// ---------------------------------------------------------------------------
// Guest-safe aggregate (I6)
// ---------------------------------------------------------------------------

export interface GuestBundleDeliverySummary {
  totalTopUps: number;
  deliveredTopUps: number;
  failedTopUps: number;
  totalDataMb: number;
  /** The single masked line rendered on the unauthenticated confirmation page. */
  line: string;
}

/**
 * Builds the one aggregate line a guest may see. The input is narrowed to the
 * fields needed, and the recipient reaches the output only through
 * `maskGhanaMobile` — so full phone numbers, provider references, attempt
 * counts and error text cannot leak onto an unauthenticated page (I6).
 */
export function guestBundleDeliverySummary(
  deliveries: ReadonlyArray<Pick<BundleDeliveryRecord, "status" | "dataMb">>,
  recipientPhone: string | null | undefined,
): GuestBundleDeliverySummary | null {
  if (deliveries.length === 0 || !recipientPhone) return null;

  const masked = maskGhanaMobile(recipientPhone);
  const total = deliveries.length;
  const delivered = deliveries.filter(
    (row) => row.status === "delivered",
  ).length;
  const failed = deliveries.filter((row) => row.status === "failed").length;
  const totalDataMb = deliveries.reduce((sum, row) => sum + row.dataMb, 0);
  const size = formatDataMb(totalDataMb);

  let line: string;
  if (delivered === total) {
    line =
      total === 1
        ? `${size} top-up delivered to ${masked}`
        : `All ${total} top-ups (${size}) delivered to ${masked}`;
  } else if (failed > 0 && delivered === 0) {
    line =
      total === 1
        ? `The ${size} top-up for ${masked} hit a problem — the shop can retry it.`
        : `Top-ups for ${masked} hit a problem — the shop can retry them (${size} total).`;
  } else if (failed > 0) {
    line = `${delivered} of ${total} top-ups delivered to ${masked}; ${failed} hit a problem — the shop can retry it.`;
  } else {
    line = `Sending ${size} of data to ${masked} — ${delivered} of ${total} delivered so far.`;
  }

  return {
    totalTopUps: total,
    deliveredTopUps: delivered,
    failedTopUps: failed,
    totalDataMb,
    line,
  };
}
