/**
 * The lifecycle of an order.
 *
 * - `pending`           — created, awaiting an online payment.
 * - `paid`              — payment confirmed by Valmont Pay (or the simulator).
 * - `payment_failed`    — the payment attempt was declined or cancelled.
 * - `cod_pending`       — placed as cash on delivery; money is collected on arrival.
 * - `preparing`         — the merchant has started the order.
 * - `out_for_delivery`  — on the way to the customer.
 * - `delivered`         — handed over. `fulfilled` is the Phase 3 alias.
 * - `cancelled` / `refunded`
 */
export const ALL_ORDER_STATUSES = [
  "pending",
  "paid",
  "payment_failed",
  "cod_pending",
  "preparing",
  "out_for_delivery",
  "delivered",
  "fulfilled",
  "cancelled",
  "refunded",
] as const;

export type OrderStatus = (typeof ALL_ORDER_STATUSES)[number];

/** Plain-language labels for every order status shown to a person. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Awaiting payment",
  paid: "Paid",
  payment_failed: "Payment failed",
  fulfilled: "Delivered",
  cancelled: "Cancelled",
  cod_pending: "Cash on delivery",
  preparing: "Preparing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  refunded: "Refunded",
};

export const STATUS_BADGE_CLASS: Record<string, string> = {
  paid: "bg-green-100 text-green-800",
  delivered: "bg-green-100 text-green-800",
  fulfilled: "bg-green-100 text-green-800",
  preparing: "bg-amber-100 text-amber-900",
  out_for_delivery: "bg-blue-100 text-blue-900",
  pending: "bg-amber-100 text-amber-900",
  cod_pending: "bg-blue-100 text-blue-900",
  payment_failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-700",
  refunded: "bg-slate-200 text-slate-700",
};

export type OrderFilterId =
  | "all"
  | "pending_payment"
  | "paid"
  | "preparing"
  | "out_for_delivery"
  | "delivered"
  | "cancelled";

export const ORDER_FILTERS: Array<{
  id: OrderFilterId;
  label: string;
  statuses: readonly OrderStatus[];
}> = [
  { id: "all", label: "All", statuses: ALL_ORDER_STATUSES },
  {
    id: "pending_payment",
    label: "Pending payment",
    statuses: ["pending", "payment_failed"],
  },
  { id: "paid", label: "Paid", statuses: ["paid", "cod_pending"] },
  { id: "preparing", label: "Preparing", statuses: ["preparing"] },
  {
    id: "out_for_delivery",
    label: "Out for delivery",
    statuses: ["out_for_delivery"],
  },
  { id: "delivered", label: "Delivered", statuses: ["delivered", "fulfilled"] },
  { id: "cancelled", label: "Cancelled", statuses: ["cancelled", "refunded"] },
];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["cancelled"],
  payment_failed: ["cancelled"],
  paid: ["preparing", "cancelled", "refunded"],
  cod_pending: ["preparing", "cancelled"],
  preparing: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered: ["refunded"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export function isOrderStatus(value: string): value is OrderStatus {
  return (ALL_ORDER_STATUSES as readonly string[]).includes(value);
}

export function matchesFilter(
  status: OrderStatus,
  filter: OrderFilterId,
): boolean {
  const entry = ORDER_FILTERS.find((item) => item.id === filter);
  if (!entry || filter === "all") return true;
  return entry.statuses.includes(status);
}

export const ACTION_LABELS: Partial<Record<OrderStatus, string>> = {
  preparing: "Start preparing",
  out_for_delivery: "Out for delivery",
  delivered: "Mark delivered",
  cancelled: "Cancel order",
  refunded: "Mark refunded",
};
