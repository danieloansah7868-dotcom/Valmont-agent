/**
 * Stage 6d — the shop's Sales and margin report (Command Center only).
 *
 * The report is an aggregate of ONE website's own orders and delivery rows:
 * no customer names, no phone numbers, no order ids — the reader never sees
 * an identifier, only the numbers. The definitions below are the contract
 * and are repeated word for word in docs/ARCHITECTURE.md:
 *
 *  - A SALE is an order with `paidAt` set, status not "refunded" and not
 *    "cancelled", payment mode "live". Test-mode paid orders are never
 *    counted in money; their number is reported as `testOrdersExcluded`.
 *  - `orders` = number of sales. `moneyCollected` = sum of `total` over
 *    sales.
 *  - Top-up counts run over the delivery rows of sales: delivered, failed,
 *    in flight (pending or processing).
 *  - The unit price of a row is the order's `lines[row.lineIndex].price` —
 *    the checkout-time snapshot; 0 when the line is missing.
 *  - `costedRows` are delivered rows with a finite `api_price`. `cost` is
 *    the sum of `api_price` over costed rows. `costedRevenue` is the sum of
 *    the unit price over costed rows. `margin` = `costedRevenue` − `cost`.
 *    `marginPercent` = `margin` ÷ `costedRevenue` × 100 (0 when
 *    `costedRevenue` is 0). Cost coverage = { known: costed row count,
 *    delivered: delivered count }.
 *  - perNetwork (mtn, telecel, airteltigo; only networks that appear) and
 *    perBundle (grouped by itemName + network + dataMb, top 10 by delivered
 *    units) carry the same money columns per group.
 *  - Refunded and cancelled orders are excluded everywhere. Failed rows
 *    never count in revenue or cost. Money is in major units, rounded to 2
 *    decimals at the end.
 *
 * The delivery rows are read by this module's own query — chunks of 500
 * order ids, chosen by `DATABASE_URL` exactly like `manual-delivery.ts` —
 * because the shop report needs many orders at once and the
 * `BundleDeliveriesStore` interface (one order at a time) is not widened.
 */

import { inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDeliveries } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";
import { ensureBundleDeliveriesSchema } from "@/lib/studio/bundle-delivery";
import { isBundleNetworkId, type BundleNetworkId } from "@/lib/studio/bundles";
import type { OrderRecord } from "@/lib/studio/orders";

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export const SHOP_REPORT_RANGES = ["today", "7d", "30d", "month"] as const;
export type ShopReportRangeId = (typeof SHOP_REPORT_RANGES)[number];

export const SHOP_REPORT_RANGE_LABELS: Record<ShopReportRangeId, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  month: "This month",
};

/** The default range: the last 30 days. Unknown query values fall back to it. */
export const SHOP_REPORT_DEFAULT_RANGE: ShopReportRangeId = "30d";

export interface ShopReportRangeWindow {
  range: ShopReportRangeId;
  /** Inclusive lower bound for `created_at`, as an ISO timestamp. */
  createdAfter: string;
}

/**
 * Resolves a `?range=` value to a time window. Unknown values fall back to
 * the 30-day default. Ghana is UTC, so "today" and "this month" run on UTC
 * boundaries, which are also the shop's local midnight / month start.
 */
export function resolveShopReportRange(
  value: string | null | undefined,
  now: number = Date.now(),
): ShopReportRangeWindow {
  const range: ShopReportRangeId = SHOP_REPORT_RANGES.includes(
    value as ShopReportRangeId,
  )
    ? (value as ShopReportRangeId)
    : SHOP_REPORT_DEFAULT_RANGE;

  const current = new Date(now);
  let start: Date;
  if (range === "today") {
    start = new Date(
      Date.UTC(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate(),
      ),
    );
  } else if (range === "month") {
    start = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1),
    );
  } else if (range === "7d") {
    start = new Date(now - 7 * 24 * 60 * 60 * 1000);
  } else {
    start = new Date(now - 30 * 24 * 60 * 60 * 1000);
  }
  return { range, createdAfter: start.toISOString() };
}

// ---------------------------------------------------------------------------
// Rows the report needs (narrowed on purpose)
// ---------------------------------------------------------------------------

/** The delivery-row fields the money maths reads — nothing else is loaded. */
export interface ShopReportDeliveryRow {
  orderId: string;
  lineIndex: number;
  itemName: string;
  network: string;
  dataMb: number;
  status: string;
  apiPrice: number | null;
}

const ROW_COLUMNS_SQLITE = `order_id, line_index, item_name, network, data_mb,
  status, api_price`;

interface SqliteReportRow {
  order_id: string;
  line_index: number;
  item_name: string;
  network: string;
  data_mb: number;
  status: string;
  api_price: number | null;
}

function toReportRow(row: SqliteReportRow): ShopReportDeliveryRow {
  return {
    orderId: row.order_id,
    lineIndex: row.line_index,
    itemName: row.item_name,
    network: row.network,
    dataMb: row.data_mb,
    status: row.status,
    apiPrice: row.api_price === null ? null : Number(row.api_price),
  };
}

const CHUNK_SIZE = 500;

/**
 * Reads the delivery rows of the given orders, in chunks of 500 order ids —
 * SQLite with an `IN (...)` query, PostgreSQL with `inArray`, chosen by
 * `DATABASE_URL` exactly like `manual-delivery.ts`. The `BundleDeliveriesStore`
 * interface is deliberately NOT widened; this module owns its own read.
 */
export async function loadDeliveriesForReport(
  orderIds: readonly string[],
): Promise<ShopReportDeliveryRow[]> {
  if (orderIds.length === 0) return [];
  const unique = [...new Set(orderIds)];
  const rows: ShopReportDeliveryRow[] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    if (process.env.DATABASE_URL) {
      const selected = await getDatabase()
        .select({
          orderId: studioDeliveries.orderId,
          lineIndex: studioDeliveries.lineIndex,
          itemName: studioDeliveries.itemName,
          network: studioDeliveries.network,
          dataMb: studioDeliveries.dataMb,
          status: studioDeliveries.status,
          apiPrice: studioDeliveries.apiPrice,
        })
        .from(studioDeliveries)
        .where(inArray(studioDeliveries.orderId, chunk as string[]));
      for (const row of selected) {
        rows.push({
          orderId: row.orderId,
          lineIndex: row.lineIndex,
          itemName: row.itemName,
          network: row.network,
          dataMb: row.dataMb,
          status: row.status,
          // PostgreSQL `numeric` arrives as a string.
          apiPrice:
            row.apiPrice === null || row.apiPrice === undefined
              ? null
              : Number(row.apiPrice),
        });
      }
    } else {
      const db = getSqliteChatStore();
      ensureBundleDeliveriesSchema(db.connection);
      const placeholders = chunk.map(() => "?").join(", ");
      const found = db.connection
        .prepare(
          `SELECT ${ROW_COLUMNS_SQLITE} FROM studio_deliveries
            WHERE order_id IN (${placeholders})`,
        )
        .all(...chunk) as unknown as SqliteReportRow[];
      rows.push(...found.map(toReportRow));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The pure aggregate
// ---------------------------------------------------------------------------

/** Money and percent fields are rounded to 2 decimals at the end. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The one money column set per network and per bundle group. */
export interface ShopReportMarginRow {
  network: BundleNetworkId;
  itemName?: string;
  dataMb?: number;
  deliveredUnits: number;
  /** Unit-price sum over DELIVERED rows of the group. */
  revenue: number;
  /** api_price sum over the group's costed (delivered + priced) rows. */
  cost: number;
  /** The group's costed revenue minus its cost. */
  margin: number;
  /** Delivered rows of the group that carry a finite api_price. */
  costedUnits: number;
}

export interface ShopReport {
  /** Sales in the period: paid, live, not refunded, not cancelled. */
  orders: number;
  /** Paid orders in the period that were TEST mode — never counted in money. */
  testOrdersExcluded: number;
  /** Sum of `total` over sales (what customers paid). */
  moneyCollected: number;
  deliveredTopUps: number;
  failedTopUps: number;
  inFlightTopUps: number;
  /** Delivered rows with a finite api_price ("known" costs). */
  costedTopUps: number;
  /** Sum of api_price over costed rows — what the supplier charged. */
  supplierCost: number;
  /** Sum of unit price over costed rows — what those top-ups sold for. */
  costedRevenue: number;
  margin: number;
  marginPercent: number;
  /** One row per network that delivered something. */
  perNetwork: ShopReportMarginRow[];
  /** Top 10 bundle groups (itemName + network + dataMb) by delivered units. */
  perBundle: ShopReportMarginRow[];
}

/**
 * Builds the report from one website's orders and the delivery rows of those
 * orders. Pure and deterministic — unit-tested on its own in
 * `reports.test.ts`. The money definitions are the ones in the module
 * header; orders whose rows are not sales are excluded from every count.
 */
export function aggregateShopReport(
  orders: readonly OrderRecord[],
  deliveries: readonly ShopReportDeliveryRow[],
): ShopReport {
  // A SALE: paid, live money, never refunded, never cancelled.
  const sales = orders.filter(
    (order) =>
      order.status !== "refunded" &&
      order.status !== "cancelled" &&
      Boolean(order.paidAt) &&
      order.paymentMode === "live",
  );
  const saleIds = new Set(sales.map((order) => order.id));
  const testPaid = orders.filter(
    (order) =>
      order.status !== "refunded" &&
      order.status !== "cancelled" &&
      Boolean(order.paidAt) &&
      order.paymentMode === "test",
  );

  // Order index for snapshot unit prices.
  const priceByOrderLine = new Map<string, Map<number, number>>();
  for (const order of orders) {
    priceByOrderLine.set(
      order.id,
      new Map(order.lines.map((line, index) => [index, line.price])),
    );
  }

  const unitPrice = (row: ShopReportDeliveryRow): number => {
    const lines = priceByOrderLine.get(row.orderId);
    if (!lines) return 0;
    const price = lines.get(row.lineIndex);
    return typeof price === "number" && Number.isFinite(price) ? price : 0;
  };

  let deliveredTopUps = 0;
  let failedTopUps = 0;
  let inFlightTopUps = 0;

  // Costed rows: delivered rows of a sale with a finite api_price.
  const costed: Array<{
    row: ShopReportDeliveryRow;
    price: number;
    cost: number;
  }> = [];

  const networkTotals = new Map<
    BundleNetworkId,
    {
      deliveredUnits: number;
      revenue: number;
      costedRevenue: number;
      cost: number;
      costedUnits: number;
    }
  >();
  const bundleTotals = new Map<
    string,
    {
      key: string;
      itemName: string;
      network: BundleNetworkId;
      dataMb: number;
      deliveredUnits: number;
      revenue: number;
      costedRevenue: number;
      cost: number;
      costedUnits: number;
    }
  >();

  const isCosted = (
    row: ShopReportDeliveryRow,
  ): row is ShopReportDeliveryRow & { apiPrice: number } =>
    row.apiPrice !== null &&
    typeof row.apiPrice === "number" &&
    Number.isFinite(row.apiPrice);

  for (const row of deliveries) {
    if (!saleIds.has(row.orderId)) continue;
    const price = unitPrice(row);
    // A delivery row always carries one of the three catalogue networks on a
    // bundle site; anything else still counts in the totals but can never be
    // grouped into a network or bundle table row.
    const network: BundleNetworkId | null = isBundleNetworkId(row.network)
      ? row.network
      : null;

    if (row.status === "delivered") {
      deliveredTopUps += 1;
      const costedRow = isCosted(row)
        ? { row, price, cost: row.apiPrice }
        : null;
      if (costedRow) costed.push(costedRow);

      if (!network) continue;
      const total = networkTotals.get(network) ?? {
        deliveredUnits: 0,
        revenue: 0,
        costedRevenue: 0,
        cost: 0,
        costedUnits: 0,
      };
      total.deliveredUnits += 1;
      total.revenue += price;
      networkTotals.set(network, total);

      const bundleKey = `${row.network}|${row.dataMb}|${row.itemName}`;
      const bundle = bundleTotals.get(bundleKey) ?? {
        key: bundleKey,
        itemName: row.itemName,
        network,
        dataMb: row.dataMb,
        deliveredUnits: 0,
        revenue: 0,
        costedRevenue: 0,
        cost: 0,
        costedUnits: 0,
      };
      bundle.deliveredUnits += 1;
      bundle.revenue += price;
      bundleTotals.set(bundleKey, bundle);

      if (costedRow) {
        const group = bundleTotals.get(bundleKey)!;
        total.costedRevenue += price;
        total.cost += costedRow.cost;
        total.costedUnits += 1;
        group.costedRevenue += price;
        group.cost += costedRow.cost;
        group.costedUnits += 1;
      }
    } else if (row.status === "failed") {
      failedTopUps += 1;
    } else if (row.status === "pending" || row.status === "processing") {
      inFlightTopUps += 1;
    }
  }

  const moneyCollected = round2(
    sales.reduce((sum, order) => sum + order.total, 0),
  );
  const supplierCost = round2(
    costed.reduce((sum, entry) => sum + entry.cost, 0),
  );
  const costedRevenue = round2(
    costed.reduce((sum, entry) => sum + entry.price, 0),
  );
  const margin = round2(costedRevenue - supplierCost);
  const marginPercent =
    costedRevenue > 0 ? round2((margin / costedRevenue) * 100) : 0;

  // Only networks that actually delivered appear, in the fixed catalogue
  // order mtn → telecel → airteltigo.
  const perNetwork: ShopReportMarginRow[] = (
    ["mtn", "telecel", "airteltigo"] as const
  )
    .filter((network) => (networkTotals.get(network)?.deliveredUnits ?? 0) > 0)
    .map((network) => {
      const total = networkTotals.get(network)!;
      return {
        network,
        deliveredUnits: total.deliveredUnits,
        revenue: round2(total.revenue),
        cost: round2(total.cost),
        margin: round2(total.costedRevenue - total.cost),
        costedUnits: total.costedUnits,
      };
    });

  // Bundle groups with delivered units, top 10 by delivered units.
  const perBundle: ShopReportMarginRow[] = [...bundleTotals.values()]
    .filter((group) => group.deliveredUnits > 0)
    .sort(
      (a, b) =>
        b.deliveredUnits - a.deliveredUnits ||
        a.key.localeCompare(b.key) ||
        a.network.localeCompare(b.network),
    )
    .slice(0, 10)
    .map((group) => ({
      network: group.network,
      itemName: group.itemName,
      dataMb: group.dataMb,
      deliveredUnits: group.deliveredUnits,
      revenue: round2(group.revenue),
      cost: round2(group.cost),
      margin: round2(group.costedRevenue - group.cost),
      costedUnits: group.costedUnits,
    }));

  return {
    orders: sales.length,
    testOrdersExcluded: testPaid.length,
    moneyCollected,
    deliveredTopUps,
    failedTopUps,
    inFlightTopUps,
    costedTopUps: costed.length,
    supplierCost,
    costedRevenue,
    margin,
    marginPercent,
    perNetwork,
    perBundle,
  };
}
