/**
 * Deterministic money maths and formatting for the Website Studio.
 *
 * Everything here is pure and dependency-free so it is safe to import from
 * BOTH server modules (checkout, orders, payments) and client components
 * (the public storefront, the Studio preview). Server-only payment
 * configuration lives in `valmont-pay.ts` / `payment-settings.ts`.
 */

/** A basket line as priced by the server (never trusted from the client). */
export interface PricedLine {
  /** Unit price in major currency units, e.g. 45 or 45.5. */
  price: number;
  quantity: number;
}

export interface DeliveryPricing {
  enabled: boolean;
  fee: number;
  minimumOrder: number;
  freeDeliveryAbove?: number;
}

export interface OrderTotals {
  subtotal: number;
  deliveryFee: number;
  total: number;
}

/** Major units -> integer minor units (pesewas/cents). */
function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

/** Integer minor units -> major units. */
function toMajor(minor: number): number {
  return minor / 100;
}

/**
 * Computes an order's totals in integer minor units so no floating-point
 * drift can creep into the amount a customer is charged. Delivery is added
 * only when enabled, and waived when a free-delivery threshold is met.
 */
export function computeTotals(
  lines: PricedLine[],
  delivery: DeliveryPricing,
): OrderTotals {
  const subtotalMinor = lines.reduce(
    (sum, line) =>
      sum + toMinor(line.price) * Math.max(0, Math.trunc(line.quantity)),
    0,
  );

  let deliveryMinor = 0;
  if (delivery.enabled) {
    deliveryMinor = toMinor(delivery.fee);
    if (
      delivery.freeDeliveryAbove !== undefined &&
      delivery.freeDeliveryAbove > 0 &&
      subtotalMinor >= toMinor(delivery.freeDeliveryAbove)
    ) {
      deliveryMinor = 0;
    }
  }

  return {
    subtotal: toMajor(subtotalMinor),
    deliveryFee: toMajor(deliveryMinor),
    total: toMajor(subtotalMinor + deliveryMinor),
  };
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  GHS: "GH₵",
  NGN: "₦",
  KES: "KSh",
  GBP: "£",
  USD: "$",
};

/** Money for display, e.g. `GH₵45.00`. Never used for arithmetic. */
export function formatMoney(amount: number, currency = "GHS"): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Joins a base, a path and query parameters into a single URL string. */
export function buildPublicUrl(
  base: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(
    path.replace(/^\//, ""),
    base.endsWith("/") ? base : `${base}/`,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
