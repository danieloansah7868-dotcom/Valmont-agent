import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioOrders } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";
import { ConflictError } from "@/lib/api-errors";
import {
  canTransition,
  matchesFilter,
  type OrderFilterId,
  type OrderStatus,
} from "./order-status";

export type { OrderStatus } from "./order-status";

/**
 * Which payment rail an order was created under. `test` orders were paid (or
 * not) through the local simulator and represent no real money; `live` orders
 * went through the hosted Valmont Pay page. Cash-on-delivery and manual
 * methods take no online payment, so they are recorded as `live` — the goods
 * and the cash are real either way. The marker is stamped at checkout and
 * never changes, so a merchant can always tell a practice order from a sale.
 */
export const PAYMENT_MODES = ["test", "live"] as const;
export type OrderPaymentMode = (typeof PAYMENT_MODES)[number];

export function isOrderPaymentMode(value: unknown): value is OrderPaymentMode {
  return value === "test" || value === "live";
}

export interface StatusEvent {
  status: OrderStatus;
  at: string;
}

/** A single purchased line, snapshotted at checkout time. */
export interface OrderLine {
  itemId: string;
  name: string;
  /** Unit price in major currency units. */
  price: number;
  quantity: number;
  /** Optional product photo snapshotted at checkout. */
  image?: string;
}

/** What the checkout endpoint receives from the browser. */
export interface CheckoutPayload {
  lines: Array<{ itemId: string; quantity: number }>;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerAddress?: string;
  paymentMethod: string;
  note?: string;
}

export interface OrderRecord {
  id: string;
  ownerId: string;
  draftId: string;
  accessCode: string;
  status: OrderStatus;
  currency: string;
  /** Amounts here are major currency units (converted from stored minor units). */
  subtotal: number;
  deliveryFee: number;
  total: number;
  lines: OrderLine[];
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerAddress?: string;
  /** Set after an optional customer account claims the order. */
  customerAccountId?: string;
  paymentMethod: string;
  /** Test (simulator) or live rail; see {@link OrderPaymentMode}. */
  paymentMode: OrderPaymentMode;
  paymentRef?: string;
  paidAt?: string;
  fulfilledAt?: string;
  cancelledAt?: string;
  preparingAt?: string;
  outForDeliveryAt?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt: string;
  merchantNote?: string;
  statusHistory: StatusEvent[];
}

/** Fields required to open a new order row. Money is in major units. */
export interface NewOrderInput {
  ownerId: string;
  draftId: string;
  accessCode: string;
  status: OrderStatus;
  currency: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  lines: OrderLine[];
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerAddress?: string;
  customerAccountId?: string;
  paymentMethod: string;
  /** Defaults to `live` when omitted so cash/manual orders are never hidden. */
  paymentMode?: OrderPaymentMode;
  merchantNote?: string;
}

export interface ListOrdersOptions {
  limit?: number;
  filter?: OrderFilterId;
  /** Optional owner-scoped business (draft) filter. */
  draftId?: string;
  /** Inclusive lower bound for created_at, as an ISO timestamp. */
  createdAfter?: string;
  /** Exclusive upper bound for created_at, as an ISO timestamp. */
  createdBefore?: string;
}

const toMinor = (amount: number): number => Math.round(amount * 100);
const toMajor = (minor: number): number => minor / 100;

function parseHistory(
  raw: string | StatusEvent[] | null | undefined,
): StatusEvent[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw) as StatusEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendHistory(
  current: StatusEvent[],
  status: OrderStatus,
  at: string,
): StatusEvent[] {
  return [...current, { status, at }];
}

function timestampPatch(
  status: OrderStatus,
  at: string,
): Partial<
  Pick<
    OrderRecord,
    | "paidAt"
    | "preparingAt"
    | "outForDeliveryAt"
    | "fulfilledAt"
    | "cancelledAt"
    | "refundedAt"
  >
> {
  switch (status) {
    case "paid":
      return { paidAt: at };
    case "preparing":
      return { preparingAt: at };
    case "out_for_delivery":
      return { outForDeliveryAt: at };
    case "delivered":
    case "fulfilled":
      return { fulfilledAt: at };
    case "cancelled":
      return { cancelledAt: at };
    case "refunded":
      return { refundedAt: at };
    default:
      return {};
  }
}

/**
 * Raised when a merchant asks for a status the order cannot move to. A typed
 * 409 so the route returns the explanation instead of an opaque 500 (the
 * strict `safeApiError` trusts only `ApiError` instances).
 */
export class OrderTransitionError extends ConflictError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`This order cannot move from ${from} to ${to}.`);
    this.name = "OrderTransitionError";
  }
}

export interface OrdersStore {
  create(input: NewOrderInput): Promise<OrderRecord>;
  getByAccessCode(accessCode: string): Promise<OrderRecord | null>;
  /**
   * Looks up an order by its unguessable UUID for the public confirmation page.
   * The id is a secret in the same sense the access code is: it is only ever
   * revealed to the customer who placed the order.
   */
  getById(id: string): Promise<OrderRecord | null>;
  getForOwner(ownerId: string, id: string): Promise<OrderRecord | null>;
  getForCustomer(
    customerAccountId: string,
    id: string,
  ): Promise<OrderRecord | null>;
  listForOwner(
    ownerId: string,
    options?: number | ListOrdersOptions,
  ): Promise<OrderRecord[]>;
  listForCustomer(
    customerAccountId: string,
    limit?: number,
  ): Promise<OrderRecord[]>;
  /** Claims only an unclaimed order, or returns the already-linked order. */
  claimForCustomer(
    customerAccountId: string,
    accessCode: string,
  ): Promise<OrderRecord | null>;
  markPaid(
    accessCode: string,
    paymentRef?: string,
  ): Promise<OrderRecord | null>;
  markFailed(accessCode: string): Promise<OrderRecord | null>;
  updateStatus(
    ownerId: string,
    id: string,
    status: OrderStatus,
  ): Promise<OrderRecord | null>;
}

interface NormalizedListOrdersOptions {
  limit: number;
  filter: OrderFilterId;
  draftId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

function normalizeListOptions(
  options?: number | ListOrdersOptions,
): NormalizedListOrdersOptions {
  if (typeof options === "number") {
    return {
      limit: options,
      filter: "all",
      draftId: undefined,
      createdAfter: undefined,
      createdBefore: undefined,
    };
  }
  return {
    limit: options?.limit ?? 10,
    filter: options?.filter ?? "all",
    draftId: options?.draftId,
    createdAfter: options?.createdAfter,
    createdBefore: options?.createdBefore,
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  owner_id: string;
  draft_id: string;
  access_code: string;
  status: string;
  currency: string;
  subtotal: number;
  delivery_fee: number;
  total: number;
  lines_json: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  customer_address: string | null;
  customer_account_id: string | null;
  payment_method: string;
  payment_mode: string | null;
  payment_ref: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  preparing_at: string | null;
  out_for_delivery_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
  merchant_note: string | null;
  status_history_json: string | null;
}

function rowToOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    draftId: row.draft_id,
    accessCode: row.access_code,
    status: row.status as OrderStatus,
    currency: row.currency,
    subtotal: toMajor(row.subtotal),
    deliveryFee: toMajor(row.delivery_fee),
    total: toMajor(row.total),
    lines: JSON.parse(row.lines_json) as OrderLine[],
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email ?? undefined,
    customerAddress: row.customer_address ?? undefined,
    customerAccountId: row.customer_account_id ?? undefined,
    paymentMethod: row.payment_method,
    // Rows written before the column existed were all created by the
    // simulator-era code path; anything unmarked is treated as a real order
    // so no sale can ever be hidden from the merchant.
    paymentMode: isOrderPaymentMode(row.payment_mode)
      ? row.payment_mode
      : "live",
    paymentRef: row.payment_ref ?? undefined,
    paidAt: row.paid_at ?? undefined,
    fulfilledAt: row.fulfilled_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    preparingAt: row.preparing_at ?? undefined,
    outForDeliveryAt: row.out_for_delivery_at ?? undefined,
    refundedAt: row.refunded_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    merchantNote: row.merchant_note ?? undefined,
    statusHistory: parseHistory(row.status_history_json),
  };
}

function ensureColumn(
  db: DatabaseSync,
  name: string,
  definition: string,
  existing: Set<string>,
): void {
  if (existing.has(name)) return;
  db.exec(`ALTER TABLE studio_orders ADD COLUMN ${name} ${definition}`);
}

/**
 * Creates the orders table on the shared SQLite connection if it is missing.
 * Studio stores its drafts on the same file; the orders table lives beside
 * them. Idempotent, so it is safe to call on every store access.
 */
export function ensureOrdersSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_orders (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      access_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      currency TEXT NOT NULL DEFAULT 'GHS',
      subtotal INTEGER NOT NULL DEFAULT 0,
      delivery_fee INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      lines_json TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      customer_address TEXT,
      customer_account_id TEXT,
      payment_method TEXT NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'live',
      payment_ref TEXT,
      paid_at TEXT,
      fulfilled_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      merchant_note TEXT,
      preparing_at TEXT,
      out_for_delivery_at TEXT,
      refunded_at TEXT,
      status_history_json TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_orders_owner_created ON studio_orders(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS studio_orders_draft ON studio_orders(draft_id);
  `);

  const existing = new Set(
    (
      db.prepare("PRAGMA table_info(studio_orders)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  ensureColumn(db, "preparing_at", "TEXT", existing);
  ensureColumn(db, "out_for_delivery_at", "TEXT", existing);
  ensureColumn(db, "refunded_at", "TEXT", existing);
  ensureColumn(db, "status_history_json", "TEXT", existing);
  ensureColumn(db, "customer_account_id", "TEXT", existing);
  ensureColumn(db, "payment_mode", "TEXT NOT NULL DEFAULT 'live'", existing);
  db.exec(
    "CREATE INDEX IF NOT EXISTS studio_orders_customer_account ON studio_orders(customer_account_id)",
  );
}

export class SqliteOrdersStore implements OrdersStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensureOrdersSchema(store.connection);
    return store.connection;
  }

  async create(input: NewOrderInput): Promise<OrderRecord> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const history = appendHistory([], input.status, now);
    this.db
      .prepare(
        `INSERT INTO studio_orders(
          id, owner_id, draft_id, access_code, status, currency,
          subtotal, delivery_fee, total, lines_json,
          customer_name, customer_phone, customer_email, customer_address,
          customer_account_id, payment_method, payment_mode, merchant_note,
          created_at, updated_at, status_history_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.ownerId,
        input.draftId,
        input.accessCode,
        input.status,
        input.currency,
        toMinor(input.subtotal),
        toMinor(input.deliveryFee),
        toMinor(input.total),
        JSON.stringify(input.lines),
        input.customerName,
        input.customerPhone,
        input.customerEmail ?? null,
        input.customerAddress ?? null,
        input.customerAccountId ?? null,
        input.paymentMethod,
        input.paymentMode ?? "live",
        input.merchantNote ?? null,
        now,
        now,
        JSON.stringify(history),
      );
    const created = await this.getByAccessCode(input.accessCode);
    if (!created) throw new Error("Order could not be created");
    return created;
  }

  async getByAccessCode(accessCode: string): Promise<OrderRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM studio_orders WHERE access_code = ?")
      .get(accessCode) as unknown as OrderRow | undefined;
    return row ? rowToOrder(row) : null;
  }

  async getById(id: string): Promise<OrderRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM studio_orders WHERE id = ?")
      .get(id) as unknown as OrderRow | undefined;
    return row ? rowToOrder(row) : null;
  }

  async getForOwner(ownerId: string, id: string): Promise<OrderRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM studio_orders WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as unknown as OrderRow | undefined;
    return row ? rowToOrder(row) : null;
  }

  async getForCustomer(
    customerAccountId: string,
    id: string,
  ): Promise<OrderRecord | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM studio_orders WHERE id = ? AND customer_account_id = ?",
      )
      .get(id, customerAccountId) as unknown as OrderRow | undefined;
    return row ? rowToOrder(row) : null;
  }

  async listForOwner(
    ownerId: string,
    options?: number | ListOrdersOptions,
  ): Promise<OrderRecord[]> {
    const { limit, filter, draftId, createdAfter, createdBefore } =
      normalizeListOptions(options);
    const conditions = ["owner_id = ?"];
    const parameters: Array<string | number> = [ownerId];
    if (draftId) {
      conditions.push("draft_id = ?");
      parameters.push(draftId);
    }
    if (createdAfter) {
      conditions.push("created_at >= ?");
      parameters.push(createdAfter);
    }
    if (createdBefore) {
      conditions.push("created_at < ?");
      parameters.push(createdBefore);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM studio_orders WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...parameters, Math.max(limit, 200)) as unknown as OrderRow[];
    const mapped = rows.map(rowToOrder);
    const filtered =
      filter === "all"
        ? mapped
        : mapped.filter((order) => matchesFilter(order.status, filter));
    return filtered.slice(0, limit);
  }

  async listForCustomer(
    customerAccountId: string,
    limit = 50,
  ): Promise<OrderRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_orders WHERE customer_account_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(customerAccountId, boundedLimit) as unknown as OrderRow[];
    return rows.map(rowToOrder);
  }

  async claimForCustomer(
    customerAccountId: string,
    accessCode: string,
  ): Promise<OrderRecord | null> {
    const existing = await this.getByAccessCode(accessCode);
    if (!existing) return null;
    if (
      existing.customerAccountId &&
      existing.customerAccountId !== customerAccountId
    ) {
      return null;
    }
    if (!existing.customerAccountId) {
      this.db
        .prepare(
          `UPDATE studio_orders
              SET customer_account_id = ?, updated_at = ?
            WHERE access_code = ? AND customer_account_id IS NULL`,
        )
        .run(customerAccountId, new Date().toISOString(), accessCode);
    }
    const claimed = await this.getByAccessCode(accessCode);
    return claimed?.customerAccountId === customerAccountId ? claimed : null;
  }

  async markPaid(
    accessCode: string,
    paymentRef?: string,
  ): Promise<OrderRecord | null> {
    const existing = await this.getByAccessCode(accessCode);
    if (!existing) return null;
    if (existing.status !== "pending" && existing.status !== "payment_failed") {
      return existing;
    }
    const now = new Date().toISOString();
    const history = appendHistory(existing.statusHistory, "paid", now);
    this.db
      .prepare(
        `UPDATE studio_orders
            SET status = 'paid', payment_ref = ?, paid_at = ?, updated_at = ?,
                status_history_json = ?
          WHERE access_code = ? AND status IN ('pending','payment_failed')`,
      )
      .run(paymentRef ?? null, now, now, JSON.stringify(history), accessCode);
    return this.getByAccessCode(accessCode);
  }

  async markFailed(accessCode: string): Promise<OrderRecord | null> {
    const existing = await this.getByAccessCode(accessCode);
    if (!existing) return null;
    if (existing.status !== "pending") return existing;
    const now = new Date().toISOString();
    const history = appendHistory(
      existing.statusHistory,
      "payment_failed",
      now,
    );
    this.db
      .prepare(
        `UPDATE studio_orders
            SET status = 'payment_failed', updated_at = ?, status_history_json = ?
          WHERE access_code = ? AND status = 'pending'`,
      )
      .run(now, JSON.stringify(history), accessCode);
    return this.getByAccessCode(accessCode);
  }

  async updateStatus(
    ownerId: string,
    id: string,
    status: OrderStatus,
  ): Promise<OrderRecord | null> {
    const existing = await this.getForOwner(ownerId, id);
    if (!existing) return null;
    if (existing.status === status) return existing;
    if (!canTransition(existing.status, status)) {
      throw new OrderTransitionError(existing.status, status);
    }
    const now = new Date().toISOString();
    const history = appendHistory(existing.statusHistory, status, now);
    const stamps = timestampPatch(status, now);
    this.db
      .prepare(
        `UPDATE studio_orders
            SET status = ?, updated_at = ?, status_history_json = ?,
                preparing_at = COALESCE(?, preparing_at),
                out_for_delivery_at = COALESCE(?, out_for_delivery_at),
                fulfilled_at = COALESCE(?, fulfilled_at),
                cancelled_at = COALESCE(?, cancelled_at),
                refunded_at = COALESCE(?, refunded_at)
          WHERE id = ? AND owner_id = ?`,
      )
      .run(
        status,
        now,
        JSON.stringify(history),
        stamps.preparingAt ?? null,
        stamps.outForDeliveryAt ?? null,
        stamps.fulfilledAt ?? null,
        stamps.cancelledAt ?? null,
        stamps.refundedAt ?? null,
        id,
        ownerId,
      );
    return this.getForOwner(ownerId, id);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function pgRowToOrder(row: typeof studioOrders.$inferSelect): OrderRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    draftId: row.draftId,
    accessCode: row.accessCode,
    status: row.status as OrderStatus,
    currency: row.currency,
    subtotal: toMajor(row.subtotal),
    deliveryFee: toMajor(row.deliveryFee),
    total: toMajor(row.total),
    lines: row.linesJson as OrderLine[],
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail ?? undefined,
    customerAddress: row.customerAddress ?? undefined,
    customerAccountId: row.customerAccountId ?? undefined,
    paymentMethod: row.paymentMethod,
    paymentMode: isOrderPaymentMode(row.paymentMode) ? row.paymentMode : "live",
    paymentRef: row.paymentRef ?? undefined,
    paidAt: row.paidAt?.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString(),
    preparingAt: row.preparingAt?.toISOString(),
    outForDeliveryAt: row.outForDeliveryAt?.toISOString(),
    refundedAt: row.refundedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    merchantNote: row.merchantNote ?? undefined,
    statusHistory: parseHistory(row.statusHistory as StatusEvent[] | null),
  };
}

export class PostgresOrdersStore implements OrdersStore {
  async create(input: NewOrderInput): Promise<OrderRecord> {
    const now = new Date();
    const [row] = await getDatabase()
      .insert(studioOrders)
      .values({
        ownerId: input.ownerId,
        draftId: input.draftId,
        accessCode: input.accessCode,
        status: input.status,
        currency: input.currency,
        subtotal: toMinor(input.subtotal),
        deliveryFee: toMinor(input.deliveryFee),
        total: toMinor(input.total),
        linesJson: input.lines,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerEmail: input.customerEmail ?? null,
        customerAddress: input.customerAddress ?? null,
        customerAccountId: input.customerAccountId ?? null,
        paymentMethod: input.paymentMethod,
        paymentMode: input.paymentMode ?? "live",
        merchantNote: input.merchantNote ?? null,
        statusHistory: appendHistory([], input.status, now.toISOString()),
      })
      .returning();
    return pgRowToOrder(row!);
  }

  async getByAccessCode(accessCode: string): Promise<OrderRecord | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioOrders)
      .where(eq(studioOrders.accessCode, accessCode))
      .limit(1);
    return row ? pgRowToOrder(row) : null;
  }

  async getById(id: string): Promise<OrderRecord | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioOrders)
      .where(eq(studioOrders.id, id))
      .limit(1);
    return row ? pgRowToOrder(row) : null;
  }

  async getForOwner(ownerId: string, id: string): Promise<OrderRecord | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioOrders)
      .where(and(eq(studioOrders.id, id), eq(studioOrders.ownerId, ownerId)))
      .limit(1);
    return row ? pgRowToOrder(row) : null;
  }

  async getForCustomer(
    customerAccountId: string,
    id: string,
  ): Promise<OrderRecord | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioOrders)
      .where(
        and(
          eq(studioOrders.id, id),
          eq(studioOrders.customerAccountId, customerAccountId),
        ),
      )
      .limit(1);
    return row ? pgRowToOrder(row) : null;
  }

  async listForOwner(
    ownerId: string,
    options?: number | ListOrdersOptions,
  ): Promise<OrderRecord[]> {
    const { limit, filter, draftId, createdAfter, createdBefore } =
      normalizeListOptions(options);
    const conditions = [eq(studioOrders.ownerId, ownerId)];
    if (draftId) conditions.push(eq(studioOrders.draftId, draftId));
    if (createdAfter) {
      conditions.push(gte(studioOrders.createdAt, new Date(createdAfter)));
    }
    if (createdBefore) {
      conditions.push(lt(studioOrders.createdAt, new Date(createdBefore)));
    }
    const rows = await getDatabase()
      .select()
      .from(studioOrders)
      .where(and(...conditions))
      .orderBy(desc(studioOrders.createdAt))
      .limit(Math.max(limit, 200));
    const mapped = rows.map(pgRowToOrder);
    const filtered =
      filter === "all"
        ? mapped
        : mapped.filter((order) => matchesFilter(order.status, filter));
    return filtered.slice(0, limit);
  }

  async listForCustomer(
    customerAccountId: string,
    limit = 50,
  ): Promise<OrderRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const rows = await getDatabase()
      .select()
      .from(studioOrders)
      .where(eq(studioOrders.customerAccountId, customerAccountId))
      .orderBy(desc(studioOrders.createdAt))
      .limit(boundedLimit);
    return rows.map(pgRowToOrder);
  }

  async claimForCustomer(
    customerAccountId: string,
    accessCode: string,
  ): Promise<OrderRecord | null> {
    await getDatabase()
      .update(studioOrders)
      .set({ customerAccountId })
      .where(
        and(
          eq(studioOrders.accessCode, accessCode),
          or(
            isNull(studioOrders.customerAccountId),
            eq(studioOrders.customerAccountId, customerAccountId),
          ),
        ),
      );
    const claimed = await this.getByAccessCode(accessCode);
    return claimed?.customerAccountId === customerAccountId ? claimed : null;
  }

  async markPaid(
    accessCode: string,
    paymentRef?: string,
  ): Promise<OrderRecord | null> {
    const existing = await this.getByAccessCode(accessCode);
    if (!existing) return null;
    if (existing.status !== "pending" && existing.status !== "payment_failed") {
      return existing;
    }
    const now = new Date();
    await getDatabase()
      .update(studioOrders)
      .set({
        status: "paid",
        paymentRef: paymentRef ?? null,
        paidAt: now,
        updatedAt: now,
        statusHistory: appendHistory(
          existing.statusHistory,
          "paid",
          now.toISOString(),
        ),
      })
      .where(
        and(
          eq(studioOrders.accessCode, accessCode),
          inArray(studioOrders.status, ["pending", "payment_failed"]),
        ),
      );
    return this.getByAccessCode(accessCode);
  }

  async markFailed(accessCode: string): Promise<OrderRecord | null> {
    const existing = await this.getByAccessCode(accessCode);
    if (!existing) return null;
    if (existing.status !== "pending") return existing;
    const now = new Date();
    await getDatabase()
      .update(studioOrders)
      .set({
        status: "payment_failed",
        updatedAt: now,
        statusHistory: appendHistory(
          existing.statusHistory,
          "payment_failed",
          now.toISOString(),
        ),
      })
      .where(
        and(
          eq(studioOrders.accessCode, accessCode),
          eq(studioOrders.status, "pending"),
        ),
      );
    return this.getByAccessCode(accessCode);
  }

  async updateStatus(
    ownerId: string,
    id: string,
    status: OrderStatus,
  ): Promise<OrderRecord | null> {
    const existing = await this.getForOwner(ownerId, id);
    if (!existing) return null;
    if (existing.status === status) return existing;
    if (!canTransition(existing.status, status)) {
      throw new OrderTransitionError(existing.status, status);
    }
    const now = new Date();
    const stamps = timestampPatch(status, now.toISOString());
    await getDatabase()
      .update(studioOrders)
      .set({
        status,
        updatedAt: now,
        statusHistory: appendHistory(
          existing.statusHistory,
          status,
          now.toISOString(),
        ),
        preparingAt: stamps.preparingAt
          ? new Date(stamps.preparingAt)
          : undefined,
        outForDeliveryAt: stamps.outForDeliveryAt
          ? new Date(stamps.outForDeliveryAt)
          : undefined,
        fulfilledAt: stamps.fulfilledAt
          ? new Date(stamps.fulfilledAt)
          : undefined,
        cancelledAt: stamps.cancelledAt
          ? new Date(stamps.cancelledAt)
          : undefined,
        refundedAt: stamps.refundedAt ? new Date(stamps.refundedAt) : undefined,
      })
      .where(and(eq(studioOrders.id, id), eq(studioOrders.ownerId, ownerId)));
    return this.getForOwner(ownerId, id);
  }
}

export function getOrdersStore(): OrdersStore {
  if (process.env.DATABASE_URL) return new PostgresOrdersStore();
  return new SqliteOrdersStore();
}
