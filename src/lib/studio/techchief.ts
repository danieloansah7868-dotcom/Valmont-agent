/**
 * Data Bundles — Stage 5: the TechChief HTTP client.
 *
 * TechChief (techchiefxdata.com) is the wholesale data API each shop owner
 * connects with **their own** developer account, their own API key and their
 * own wallet. This module is the only place in the codebase that speaks to
 * it. It is deliberately dumb and side-effect free: no database, no session,
 * no retries, no logging of secrets. Everything that decides *whether* a call
 * may be made (the hourly budget, the verified-key gate) and everything that
 * records what happened (delivery rows, wallet balance, alerts) lives in
 * `integrations.ts` and `bundle-delivery.ts`.
 *
 * Contract implemented (TechChief API v1.0):
 *
 *   base https://techchiefxdata.com/api/
 *   auth header `X-API-Key: TCHX-…`, JSON in and out
 *   60 requests per hour per key — orders AND status checks together
 *     (429 when over; `X-RateLimit-Limit` / `-Remaining` / `-Reset` headers)
 *   POST dev_order.php   {network, bundle_id, phone, callback_url?}
 *   GET  dev_bundles.php ?network=MTN
 *   GET  dev_status.php  ?order_ref=…
 *   GET  dev_wallet.php
 *
 * Networks are case-sensitive strings on their side ("MTN" | "AirtelTigo" |
 * "Telecel" | "BigTime"), while our catalogue stores lowercase ids
 * ("mtn" | "telecel" | "airteltigo"). {@link TECHCHIEF_NETWORK_BY_ID} is the
 * single mapping between the two.
 *
 * Two rules shape every function here:
 *
 *  1. **Never throw on an HTTP error.** A refused, unpaid-for or rate-limited
 *     call is a normal business outcome that the owner must be able to read,
 *     so every function returns a typed `{ok:false, kind, message}` result.
 *     Only a programming error can throw.
 *  2. **Never guess after a timeout.** TechChief offers no idempotency key and
 *     no "safe retry": when a request times out we do not know whether the
 *     wallet was charged, so the result is `kind:"timeout"` and the caller
 *     must record an unknown outcome rather than resend (`bundle-delivery.ts`
 *     turns that into "check your TechChief dashboard before retrying").
 */

import { normalizeGhanaMobile, type BundleNetworkId } from "./bundles";

/** TechChief's API root. Every endpoint below is relative to it. */
export const TECHCHIEF_API_BASE = "https://techchiefxdata.com/api/";

/** AbortController deadline for one TechChief call. */
export const TECHCHIEF_TIMEOUT_MS = 15_000;

/** Identifies this deployment in TechChief's logs (asked for in their doc). */
export const TECHCHIEF_USER_AGENT = "Valmont-Agent";

/** The network strings TechChief accepts, exactly as spelled in their doc. */
export const TECHCHIEF_NETWORKS = [
  "MTN",
  "AirtelTigo",
  "Telecel",
  "BigTime",
] as const;
export type TechChiefNetwork = (typeof TECHCHIEF_NETWORKS)[number];

/**
 * Our catalogue network id → TechChief's case-sensitive network string.
 * BigTime (20–500 GB, no expiry) has no catalogue id yet; it can be added as
 * a fourth network later without touching this map's existing entries.
 */
export const TECHCHIEF_NETWORK_BY_ID: Record<
  BundleNetworkId,
  TechChiefNetwork
> = {
  mtn: "MTN",
  telecel: "Telecel",
  airteltigo: "AirtelTigo",
};

/** True for one of TechChief's own network strings. */
export function isTechChiefNetwork(value: unknown): value is TechChiefNetwork {
  return (
    typeof value === "string" &&
    (TECHCHIEF_NETWORKS as readonly string[]).includes(value)
  );
}

/**
 * Accepts either spelling — our lowercase catalogue id or TechChief's own
 * string — and returns the TechChief string, or null when the network is
 * unknown (so a caller can fail loudly instead of ordering for "undefined").
 */
export function techChiefNetworkFor(
  network: string | null | undefined,
): TechChiefNetwork | null {
  if (!network) return null;
  if (isTechChiefNetwork(network)) return network;
  const id = network.trim().toLowerCase();
  return (
    (TECHCHIEF_NETWORK_BY_ID as Record<string, TechChiefNetwork>)[id] ?? null
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Why a call did not succeed. The adapter in `bundle-delivery.ts` turns each
 * kind into owner-facing wording, so the kinds are the contract:
 *
 *  - `auth`          401/403 — the key is wrong, revoked or disabled.
 *  - `balance`       402 — the wallet cannot cover this bundle (`required`).
 *  - `bundle`        404 — TechChief no longer sells that bundle id.
 *  - `validation`    400/422 — we sent something they reject.
 *  - `rate_limited`  429 — their 60/hour ceiling (or our own 50/hour budget).
 *  - `server`        5xx — their side is broken right now.
 *  - `network`       DNS/connection failure — nothing was sent.
 *  - `timeout`       we gave up waiting — the outcome is UNKNOWN.
 */
export type TechChiefFailureKind =
  | "auth"
  | "balance"
  | "bundle"
  | "validation"
  | "rate_limited"
  | "server"
  | "network"
  | "timeout";

export type TechChiefResult<T> =
  | {
      ok: true;
      data: T;
      /** `X-RateLimit-Remaining` when TechChief sent it, else null. */
      rateLimitRemaining: number | null;
    }
  | {
      ok: false;
      kind: TechChiefFailureKind;
      /** Owner-safe wording; never contains the API key. */
      message: string;
      /** Wallet balance reported alongside the error, when they sent one. */
      walletBalance?: number;
      /** Price of the bundle that did not fit the wallet (402 only). */
      required?: number;
      /** TechChief's own machine code, e.g. "INSUFFICIENT_BALANCE". */
      code?: string;
      rateLimitRemaining: number | null;
      /** HTTP status, when the failure came from a response. */
      status?: number;
    };

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface TechChiefWallet {
  walletBalance: number;
  currency: string;
  /** TechChief's own low-balance flag (balance below `threshold`). */
  lowBalance: boolean;
  threshold: number | null;
  /** "active" | "suspended" | … — only "active" may place orders. */
  accountStatus: string | null;
  /** The key must be activated (one-time payment) before it can order. */
  apiActivated: boolean;
  /** The label the owner gave the key in their dashboard. */
  keyName: string | null;
}

/** One bundle TechChief sells. Ordering is by `id`, never by size. */
export interface TechChiefBundle {
  id: number;
  network: TechChiefNetwork;
  sizeGb: number;
  validityDays: number | null;
  price: number;
  currency: string;
}

export type TechChiefOrderStatus =
  "accepted" | "processing" | "delivered" | "failed" | "refunded";

export interface TechChiefOrderResult {
  orderRef: string;
  /** What they answered immediately: accepted | processing | failed. */
  status: TechChiefOrderStatus;
  apiPrice: number | null;
  walletBalance: number | null;
  message: string | null;
}

export interface TechChiefStatusResult {
  orderRef: string;
  status: TechChiefOrderStatus;
  message: string | null;
}

export interface TechChiefPlaceOrderInput {
  network: BundleNetworkId | TechChiefNetwork | string;
  /** TechChief's bundle id — never a size. */
  bundleId: number;
  /** Recipient number; normalised to 10 local digits before sending. */
  phone: string;
  /**
   * Per-order callback URL. Overrides the dashboard URL, and TechChief only
   * calls https endpoints — so the adapter passes one only when APP_URL is
   * https.
   */
  callbackUrl?: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `X-RateLimit-Remaining`, so callers can see the budget drain in real time. */
function rateLimitRemaining(response: Response): number | null {
  return toNumber(response.headers.get("x-ratelimit-remaining"));
}

const KIND_BY_STATUS: Record<number, TechChiefFailureKind> = {
  400: "validation",
  401: "auth",
  402: "balance",
  403: "auth",
  404: "bundle",
  422: "validation",
  429: "rate_limited",
};

function kindForStatus(status: number): TechChiefFailureKind {
  if (KIND_BY_STATUS[status]) return KIND_BY_STATUS[status];
  if (status >= 500) return "server";
  if (status >= 400) return "validation";
  return "server";
}

/** Fallback wording per kind, used when TechChief sends no usable message. */
const DEFAULT_MESSAGE: Record<TechChiefFailureKind, string> = {
  auth: "TechChief rejected this API key.",
  balance: "The TechChief wallet cannot cover this bundle.",
  bundle: "TechChief does not offer this bundle.",
  validation: "TechChief rejected the request.",
  rate_limited: "TechChief rate limit reached — try again in a few minutes.",
  server: "TechChief is not responding correctly — try again shortly.",
  network: "Could not reach TechChief — try again.",
  timeout:
    "TechChief did not answer in time. The outcome is unknown — check your TechChief dashboard before retrying.",
};

/**
 * Turns one TechChief exchange into a typed result. The error body shape is
 * `{success:false, code, message, wallet_balance?, required?}`; a body that
 * does not parse simply falls back to the wording for its status code, so a
 * HTML error page from a proxy can never produce a crash or a leak.
 */
function failureFromResponse(
  response: Response,
  body: unknown,
): TechChiefResult<never> {
  const kind = kindForStatus(response.status);
  const record = (body ?? {}) as Record<string, unknown>;
  const walletBalance = toNumber(record.wallet_balance) ?? undefined;
  const required = toNumber(record.required) ?? undefined;
  return {
    ok: false,
    kind,
    message: toText(record.message) ?? DEFAULT_MESSAGE[kind],
    ...(walletBalance === undefined ? {} : { walletBalance }),
    ...(required === undefined ? {} : { required }),
    ...(toText(record.code) ? { code: toText(record.code)! } : {}),
    rateLimitRemaining: rateLimitRemaining(response),
    status: response.status,
  };
}

// ---------------------------------------------------------------------------
// The one fetch wrapper
// ---------------------------------------------------------------------------

interface RawCall {
  response: Response;
  body: unknown;
}

/**
 * Performs one authenticated call. Returns a `TechChiefResult` for every
 * outcome — including a thrown fetch (network) and an aborted fetch
 * (timeout) — so no caller has to wrap it in try/catch.
 *
 * The key is used only to build the `X-API-Key` header. It is never put in a
 * URL, never written to a message and never re-thrown inside an Error, which
 * is what keeps it out of logs and out of `safeApiError` responses.
 */
async function call<T>(
  apiKey: string,
  path: string,
  init: {
    method: "GET" | "POST";
    query?: Record<string, string>;
    body?: unknown;
  },
  parse: (body: unknown) => T | null,
): Promise<TechChiefResult<T>> {
  const url = new URL(path, TECHCHIEF_API_BASE);
  for (const [name, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(name, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TECHCHIEF_TIMEOUT_MS);
  let raw: RawCall;
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        "X-API-Key": apiKey,
        accept: "application/json",
        "user-agent": TECHCHIEF_USER_AGENT,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
      // A wholesaler response must never be cached or shared between shops.
      cache: "no-store",
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    raw = { response, body };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    const kind: TechChiefFailureKind = timedOut ? "timeout" : "network";
    return {
      ok: false,
      kind,
      message: DEFAULT_MESSAGE[kind],
      rateLimitRemaining: null,
    };
  } finally {
    clearTimeout(timer);
  }

  const { response, body } = raw;
  if (!response.ok) return failureFromResponse(response, body);

  const record = (body ?? {}) as Record<string, unknown>;
  // A 200 that says `success:false` is still a failure; treat it as their
  // server misbehaving rather than pretending the call worked.
  if (record.success === false) {
    return failureFromResponse(
      // Synthesise a 500-shaped failure so the kind/message mapping is shared.
      new Response(null, { status: 500 }),
      body,
    );
  }

  const data = parse(body);
  if (!data) {
    return {
      ok: false,
      kind: "server",
      message: "TechChief sent a response we could not read.",
      rateLimitRemaining: rateLimitRemaining(response),
      status: response.status,
    };
  }
  return { ok: true, data, rateLimitRemaining: rateLimitRemaining(response) };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function parseWallet(body: unknown): TechChiefWallet | null {
  const record = (body ?? {}) as Record<string, unknown>;
  const balance = toNumber(record.wallet_balance);
  if (balance === null) return null;
  return {
    walletBalance: balance,
    currency: toText(record.currency) ?? "GHS",
    lowBalance: record.low_balance === true,
    threshold: toNumber(record.threshold),
    accountStatus: toText(record.account_status),
    apiActivated: record.api_activated === true,
    keyName: toText(record.key_name),
  };
}

/**
 * GET dev_wallet.php — the cheapest way to prove a key works, and the source
 * of the balance the owner sees in Studio. Saving a key, "Check balance" and
 * every completed order all read through here.
 */
export function getTechChiefWallet(
  apiKey: string,
): Promise<TechChiefResult<TechChiefWallet>> {
  return call(apiKey, "dev_wallet.php", { method: "GET" }, parseWallet);
}

function parseBundles(body: unknown): TechChiefBundle[] | null {
  const record = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(record.bundles)) return null;
  const bundles: TechChiefBundle[] = [];
  for (const entry of record.bundles) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = toNumber(item.id);
    const sizeGb = toNumber(item.size_gb);
    const price = toNumber(item.price);
    const network = techChiefNetworkFor(toText(item.network));
    if (id === null || sizeGb === null || price === null || !network) continue;
    bundles.push({
      id: Math.trunc(id),
      network,
      sizeGb,
      validityDays: toNumber(item.validity_days),
      price,
      currency: toText(item.currency) ?? "GHS",
    });
  }
  return bundles;
}

/**
 * GET dev_bundles.php — the wholesale price list. Called with no network it
 * returns every network TechChief sells, which is what "Sync bundles" caches.
 */
export function listTechChiefBundles(
  apiKey: string,
  network?: BundleNetworkId | TechChiefNetwork | string,
): Promise<TechChiefResult<TechChiefBundle[]>> {
  const wanted = network ? techChiefNetworkFor(network) : null;
  // An unrecognised network must not silently download the whole list.
  if (network && !wanted) {
    return Promise.resolve({
      ok: false,
      kind: "validation",
      message: `Unknown network "${String(network)}".`,
      rateLimitRemaining: null,
    });
  }
  return call(
    apiKey,
    "dev_bundles.php",
    { method: "GET", query: wanted ? { network: wanted } : {} },
    parseBundles,
  );
}

function parseOrder(body: unknown): TechChiefOrderResult | null {
  const record = (body ?? {}) as Record<string, unknown>;
  const orderRef = toText(record.order_ref);
  const status = toText(record.status);
  if (!orderRef || !status) return null;
  return {
    orderRef,
    status: status as TechChiefOrderStatus,
    apiPrice: toNumber(record.api_price),
    walletBalance: toNumber(record.wallet_balance),
    message: toText(record.message),
  };
}

/**
 * POST dev_order.php — the only call that spends the owner's money.
 *
 * The recipient is normalised to the 10-digit local form TechChief expects
 * ("0244123456"); a number that is not a valid Ghana mobile is refused here
 * rather than sent, because a rejected top-up still burns budget and can
 * still be charged.
 */
export function placeTechChiefOrder(
  apiKey: string,
  input: TechChiefPlaceOrderInput,
): Promise<TechChiefResult<TechChiefOrderResult>> {
  const network = techChiefNetworkFor(input.network);
  const phone = normalizeGhanaMobile(input.phone);
  if (!network || !phone || !Number.isInteger(input.bundleId)) {
    return Promise.resolve({
      ok: false,
      kind: "validation",
      message: !network
        ? `Unknown network "${String(input.network)}".`
        : !phone
          ? "The recipient is not a valid Ghana mobile number."
          : "A TechChief bundle id is required.",
      rateLimitRemaining: null,
    });
  }
  return call(
    apiKey,
    "dev_order.php",
    {
      method: "POST",
      body: {
        network,
        bundle_id: input.bundleId,
        phone,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      },
    },
    parseOrder,
  );
}

function parseStatus(body: unknown): TechChiefStatusResult | null {
  const record = (body ?? {}) as Record<string, unknown>;
  const status = toText(record.status);
  if (!status) return null;
  return {
    orderRef: toText(record.order_ref) ?? "",
    status: status as TechChiefOrderStatus,
    message: toText(record.message),
  };
}

/** GET dev_status.php — one poll of one order reference. */
export function getTechChiefStatus(
  apiKey: string,
  orderRef: string,
): Promise<TechChiefResult<TechChiefStatusResult>> {
  if (!orderRef.trim()) {
    return Promise.resolve({
      ok: false,
      kind: "validation",
      message: "An order reference is required.",
      rateLimitRemaining: null,
    });
  }
  return call(
    apiKey,
    "dev_status.php",
    { method: "GET", query: { order_ref: orderRef.trim() } },
    parseStatus,
  );
}

// ---------------------------------------------------------------------------
// Bundle matching
// ---------------------------------------------------------------------------

/**
 * Finds the TechChief bundle that corresponds to one of our catalogue items.
 *
 * TechChief sells by bundle **id**, our shops sell by network + size, so this
 * is the join between the two worlds. A match needs the same network and the
 * same size: `size_gb` is compared in MB, accepting both the binary reading
 * (1 GB = 1024 MB, which is what our catalogue stores) and the decimal one
 * (1 GB = 1000 MB) so items created against a decimal price list still
 * resolve. Returns null when nothing matches — sub-1 GB items (500 MB) have no
 * TechChief bundle at all and therefore can never be auto-delivered; the
 * owner is told to sync bundles or change the item.
 */
export function matchTechChiefBundle(
  bundles: ReadonlyArray<TechChiefBundle>,
  network: BundleNetworkId | TechChiefNetwork | string,
  dataMb: number,
): TechChiefBundle | null {
  const wanted = techChiefNetworkFor(network);
  if (!wanted || !Number.isFinite(dataMb) || dataMb <= 0) return null;
  const target = Math.round(dataMb);

  const exact = bundles.find(
    (bundle) =>
      bundle.network === wanted && Math.round(bundle.sizeGb * 1024) === target,
  );
  if (exact) return exact;
  return (
    bundles.find(
      (bundle) =>
        bundle.network === wanted &&
        Math.round(bundle.sizeGb * 1000) === target,
    ) ?? null
  );
}
