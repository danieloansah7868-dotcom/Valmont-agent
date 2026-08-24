/**
 * Valmont Pay integration and pricing helpers.
 *
 * Valmont Pay is a hosted payment layer (payment links backed by a payment
 * processor) that accepts Mobile Money, cards and bank transfer and settles to
 * the merchant's account. This module has two jobs:
 *
 *  1. Deterministic money maths (totals, formatting) done entirely in integer
 *     minor units so floating-point drift can never change an order total.
 *  2. Creating a payment link — against the real Valmont Pay HTTP API when it
 *     is configured, or against a built-in local simulator otherwise, so the
 *     whole checkout flow is testable on a self-hosted machine with no external
 *     account.
 *
 * Live mode is enabled only when BOTH `VALMONT_PAY_API_URL` and
 * `VALMONT_PAY_API_KEY` are set. With either missing, the app runs in test mode
 * and no real money can move.
 */

export type { OrderStatus as OrderStatusLabelKey } from "./order-status";
export { STATUS_LABELS } from "./order-status";

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
 * Computes an order's totals in integer minor units so no floating-point drift
 * can creep into the amount a customer is charged. Delivery is added only when
 * enabled, and waived when a free-delivery threshold is met.
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
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return url.toString();
}

export interface CreatePaymentLinkRequest {
  accessCode: string;
  amount: number;
  currency: string;
  reference: string;
  description: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  /** Absolute URL Valmont Pay calls when the payment is confirmed. */
  callbackUrl?: string;
}

export interface CreatePaymentLinkResult {
  paymentLink: string;
  live: boolean;
}
