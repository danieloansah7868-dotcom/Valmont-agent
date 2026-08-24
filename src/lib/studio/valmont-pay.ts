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
 * Live mode is enabled only when BOTH Valmont Pay keys are known (saved on
 * the Studio → Settings → Payments page, or provided as the
 * `VALMONT_PAY_API_URL` / `VALMONT_PAY_API_KEY` environment variables) AND the
 * payment mode is switched to Live. In every other case the app runs in test
 * mode with the local simulator and no real money can move.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePaymentConfig } from "./payment-settings";
import { buildPublicUrl } from "./money";

// The pure money helpers live in ./money so client components (the public
// storefront) can use them without pulling server-only payment configuration
// into the browser bundle. They are re-exported here so the many existing
// server-side import sites keep working unchanged.
export {
  buildPublicUrl,
  computeTotals,
  formatMoney,
  type DeliveryPricing,
  type OrderTotals,
  type PricedLine,
} from "./money";

export type { OrderStatus as OrderStatusLabelKey } from "./order-status";
export { STATUS_LABELS } from "./order-status";

/**
 * True only when real payments can move: Live mode is selected on the
 * Settings → Payments page AND both Valmont Pay keys are present. Test mode
 * (the default) always returns false, even while keys are saved.
 */
export async function isLiveConfigured(): Promise<boolean> {
  return (await resolvePaymentConfig()).liveActive;
}

/**
 * Where the customer goes to pay. In live mode this is the hosted Valmont Pay
 * page; in test mode it is the local `/pay/[code]` simulator route.
 */
export async function paymentUrlFor(accessCode: string): Promise<string> {
  const config = await resolvePaymentConfig();
  if (config.liveActive) {
    return buildPublicUrl(config.apiUrl!, "pay", {
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
  const config = await resolvePaymentConfig();
  if (!config.liveActive) {
    return {
      paymentLink: await paymentUrlFor(req.accessCode),
      live: false,
    };
  }

  const endpoint = buildPublicUrl(config.apiUrl!, "links");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey!}`,
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

/** Signature headers the webhook route looks at, in priority order. */
export interface WebhookSignatureHeaders {
  /** `x-valmont-signature` — Valmont Pay's own header. */
  valmont?: string | null;
  /**
   * `x-paystack-signature` — Valmont Pay wraps Paystack, whose webhooks sign
   * the raw body with HMAC-SHA512 using the account secret key. Accepted so a
   * pass-through deployment verifies correctly too.
   */
  paystack?: string | null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Lengths leak through timing either way; compare only equal-length buffers
  // and let unequal lengths fail closed.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The signatures we accept for a live webhook, given the raw body and the
 * saved signing secret. Valmont Pay has not published its scheme yet, so we
 * accept the realistic candidates — Paystack-compatible HMAC-SHA512 hex, and
 * HMAC-SHA256 in hex or base64 — and compare each in constant time.
 */
function candidateWebhookSignatures(body: string, secret: string): string[] {
  return [
    createHmac("sha512", secret).update(body, "utf8").digest("hex"),
    createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    createHmac("sha256", secret).update(body, "utf8").digest("base64"),
  ];
}

/**
 * Verifies a webhook signature.
 *
 * - Test mode: the local simulator is the only caller and the unguessable
 *   access code in the URL is the access control, so the request is accepted.
 * - Live mode: a saved signing secret is REQUIRED. Every live webhook must
 *   carry a valid HMAC signature — an unsigned or wrongly-signed live webhook
 *   is refused, so nobody can mark an order paid by guessing its access code.
 */
export async function verifyWebhookSignature(
  body: string,
  headers: WebhookSignatureHeaders,
): Promise<boolean> {
  const config = await resolvePaymentConfig();
  if (!config.liveActive) {
    void body;
    void headers;
    return true;
  }

  if (!config.webhookSecret) {
    // Fail closed: without a signing secret there is no way to tell a real
    // Valmont Pay callback from a forgery. The settings page warns about this
    // before Live mode is switched on.
    return false;
  }

  const presented = [headers.valmont, headers.paystack]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (presented.length === 0) return false;

  const candidates = candidateWebhookSignatures(body, config.webhookSecret);
  return presented.some((signature) =>
    candidates.some((candidate) => timingSafeStringEqual(signature, candidate)),
  );
}
