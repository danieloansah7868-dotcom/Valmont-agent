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

export type OrderStatusLabelKey =
  | "pending"
  | "paid"
  | "payment_failed"
  | "fulfilled"
  | "cancelled"
  | "cod_pending";

/** Plain-language labels for every order status shown to a person. */
export const STATUS_LABELS: Record<OrderStatusLabelKey, string> = {
  pending: "Awaiting payment",
  paid: "Paid",
  payment_failed: "Payment failed",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
  cod_pending: "Cash on delivery",
};

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

/** True only when both Valmont Pay environment variables are present. */
export function isLiveConfigured(): boolean {
  return Boolean(
    process.env.VALMONT_PAY_API_URL && process.env.VALMONT_PAY_API_KEY,
  );
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

/**
 * Where the customer goes to pay. In live mode this is the hosted Valmont Pay
 * page; in test mode it is the local `/pay/[code]` simulator route.
 */
export function paymentUrlFor(accessCode: string): string {
  if (isLiveConfigured()) {
    return buildPublicUrl(process.env.VALMONT_PAY_API_URL!, "pay", {
      access_code: accessCode,
    });
  }
  return `/pay/${accessCode}`;
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

/**
 * Creates a payment link. In live mode it POSTs to the Valmont Pay API with a
 * Bearer key; in test mode it returns the local simulator link. The exact live
 * request shape will be finalised when Valmont Pay publishes its API; the call
 * is isolated here so only this function changes.
 */
export async function createPaymentLink(
  req: CreatePaymentLinkRequest,
): Promise<CreatePaymentLinkResult> {
  if (!isLiveConfigured()) {
    return { paymentLink: paymentUrlFor(req.accessCode), live: false };
  }

  const endpoint = buildPublicUrl(process.env.VALMONT_PAY_API_URL!, "links");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.VALMONT_PAY_API_KEY!}`,
    },
    body: JSON.stringify({
      amount: Math.round(req.amount * 100),
      currency: req.currency,
      reference: req.reference,
      description: req.description,
      access_code: req.accessCode,
      customer: {
        name: req.customerName,
        email: req.customerEmail,
        phone: req.customerPhone,
      },
      callback_url: req.callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error("Valmont Pay could not create a payment link right now.");
  }

  const data = (await response.json()) as { url?: string; link?: string };
  const paymentLink = data.url ?? data.link;
  if (!paymentLink) {
    throw new Error("Valmont Pay returned no payment link.");
  }
  return { paymentLink, live: true };
}

/**
 * Verifies a webhook signature. In test mode there is no signing secret, so a
 * request that reaches the webhook (already gated by the unguessable access
 * code) is accepted. HMAC verification against a shared secret will be added
 * here once Valmont Pay publishes its signing scheme.
 */
export function verifyWebhookSignature(
  body: string,
  signatureHeader: string | null,
): boolean {
  if (!isLiveConfigured()) {
    // Test mode: the local simulator is the only caller and the access code in
    // the URL is the access control. There is nothing to verify against.
    void body;
    void signatureHeader;
    return true;
  }
  // TODO: HMAC-SHA256 over the raw body with the Valmont Pay signing secret,
  // compared in constant time, once the signing scheme is published.
  void body;
  void signatureHeader;
  return true;
}
