import type { OrderRecord, OrderStatus } from "./orders";

export const ACCRA_TIME_ZONE = "Africa/Accra";

export const ANALYTICS_DATE_RANGES = [
  { id: "all", label: "All time", days: undefined },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
] as const;

export type AnalyticsDateRange = (typeof ANALYTICS_DATE_RANGES)[number]["id"];

const SETTLED_STATUSES: readonly OrderStatus[] = [
  "paid",
  "preparing",
  "out_for_delivery",
  "delivered",
  "fulfilled",
];

const REVENUE_STATUSES: readonly OrderStatus[] = [
  ...SETTLED_STATUSES,
  "refunded",
];

const ACCRA_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ACCRA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const ACCRA_HOUR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: ACCRA_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

export interface StudioAnalytics {
  /** Settled orders only; refunded orders are not counted here. */
  paidOrders: number;
  /**
   * Orders placed through the local payment simulator (test mode). They are
   * never counted in any figure above or below; the count is reported so the
   * merchant knows practice orders exist and were deliberately left out.
   */
  excludedTestOrders: number;
  /** Net sales: settled sales less full refunds. */
  paidRevenue: number;
  /** Sales before subtracting full refunds. */
  grossRevenue: number;
  /** Full-refund value; partial refunds are not represented by the order model. */
  refundedRevenue: number;
  refundedOrders: number;
  averageOrderValue: number;
  topItems: Array<{ name: string; quantity: number; revenue: number }>;
  paymentMethods: Array<{ method: string; orders: number; revenue: number }>;
  busiestHours: Array<{ hour: number; orders: number }>;
}

export interface AnalyticsOrderFilters {
  draftId?: string;
  dateRange?: AnalyticsDateRange;
  /** Injectable clock for deterministic tests; defaults to the current time. */
  now?: Date;
}

function isOneOfStatuses(
  status: OrderStatus,
  statuses: readonly OrderStatus[],
): boolean {
  return statuses.includes(status);
}

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

/** Returns an ISO calendar date in Ghana time, or null for an invalid timestamp. */
export function accraDateKey(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = ACCRA_DATE_FORMATTER.formatToParts(date);
  const year = part(parts, "year");
  const month = part(parts, "month");
  const day = part(parts, "day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function accraHour(value: string): number | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hour = Number(part(ACCRA_HOUR_FORMATTER.formatToParts(date), "hour"));
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
}

function addCalendarDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isAnalyticsDateRange(
  value: string | undefined,
): value is AnalyticsDateRange {
  return ANALYTICS_DATE_RANGES.some((range) => range.id === value);
}

/**
 * Returns the inclusive start date for a range, using Accra calendar days.
 * `all` has no lower bound and therefore returns null.
 */
export function analyticsRangeStart(
  range: AnalyticsDateRange,
  now = new Date(),
): string | null {
  const selected = ANALYTICS_DATE_RANGES.find((item) => item.id === range);
  if (!selected?.days) return null;

  const today = accraDateKey(now);
  if (!today) return null;
  return addCalendarDays(today, -(selected.days - 1));
}

/**
 * Returns the exclusive UTC timestamp after the current Accra calendar day.
 * Accra is UTC, so this can be used directly by the database query without
 * changing the meaning of a date selected in the analytics UI.
 */
export function analyticsRangeEndExclusive(now = new Date()): string | null {
  const today = accraDateKey(now);
  if (!today) return null;
  return `${addCalendarDays(today, 1)}T00:00:00.000Z`;
}

/**
 * Applies the owner-selected website and date filters before summarising.
 * Ownership is enforced by OrdersStore; this function only narrows the data it
 * receives and is deliberately pure.
 */
export function filterAnalyticsOrders(
  orders: readonly OrderRecord[],
  filters: AnalyticsOrderFilters = {},
): OrderRecord[] {
  const range = filters.dateRange ?? "all";
  const now = filters.now ?? new Date();
  const end = accraDateKey(now);
  const start = analyticsRangeStart(range, now);

  return orders.filter((order) => {
    if (filters.draftId && order.draftId !== filters.draftId) return false;
    if (!start || !end) return true;

    const created = accraDateKey(order.createdAt);
    return created !== null && created >= start && created <= end;
  });
}

/**
 * Summarises settled orders only. Pending, cash-on-delivery awaiting
 * collection, cancelled and failed orders never inflate sales. A refunded
 * order is treated as a full refund because the order model stores no partial
 * refund amount.
 */
export function summariseOrders(
  allOrders: readonly OrderRecord[],
): StudioAnalytics {
  // Simulator orders represent no money. They are dropped before any
  // counting so a merchant practising in test mode cannot mistake pretend
  // payments for sales.
  const orders = allOrders.filter((order) => order.paymentMode !== "test");
  const excludedTestOrders = allOrders.length - orders.length;
  const settled = orders.filter((order) =>
    isOneOfStatuses(order.status, SETTLED_STATUSES),
  );
  const refunded = orders.filter((order) => order.status === "refunded");
  const revenueOrders = orders.filter((order) =>
    isOneOfStatuses(order.status, REVENUE_STATUSES),
  );
  const itemTotals = new Map<string, { quantity: number; revenue: number }>();
  const methods = new Map<string, { orders: number; revenue: number }>();
  const hours = new Map<number, number>();
  const grossRevenue = revenueOrders.reduce(
    (sum, order) => sum + order.total,
    0,
  );
  const refundedRevenue = refunded.reduce((sum, order) => sum + order.total, 0);
  const paidRevenue = grossRevenue - refundedRevenue;

  for (const order of settled) {
    const method = methods.get(order.paymentMethod) ?? {
      orders: 0,
      revenue: 0,
    };
    method.orders += 1;
    method.revenue += order.total;
    methods.set(order.paymentMethod, method);

    const hour = accraHour(order.createdAt);
    if (hour !== null) hours.set(hour, (hours.get(hour) ?? 0) + 1);

    for (const line of order.lines) {
      const item = itemTotals.get(line.name) ?? { quantity: 0, revenue: 0 };
      item.quantity += line.quantity;
      item.revenue += line.quantity * line.price;
      itemTotals.set(line.name, item);
    }
  }

  return {
    paidOrders: settled.length,
    excludedTestOrders,
    paidRevenue,
    grossRevenue,
    refundedRevenue,
    refundedOrders: refunded.length,
    averageOrderValue: settled.length ? paidRevenue / settled.length : 0,
    topItems: [...itemTotals.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)),
    paymentMethods: [...methods.entries()]
      .map(([method, value]) => ({ method, ...value }))
      .sort(
        (a, b) => b.revenue - a.revenue || a.method.localeCompare(b.method),
      ),
    busiestHours: [...hours.entries()]
      .map(([hour, orders]) => ({ hour, orders }))
      .sort((a, b) => b.orders - a.orders || a.hour - b.hour),
  };
}
