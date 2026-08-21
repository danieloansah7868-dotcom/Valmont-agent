import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioOrders } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";

/**
 * The lifecycle of an order.
 *
 * - `pending`        — created, awaiting an online payment.
 * - `paid`           — payment confirmed by Valmont Pay (or the simulator).
 * - `payment_failed` — the payment attempt was declined or cancelled.
 * - `fulfilled`      — the merchant has delivered/handed over the order.
 * - `cancelled`      — the order was cancelled.
 * - `cod_pending`    — placed as cash on delivery; money is collected on arrival.
 */
export type OrderStatus =
  | "pending"
  | "paid"
  | "payment_failed"
  | "fulfilled"
  | "cancelled"
  | "cod_pending";

/** A single purchased line, snapshotted at checkout time. */
export interface OrderLine {
  itemId: string;
  name: string;
  /** Unit price in major currency units. */
  price: number;
  quantity: number;
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
  paymentMethod: string;
  paymentRef?: string;
  paidAt?: string;
  fulfilledAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
  merchantNote?: string;
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
  paymentMethod: string;
}

const toMinor = (amount: number): number => Math.round(amount * 100);
const toMajor = (minor: number): number => minor / 100;

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
  listForOwner(ownerId: string, limit?: number): Promise<OrderRecord[]>;
  markPaid(
    accessCode: string,
    paymentRef?: string,
  ): Promise<OrderRecord | null>;
  markFailed(accessCode: string): Promise<OrderRecord | null>;
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
  payment_method: string;
  payment_ref: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  merchant_note: string | null;
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
    paymentMethod: row.payment_method,
    paymentRef: row.payment_ref ?? undefined,
    paidAt: row.paid_at ?? undefined,
    fulfilledAt: row.fulfilled_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    merchantNote: row.merchant_note ?? undefined,
  };
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
      payment_method TEXT NOT NULL,
      payment_ref TEXT,
      paid_at TEXT,
      fulfilled_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      merchant_note TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_orders_owner_created ON studio_orders(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS studio_orders_draft ON studio_orders(draft_id);
  `);
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
    this.db
      .prepare(
        `INSERT INTO studio_orders(
          id, owner_id, draft_id, access_code, status, currency,
          subtotal, delivery_fee, total, lines_json,
          customer_name, customer_phone, customer_email, customer_address,
          payment_method, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input.paymentMethod,
        now,
        now,
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

  async listForOwner(ownerId: string, limit = 10): Promise<OrderRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_orders WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(ownerId, limit) as unknown as OrderRow[];
    return rows.map(rowToOrder);
  }

  async markPaid(
    accessCode: string,
    paymentRef?: string,
  ): Promise<OrderRecord | null> {
    const now = new Date().toISOString();
    // Only a pending/failed order moves to paid; a fulfilled or cancelled
    // order is left untouched so a duplicate webhook cannot rewind it.
    this.db
      .prepare(
        `UPDATE studio_orders
            SET status = 'paid', payment_ref = ?, paid_at = ?, updated_at = ?
          WHERE access_code = ? AND status IN ('pending','payment_failed')`,
      )
      .run(paymentRef ?? null, now, now, accessCode);
    return this.getByAccessCode(accessCode);
  }

  async markFailed(accessCode: string): Promise<OrderRecord | null> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE studio_orders
            SET status = 'payment_failed', updated_at = ?
          WHERE access_code = ? AND status = 'pending'`,
      )
      .run(now, accessCode);
    return this.getByAccessCode(accessCode);
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
    paymentMethod: row.paymentMethod,
    paymentRef: row.paymentRef ?? undefined,
    paidAt: row.paidAt?.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    merchantNote: row.merchantNote ?? undefined,
  };
}

export class PostgresOrdersStore implements OrdersStore {
  async create(input: NewOrderInput): Promise<OrderRecord> {
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
        paymentMethod: input.paymentMethod,
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

  async listForOwner(ownerId: string, limit = 10): Promise<OrderRecord[]> {
    const rows = await getDatabase()
      .select()
      .from(studioOrders)
      .where(eq(studioOrders.ownerId, ownerId))
      .orderBy(desc(studioOrders.createdAt))
      .limit(limit);
    return rows.map(pgRowToOrder);
  }

  async markPaid(
    accessCode: string,
    paymentRef?: string,
  ): Promise<OrderRecord | null> {
    // Only a pending/failed order moves to paid; a fulfilled or cancelled
    // order is left untouched so a duplicate webhook cannot rewind it.
    await getDatabase()
      .update(studioOrders)
      .set({
        status: "paid",
        paymentRef: paymentRef ?? null,
        paidAt: new Date(),
        updatedAt: new Date(),
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
    await getDatabase()
      .update(studioOrders)
      .set({ status: "payment_failed", updatedAt: new Date() })
      .where(
        and(
          eq(studioOrders.accessCode, accessCode),
          eq(studioOrders.status, "pending"),
        ),
      );
    return this.getByAccessCode(accessCode);
  }
}

export function getOrdersStore(): OrdersStore {
  if (process.env.DATABASE_URL) return new PostgresOrdersStore();
  return new SqliteOrdersStore();
}
