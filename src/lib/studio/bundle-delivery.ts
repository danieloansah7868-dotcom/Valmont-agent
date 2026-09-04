/**
 * Data-bundles Stage 4 — the bundle delivery engine (simulator first).
 *
 * When a bundle order is paid, the engine turns every purchased bundle UNIT
 * into a delivery row and asks a provider to top up the recipient's phone.
 * Two providers exist today:
 *
 *  - {@link SimulatedProvider} (default): accepts every top-up as
 *    "processing" and reports it "delivered" on the next status check, so the
 *    whole lifecycle is exercisable with no external account and no real data
 *    moving — the exact analogue of the payment simulator. Test hooks:
 *    a recipient ending `0000` always fails; one ending `9999` stays
 *    "processing" for 60 seconds, so "Failed → Retry" and slow delivery can
 *    be rehearsed by hand.
 *  - {@link TechChiefProvider} (Stage 5): the real wholesaler, reached with
 *    the API key each shop owner saves for their own website. It orders by
 *    TechChief's bundle id, records their order reference, mirrors the wallet
 *    balance back onto the connection, and maps every refusal — no float,
 *    revoked key, bundle withdrawn, rate limit — onto owner-readable wording.
 *    Constructed without a key it is the old fail-fast stub, so nothing can
 *    select it by accident.
 *
 * Which provider runs is decided per order by {@link resolveProviderForOrder}:
 * a live-money order on a website whose TechChief connection is `verified`
 * goes to TechChief, and everything else — above all every TEST-mode order —
 * stays on the environment default. Test mode never touches TechChief, even
 * when a key is saved.
 *
 * The engine is held to six invariants. Each has a dedicated test in
 * `bundle-delivery.test.ts`:
 *
 *  I1  Paid-first, and live-money safety. No delivery row is created and the
 *      provider is never called before the order is paid. And when an order
 *      was paid with REAL money (`payment_mode === "live"`), the engine only
 *      dispatches through a provider that is itself live — while a website
 *      has no verified TechChief connection, checkout refuses live bundle
 *      orders with 409 before any order row, and the engine's backstop
 *      records a failed row saying nothing was sent rather than dispatching
 *      through the simulator.
 *  I2  Idempotent, also under concurrency. Exactly one delivery row per
 *      purchased bundle unit, guaranteed by the unique
 *      (order_id, line_index, unit_index) index, and a row is handed to the
 *      provider exactly once per attempt: `claimForDispatch` moves
 *      pending|failed → processing atomically, so a webhook replay and a
 *      simultaneous customer page load can never both send the same unit.
 *  I3  Terminal success. "delivered" is final. Rechecks, retries and
 *      provider callbacks never move, modify or re-dispatch a delivered row.
 *  I4  Isolated failure. A provider failure is recorded on the row
 *      (status "failed" + an owner-readable error, and an aggregated
 *      merchant alert) and is never thrown back into the caller: the payment
 *      webhook still answers 200 and the order stays paid. Only "failed"
 *      rows can be retried, and only by the owner.
 *  I5  Bundle-only. Deliveries exist only for data-bundles orders (recipient
 *      phone + resolvable bundle lines). Every other website type is
 *      untouched — no rows, no provider calls, no rendering changes, no
 *      alerts.
 *  I6  Guest privacy. Unauthenticated surfaces show one masked aggregate line
 *      ("3GB of data to 024 ••• 0001 — delivered"). Full numbers, provider
 *      references, attempt counts and error text appear only on the
 *      authenticated owner page and in the merchant's own alert.
 *
 * Entry points:
 *
 *  - {@link dispatchBundleDeliveriesForOrder} — fired (fire-and-forget) by
 *    the payments webhook right after an order flips to "paid".
 *  - {@link recheckBundleDeliveriesForOrder} — runs on order-page loads:
 *    creates missing rows for a paid order (recovery after an outage),
 *    flushes any rows stuck at "pending", and asks the provider about rows
 *    at "processing". Never throws, so a page can never break on delivery.
 *  - {@link retryBundleDeliveryFailures} — the owner's Retry action for rows
 *    at "failed".
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDeliveries } from "@/db/schema";
import { ConflictError } from "@/lib/api-errors";
import { getSqliteChatStore } from "@/lib/chat-store";
import {
  bundleNetworkLabel,
  formatDataMb,
  getBundleNetwork,
  guessDataMbFromItem,
  isBundleNetworkId,
  isValidGhanaMobile,
  maskGhanaMobile,
  normalizeGhanaMobile,
  type BundleNetworkId,
} from "./bundles";
import { publicGetDraft } from "./draft-public";
import {
  getTechChiefIntegrationWithKey,
  getTechChiefIntegration,
  getIntegrationsStore,
  consumeTechChiefBudget,
  markIntegrationError,
  recordWalletFromOrder,
  techChiefBundlesForDelivery,
  techChiefCallback,
  type IntegrationsStore,
} from "./integrations";
import {
  notifyMerchantDeliveryFailed,
  notifyMerchantLowBalance,
  type MerchantDeliveryFailureInput,
  type MerchantLowBalanceInput,
} from "./notifications";
import {
  matchTechChiefBundle,
  placeTechChiefOrder,
  getTechChiefStatus,
  type TechChiefFailureKind,
} from "./techchief";
import {
  getOrdersStore,
  type OrderLine,
  type OrderRecord,
  type OrdersStore,
  type OrderStatus,
} from "./orders";
import type { CatalogItem } from "./site-brief/schema";

// ---------------------------------------------------------------------------
// Records and statuses
// ---------------------------------------------------------------------------

export const DELIVERY_STATUSES = [
  "pending",
  "processing",
  "delivered",
  "failed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return (
    typeof value === "string" &&
    (DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** Plain-language labels for the owner panel. */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Waiting to send",
  processing: "Sending",
  delivered: "Delivered",
  failed: "Failed",
};

/** One purchased bundle unit that the provider must top up. */
export interface BundleDeliveryRecord {
  id: string;
  orderId: string;
  ownerId: string;
  /** Position of the order line and of the unit inside that line. */
  lineIndex: number;
  unitIndex: number;
  /** Catalogue line id and display name, snapshotted at dispatch time. */
  itemId: string;
  itemName: string;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
  /** Full recipient number — server-side only; guest pages mask it (I6). */
  recipientPhone: string;
  /** Provider id that made the latest dispatch attempt. */
  provider: string;
  status: DeliveryStatus;
  attempts: number;
  providerRef?: string;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields needed to open a delivery row. Status starts at "pending". */
export interface NewBundleDeliveryInput {
  orderId: string;
  ownerId: string;
  lineIndex: number;
  unitIndex: number;
  itemId: string;
  itemName: string;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
  recipientPhone: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** What the engine hands to a provider for one top-up (one bundle unit). */
export interface BundleDeliveryDispatchRequest {
  orderId: string;
  deliveryId: string;
  /** 1-based attempt number (a retry is attempt ≥ 2). */
  attempt: number;
  /** Which order line and unit this top-up covers — a natural idempotency key. */
  lineIndex: number;
  unitIndex: number;
  recipientPhone: string;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
}

export type BundleDeliverySendResult =
  { ok: true; providerRef?: string } | { ok: false; error: string };

export interface BundleDeliveryStatusRequest {
  providerRef: string;
  /**
   * When the row last changed, so a provider that is billed or rate-limited
   * per poll can throttle itself (Stage 5: TechChief allows 60 requests an
   * hour for orders *and* status checks together). The simulator ignores it.
   */
  updatedAt?: string;
  /** When the row was created — long-stuck rows are polled less often. */
  createdAt?: string;
  /** The delivery row's id, for provider-side bookkeeping. */
  deliveryId?: string;
}

/**
 * What a provider answered about one in-flight row.
 *
 * `polled` says whether the provider really asked upstream, as opposed to
 * declining to (its own throttle, or an exhausted hourly budget). The engine
 * uses it as a heartbeat: a genuine poll moves the row's `updated_at`, which
 * is what the next throttle decision reads. Without that, a row whose status
 * never changes would be re-polled on every single page load — and the guest
 * confirmation page is unauthenticated, so anybody could spend a shop's
 * TechChief allowance by refreshing it.
 */
export type BundleDeliveryStatusResult =
  | { status: "processing"; polled?: boolean }
  | { status: "delivered"; polled?: boolean }
  | { status: "failed"; error: string; polled?: boolean };

/**
 * A top-up provider. Implementations must be cheap to construct and must
 * report outcomes through their return values — the engine owns the row
 * lifecycle, and a throw is always recorded as a delivery failure (I4).
 */
export interface BundleDeliveryProvider {
  readonly id: string;
  /**
   * True only when this instance moves REAL data for REAL money — i.e. a
   * TechChief adapter holding a verified key. Absent (or false) for the
   * simulator, the keyless TechChief stub and the misconfigured provider,
   * which is what keeps the live-money guard (I1) fail-closed by default.
   */
  readonly live?: boolean;
  sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult>;
  checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult>;
}

/** Recipient suffixes the simulator uses to rehearse failure and slowness. */
export const SIMULATED_FAIL_SUFFIX = "0000";
export const SIMULATED_SLOW_SUFFIX = "9999";
/** How long a `9999` top-up reports "processing" after it was accepted. */
export const SIMULATED_SLOW_MS = 60_000;

export const SIMULATED_FAIL_MESSAGE =
  "Simulated failure (test number ending 0000)";

/**
 * The default provider. It accepts every top-up as "processing" and answers
 * the next status check with "delivered" — deterministic, offline, and safe:
 * no real data can ever move while it is active. It exists so owners can
 * rehearse the full paid → top-up → delivered flow before TechChief is
 * connected, exactly like the payment simulator stands in for Valmont Pay.
 *
 * Rehearsal hooks (test numbers only):
 *  - recipient ending {@link SIMULATED_FAIL_SUFFIX}: the send is refused, so
 *    the row goes "failed" and the owner can rehearse the alert and Retry.
 *  - recipient ending {@link SIMULATED_SLOW_SUFFIX}: the send is accepted but
 *    reports "processing" for {@link SIMULATED_SLOW_MS} after acceptance. The
 *    acceptance time is encoded in the provider reference
 *    (`sim-slow-<epochMs>-<uuid>`), so no in-memory state survives a restart.
 */
export class SimulatedProvider implements BundleDeliveryProvider {
  readonly id = "simulator";

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    // The checkout route validates the recipient long before a delivery row
    // exists; this is the last-line check so a malformed legacy row can never
    // be reported as sent.
    if (!isValidGhanaMobile(request.recipientPhone)) {
      return {
        ok: false,
        error: "The recipient is not a valid Ghana mobile number.",
      };
    }
    const cleaned = request.recipientPhone.replace(/[\s\-()]/g, "");
    if (cleaned.endsWith(SIMULATED_FAIL_SUFFIX)) {
      return { ok: false, error: SIMULATED_FAIL_MESSAGE };
    }
    if (cleaned.endsWith(SIMULATED_SLOW_SUFFIX)) {
      return {
        ok: true,
        providerRef: `sim-slow-${Date.now()}-${randomUUID()}`,
      };
    }
    return { ok: true, providerRef: `sim-${randomUUID()}` };
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    const slow = /^sim-slow-(\d+)-/.exec(request.providerRef);
    if (slow) {
      return Date.now() - Number(slow[1]) >= SIMULATED_SLOW_MS
        ? { status: "delivered" }
        : { status: "processing" };
    }
    if (request.providerRef.startsWith("sim-")) {
      return { status: "delivered" };
    }
    return { status: "processing" };
  }
}

export const TECHCHIEF_NOT_CONNECTED_MESSAGE =
  "TechChief delivery is not connected for this website: no verified API key is saved, so this top-up was not sent. Save the key under Bundle delivery in Studio, then press Retry.";

/** Owner-readable outcomes of a real TechChief call (Stage 5). */
export const TECHCHIEF_KEY_REJECTED_DELIVERY_MESSAGE =
  "TechChief key rejected or disabled — save a new key under Bundle delivery in Studio.";
export const TECHCHIEF_BUNDLE_WITHDRAWN_MESSAGE =
  "This bundle is no longer offered by TechChief.";
export const TECHCHIEF_RATE_LIMITED_MESSAGE =
  "TechChief rate limit reached — Retry in a few minutes.";
/**
 * The answer to a timeout, a connection failure or a 5xx: TechChief has no
 * idempotency key and no "safe retry", so after one of these nobody knows
 * whether the wallet was charged. The row is failed with this wording and the
 * system NEVER resends on its own — the owner checks their TechChief dashboard
 * first and presses Retry only if the top-up really did not go out.
 */
export const TECHCHIEF_UNKNOWN_OUTCOME_MESSAGE =
  "Unknown outcome — check your TechChief dashboard before retrying.";
export const TECHCHIEF_INVALID_RECIPIENT_MESSAGE =
  "The recipient is not a valid Ghana mobile number.";

/** "No TechChief bundle matches MTN 500MB. Sync bundles or change this item." */
export function techChiefNoMatchMessage(
  network: BundleNetworkId | string,
  dataMb: number,
): string {
  return `No TechChief bundle matches ${bundleNetworkLabel(network)} ${formatDataMb(dataMb)}. Sync bundles or change this item.`;
}

/**
 * The 402 wording. Both figures come from TechChief's own response, so the
 * owner sees exactly how much float is missing rather than a guess; either may
 * be absent, and the message degrades instead of printing "GHS null".
 */
export function techChiefLowBalanceMessage(
  walletBalance: number | null | undefined,
  required: number | null | undefined,
): string {
  const balance =
    typeof walletBalance === "number" && Number.isFinite(walletBalance)
      ? `GHS ${walletBalance.toFixed(2)}`
      : null;
  const cost =
    typeof required === "number" && Number.isFinite(required)
      ? `GHS ${required.toFixed(2)}`
      : null;
  if (balance && cost) {
    return `TechChief wallet too low (${balance}, this bundle needs ${cost}). Top up your TechChief wallet, then Retry.`;
  }
  if (balance) {
    return `TechChief wallet too low (${balance}). Top up your TechChief wallet, then Retry.`;
  }
  return "TechChief wallet too low for this bundle. Top up your TechChief wallet, then Retry.";
}

/** A `status:"failed"` answer to an order call — their words, plus the refund. */
export function techChiefRefusedMessage(message: string | null): string {
  const detail = message?.trim();
  return detail
    ? `${detail} (TechChief refunded the wallet for this top-up)`
    : "TechChief could not send this top-up (the wallet was refunded).";
}

// ---------------------------------------------------------------------------
// TechChief polling throttle
// ---------------------------------------------------------------------------

/** A processing row is polled at most once every 10 minutes. */
export const TECHCHIEF_STATUS_POLL_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** After 24 h at "processing" a row is stale… */
export const TECHCHIEF_STALE_PROCESSING_AFTER_MS = 24 * 60 * 60 * 1000;
/** …and is then polled at most once every 6 hours. */
export const TECHCHIEF_STALE_PROCESSING_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What makes a TechChief adapter live: a key and the connection it came from. */
export interface TechChiefProviderConfig {
  /** Decrypted key. Held in memory for one request; never logged or returned. */
  apiKey: string;
  integrationId: string;
  draftId: string;
}

/** Injectable seams for tests; production callers use the defaults. */
export interface TechChiefProviderDeps {
  integrations?: IntegrationsStore;
  orders?: OrdersStore;
  /** Replaces the low-balance alert in tests. */
  notifyLowBalance?: (
    input: MerchantLowBalanceInput,
    throttleKey: string,
  ) => Promise<boolean>;
  now?: () => number;
}

/** Bookkeeping after an outcome must never change that outcome. */
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    /* a failed balance write must not fail a delivery that succeeded */
  }
}

/**
 * The real wholesaler (Stage 5).
 *
 * Constructed with a {@link TechChiefProviderConfig} it is live: it turns one
 * purchased bundle unit into one `dev_order.php` call, keyed by TechChief's
 * bundle id, and reports their outcome. Constructed without one it is the
 * Stage 4 fail-fast stub — every send fails loudly with
 * {@link TECHCHIEF_NOT_CONNECTED_MESSAGE} and `live` stays false, so the
 * live-money guard (I1) can never be satisfied by an adapter that has no key.
 *
 * Three disciplines shape it:
 *
 *  - **Budget first.** Every call claims a slot from the connection's rolling
 *    hourly budget before it is made, because TechChief counts orders and
 *    status checks together against 60/hour. Status polls stop at 50 so a
 *    selling shop always has room to dispatch.
 *  - **Never resend after an unknown outcome.** A timeout, a connection
 *    failure or a 5xx leaves the wallet state unknowable, so the row is failed
 *    with {@link TECHCHIEF_UNKNOWN_OUTCOME_MESSAGE} and only the owner's
 *    explicit Retry can send again.
 *  - **No side channel for secrets.** The key is used only to build the
 *    `X-API-Key` header inside `techchief.ts`; error wording, alerts and rows
 *    carry the balance, the price and the reason — never the key.
 */
export class TechChiefProvider implements BundleDeliveryProvider {
  readonly id = "techchief";
  /** True only with a key: this instance really moves data for real money. */
  readonly live: boolean;
  /**
   * The connection this adapter acts for — held in true ECMAScript private
   * fields, not TypeScript `private` ones. The distinction is the security
   * control: a `private` field is still an ordinary own property, so
   * `JSON.stringify(provider)`, a debug log or an error reporter that
   * serialises the adapter would print the decrypted API key. `#` fields are
   * invisible to all three.
   */
  readonly #config: TechChiefProviderConfig | null;
  readonly #deps: TechChiefProviderDeps;

  constructor(
    config?: TechChiefProviderConfig | null,
    deps: TechChiefProviderDeps = {},
  ) {
    this.#config =
      config && config.apiKey.trim() && config.integrationId ? config : null;
    this.#deps = deps;
    this.live = this.#config !== null;
  }

  private get store(): IntegrationsStore {
    return this.#deps.integrations ?? getIntegrationsStore();
  }

  private now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    const config = this.#config;
    if (!config) {
      return { ok: false, error: TECHCHIEF_NOT_CONNECTED_MESSAGE };
    }
    // Last-line recipient check: a malformed legacy row must never be sent to
    // a wholesaler that would charge the wallet for a rejected top-up.
    if (!normalizeGhanaMobile(request.recipientPhone)) {
      return { ok: false, error: TECHCHIEF_INVALID_RECIPIENT_MESSAGE };
    }

    const store = this.store;
    const bundle = await techChiefBundlesForDelivery(
      config.integrationId,
      store,
    );
    const match = matchTechChiefBundle(
      bundle.bundles,
      request.network,
      request.dataMb,
    );
    if (!match) {
      return {
        ok: false,
        error: techChiefNoMatchMessage(request.network, request.dataMb),
      };
    }

    // Orders get the headroom the polls leave behind, but never push past
    // TechChief's own ceiling: a local refusal is free, their 429 is not.
    const budget = await consumeTechChiefBudget(
      store,
      config.integrationId,
      "order",
      this.now(),
    );
    if (!budget.allowed) {
      return { ok: false, error: TECHCHIEF_RATE_LIMITED_MESSAGE };
    }

    // TechChief only calls https callbacks, so on a deployment without an
    // https APP_URL we simply omit it and rely on polling instead.
    const callback = techChiefCallback(config.integrationId);
    const result = await placeTechChiefOrder(config.apiKey, {
      network: request.network,
      bundleId: match.id,
      phone: request.recipientPhone,
      ...(callback.url ? { callbackUrl: callback.url } : {}),
    });

    if (result.ok) {
      const order = result.data;
      await quietly(() =>
        recordWalletFromOrder(
          config.integrationId,
          { balance: order.walletBalance },
          store,
        ),
      );
      if (order.status === "failed") {
        return { ok: false, error: techChiefRefusedMessage(order.message) };
      }
      // accepted | processing: the top-up is theirs now, and the reference is
      // what the webhook and every later status check are keyed on.
      return { ok: true, providerRef: order.orderRef };
    }

    return this.mapSendFailure(result, request, config, store);
  }

  /** Turns one TechChief refusal into owner-facing wording and side effects. */
  private async mapSendFailure(
    result: Extract<
      Awaited<ReturnType<typeof placeTechChiefOrder>>,
      { ok: false }
    >,
    request: BundleDeliveryDispatchRequest,
    config: TechChiefProviderConfig,
    store: IntegrationsStore,
  ): Promise<BundleDeliverySendResult> {
    const kind: TechChiefFailureKind = result.kind;

    if (kind === "balance") {
      const balance = result.walletBalance ?? null;
      // Their 402 is authoritative: the wallet is short, so say so on the
      // connection (the Studio card turns red) and tell the owner once an hour.
      await quietly(() =>
        recordWalletFromOrder(
          config.integrationId,
          { balance, lowBalance: true },
          store,
        ),
      );
      await this.alertLowBalance(request, balance, result.required ?? null);
      return {
        ok: false,
        error: techChiefLowBalanceMessage(balance, result.required),
      };
    }

    if (kind === "auth") {
      // A revoked or disabled key is not a per-order problem: stop treating
      // this website as live until the owner saves a new key.
      await quietly(() =>
        markIntegrationError(
          config.integrationId,
          TECHCHIEF_KEY_REJECTED_DELIVERY_MESSAGE,
          store,
        ),
      );
      return { ok: false, error: TECHCHIEF_KEY_REJECTED_DELIVERY_MESSAGE };
    }

    if (kind === "bundle") {
      return { ok: false, error: TECHCHIEF_BUNDLE_WITHDRAWN_MESSAGE };
    }
    if (kind === "validation") {
      return { ok: false, error: result.message };
    }
    if (kind === "rate_limited") {
      return { ok: false, error: TECHCHIEF_RATE_LIMITED_MESSAGE };
    }
    // timeout | network | server: the outcome is unknown, so nothing is
    // retried automatically (see TECHCHIEF_UNKNOWN_OUTCOME_MESSAGE).
    return { ok: false, error: TECHCHIEF_UNKNOWN_OUTCOME_MESSAGE };
  }

  /** One merchant alert an hour when the wallet cannot cover a top-up. */
  private async alertLowBalance(
    request: BundleDeliveryDispatchRequest,
    walletBalance: number | null,
    required: number | null,
  ): Promise<void> {
    const config = this.#config;
    if (!config) return;
    try {
      const orders = this.#deps.orders ?? getOrdersStore();
      const order = await orders.getById(request.orderId);
      if (!order) return;
      const draft = await publicGetDraft(order.draftId).catch(() => null);
      if (!draft) return;
      const notify = this.#deps.notifyLowBalance ?? notifyMerchantLowBalance;
      await notify(
        {
          order,
          brief: draft.brief,
          walletBalance,
          required,
          network: request.network,
          dataMb: request.dataMb,
        },
        // Per connection, not per order: one shop, one alert an hour.
        config.integrationId,
      );
    } catch {
      /* an alert must never break the engine (I4) */
    }
  }

  /**
   * Whether this row may be polled right now. The gate is the row's own
   * `updated_at`, so it survives restarts and is shared by every process:
   * the unauthenticated guest confirmation page rechecks on every load, and
   * each poll costs the owner a slice of their 60/hour allowance.
   */
  private shouldPoll(request: BundleDeliveryStatusRequest): boolean {
    const now = this.now();
    const updatedAt = request.updatedAt ? Date.parse(request.updatedAt) : NaN;
    const createdAt = request.createdAt ? Date.parse(request.createdAt) : NaN;
    const age = Number.isFinite(createdAt) ? now - createdAt : 0;
    const interval =
      age > TECHCHIEF_STALE_PROCESSING_AFTER_MS
        ? TECHCHIEF_STALE_PROCESSING_POLL_INTERVAL_MS
        : TECHCHIEF_STATUS_POLL_MIN_INTERVAL_MS;
    return !(Number.isFinite(updatedAt) && now - updatedAt < interval);
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    const config = this.#config;
    // A keyless adapter has nothing to ask; reporting "processing" leaves the
    // row exactly as it was instead of inventing an outcome.
    if (!config || !request.providerRef) return { status: "processing" };
    if (!this.shouldPoll(request)) return { status: "processing" };

    const store = this.store;
    const budget = await consumeTechChiefBudget(
      store,
      config.integrationId,
      "poll",
      this.now(),
    );
    if (!budget.allowed) return { status: "processing" };

    const result = await getTechChiefStatus(config.apiKey, request.providerRef);
    if (!result.ok) {
      if (result.kind === "auth") {
        await quietly(() =>
          markIntegrationError(
            config.integrationId,
            TECHCHIEF_KEY_REJECTED_DELIVERY_MESSAGE,
            store,
          ),
        );
      }
      // Transient: leave the row alone and let the next recheck, or their
      // webhook, decide. Guessing "failed" here could fail a delivered top-up.
      // It WAS a real request, so it counts as a poll for throttle purposes —
      // otherwise an outage would let every page load hammer them.
      return { status: "processing", polled: true };
    }

    switch (result.data.status) {
      case "delivered":
        return { status: "delivered", polled: true };
      case "failed":
      case "refunded":
        return {
          status: "failed",
          polled: true,
          error:
            result.data.message ??
            "TechChief reported this top-up as failed (the wallet was refunded).",
        };
      default:
        return { status: "processing", polled: true };
    }
  }
}

/**
 * Fail-closed answer to an unknown `BUNDLE_DELIVERY_PROVIDER` value. A typo
 * must never silently fall back to the simulator, or a production deployment
 * could record fake deliveries for real money (the exact failure mode the
 * payments layer refuses with its live-misconfigured rule).
 */
export class MisconfiguredDeliveryProvider implements BundleDeliveryProvider {
  readonly id = "misconfigured";
  constructor(private readonly configuredValue: string) {}

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    void request;
    return {
      ok: false,
      error: `BUNDLE_DELIVERY_PROVIDER is set to an unknown provider "${this.configuredValue}". No top-up was sent; set it to "simulator" or "techchief".`,
    };
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    void request;
    return { status: "processing" };
  }
}

export const BUNDLE_DELIVERY_PROVIDER_ENV = "BUNDLE_DELIVERY_PROVIDER";

/**
 * Resolves the configured provider. Default (unset or "simulator") is the
 * simulated provider; "techchief" selects the Stage 5 stub; anything else
 * fails closed.
 */
export function getBundleDeliveryProvider(): BundleDeliveryProvider {
  const raw = (process.env[BUNDLE_DELIVERY_PROVIDER_ENV] ?? "simulator")
    .trim()
    .toLowerCase();
  if (raw === "" || raw === "simulator") return new SimulatedProvider();
  if (raw === "techchief") return new TechChiefProvider();
  return new MisconfiguredDeliveryProvider(raw);
}

export interface BundleDeliveryAvailability {
  /** Which provider is currently selected ("simulator", "techchief", …). */
  provider: string;
  /**
   * True only when the selected provider moves REAL data for real money:
   * a TechChief adapter holding a key from a `verified` connection. The
   * simulator, the keyless TechChief stub and the misconfigured fail-closed
   * provider are all false, so the checkout route refuses live-money bundle
   * orders until a shop has really connected (I1).
   */
  live: boolean;
}

export function bundleDeliveryAvailability(
  provider: BundleDeliveryProvider = getBundleDeliveryProvider(),
): BundleDeliveryAvailability {
  return { provider: provider.id, live: provider.live === true };
}

/**
 * Provider selection for one order — the single decision point (Stage 5).
 *
 * A TechChief adapter is returned only when **both** hold: the order was paid
 * with real money (`paymentMode === "live"`) and this website has a TechChief
 * connection whose status is `verified` with a readable key. Everything else
 * falls back to the environment default, which is the simulator unless
 * `BUNDLE_DELIVERY_PROVIDER` says otherwise.
 *
 * The rule that matters most is the one this makes impossible: **a TEST-mode
 * order never touches TechChief, even when a key is saved.** Test mode exists
 * so an owner can rehearse the whole flow without spending money, and a
 * rehearsal that quietly bought a real 1 GB bundle for a stranger's phone
 * would be the worst possible surprise.
 */
export async function resolveProviderForOrder(
  order: Pick<OrderRecord, "paymentMode" | "draftId">,
  deps: { integrations?: IntegrationsStore } = {},
): Promise<BundleDeliveryProvider> {
  if (order.paymentMode === "live") {
    const store = deps.integrations ?? getIntegrationsStore();
    // A connection read failure must never break dispatch: fall back to the
    // environment default, whose live-money backstop then records the truth.
    const integration = await getTechChiefIntegrationWithKey(
      order.draftId,
      store,
    ).catch(() => null);
    if (
      integration &&
      integration.status === "verified" &&
      integration.apiKey
    ) {
      return new TechChiefProvider(
        {
          apiKey: integration.apiKey,
          integrationId: integration.id,
          draftId: order.draftId,
        },
        { integrations: store },
      );
    }
  }
  return getBundleDeliveryProvider();
}

/**
 * Whether THIS website can deliver for real money — what the checkout route
 * asks before accepting a live bundle order. Unlike the environment-level
 * {@link bundleDeliveryAvailability}, this reads the shop's own connection, so
 * one shop being connected never unlocks live sales for another.
 */
export async function bundleDeliveryAvailabilityForDraft(
  draftId: string,
  deps: { integrations?: IntegrationsStore } = {},
): Promise<BundleDeliveryAvailability> {
  const store = deps.integrations ?? getIntegrationsStore();
  const integration = await getTechChiefIntegration(draftId, store).catch(
    () => null,
  );
  if (integration && integration.status === "verified") {
    return { provider: "techchief", live: true };
  }
  return bundleDeliveryAvailability(getBundleDeliveryProvider());
}

/**
 * Status checks go to the provider that owns the row's reference.
 *
 * A row dispatched through TechChief is polled with that shop's key, resolved
 * from the order's own draft — never with another website's connection. A
 * TechChief row on an order that is not live is skipped entirely: whatever
 * created it, a test-mode order must not cause a call to the wholesaler.
 */
async function providerForRow(
  row: BundleDeliveryRecord,
  ctx: EnginePassContext,
): Promise<BundleDeliveryProvider | null> {
  if (row.provider === ctx.provider.id) return ctx.provider;
  if (row.provider === "simulator") return new SimulatedProvider();
  if (row.provider === "techchief") {
    if (ctx.order.paymentMode !== "live") return null;
    const resolved = await resolveProviderForOrder(ctx.order, {
      integrations: ctx.integrations,
    });
    return resolved.live ? resolved : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface BundleDeliveriesStore {
  /**
   * Idempotent row creation (I2): rows that already exist for
   * (order_id, line_index, unit_index) are left alone; returns the full list
   * for the order.
   */
  createMany(inputs: NewBundleDeliveryInput[]): Promise<BundleDeliveryRecord[]>;
  listForOrder(orderId: string): Promise<BundleDeliveryRecord[]>;
  getById(id: string): Promise<BundleDeliveryRecord | null>;
  /**
   * Rows carrying a given provider reference — the TechChief webhook's only
   * handle on a delivery (their `order_ref`). Callers must still check that
   * the row's order belongs to the connection that was called back, so a
   * reference guessed for one shop can never move another shop's row.
   */
  listByProviderRef(providerRef: string): Promise<BundleDeliveryRecord[]>;
  /**
   * pending | failed → processing, atomically, counting the attempt. Returns
   * true only for the one caller that actually moved the row — the single
   * mechanism that makes a concurrent webhook dispatch and page-load recheck
   * (or two retries) unable to hand the same unit to the provider twice (I2).
   * The provider reference is cleared here and re-set by `setProviderRef`
   * once the provider has accepted the send.
   */
  claimForDispatch(id: string, patch: { provider: string }): Promise<boolean>;
  /**
   * Heartbeat for a row that was polled and is still in flight: moves
   * `updated_at` without touching the status, so a provider that throttles on
   * `updated_at` does not ask again for another interval. Rows that are not
   * "processing" are left alone — a delivered row never changes (I3).
   */
  touchProcessing(id: string): Promise<void>;
  /** Records the provider's reference after a successful send. */
  setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null>;
  /**
   * → failed: an attempt went wrong (I4). Accepts pending (never-yet-sent
   * rows, e.g. the live-provider backstop), processing and failed (a retry
   * that failed again — the error is refreshed in place). Attempt counting
   * lives in `claimForDispatch`, so this never bumps the counter.
   */
  markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null>;
  /** pending | processing → delivered: terminal (I3); failed rows are not resurrectable — only an explicit retry moves them. */
  markDelivered(id: string): Promise<BundleDeliveryRecord | null>;
}

// ----------------------------- SQLite --------------------------------------

interface DeliveryRow {
  id: string;
  order_id: string;
  owner_id: string;
  line_index: number;
  unit_index: number;
  item_id: string;
  item_name: string;
  network: string;
  data_mb: number;
  validity: string | null;
  recipient_phone: string;
  provider: string;
  status: string;
  attempts: number;
  provider_ref: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDelivery(row: DeliveryRow): BundleDeliveryRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    ownerId: row.owner_id,
    lineIndex: row.line_index,
    unitIndex: row.unit_index,
    itemId: row.item_id,
    itemName: row.item_name,
    network: row.network as BundleNetworkId,
    dataMb: row.data_mb,
    validity: row.validity ?? undefined,
    recipientPhone: row.recipient_phone,
    provider: row.provider,
    status: isDeliveryStatus(row.status) ? row.status : "pending",
    attempts: row.attempts,
    providerRef: row.provider_ref ?? undefined,
    lastError: row.last_error ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates the deliveries table on the shared SQLite connection. Idempotent —
 * safe to call on every store access, like the orders schema.
 */
export function ensureBundleDeliveriesSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_deliveries (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      unit_index INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      network TEXT NOT NULL,
      data_mb INTEGER NOT NULL,
      validity TEXT,
      recipient_phone TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'simulator',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_ref TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_deliveries_order ON studio_deliveries(order_id);
    CREATE INDEX IF NOT EXISTS studio_deliveries_owner_created ON studio_deliveries(owner_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS studio_deliveries_order_line_unit ON studio_deliveries(order_id, line_index, unit_index);
    CREATE INDEX IF NOT EXISTS studio_deliveries_provider_ref ON studio_deliveries(provider_ref);
  `);
}

export class SqliteBundleDeliveriesStore implements BundleDeliveriesStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensureBundleDeliveriesSchema(store.connection);
    return store.connection;
  }

  async createMany(
    inputs: NewBundleDeliveryInput[],
  ): Promise<BundleDeliveryRecord[]> {
    if (inputs.length === 0) return [];
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO studio_deliveries(
         id, order_id, owner_id, line_index, unit_index, item_id, item_name,
         network, data_mb, validity, recipient_phone, provider, status,
         attempts, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?)`,
    );
    for (const input of inputs) {
      insert.run(
        randomUUID(),
        input.orderId,
        input.ownerId,
        input.lineIndex,
        input.unitIndex,
        input.itemId,
        input.itemName,
        input.network,
        input.dataMb,
        input.validity ?? null,
        input.recipientPhone,
        input.provider,
        now,
        now,
      );
    }
    return this.listForOrder(inputs[0].orderId);
  }

  async listForOrder(orderId: string): Promise<BundleDeliveryRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_deliveries WHERE order_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(orderId) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  async getById(id: string): Promise<BundleDeliveryRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM studio_deliveries WHERE id = ?")
      .get(id) as unknown as DeliveryRow | undefined;
    return row ? rowToDelivery(row) : null;
  }

  async listByProviderRef(
    providerRef: string,
  ): Promise<BundleDeliveryRecord[]> {
    if (!providerRef) return [];
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_deliveries WHERE provider_ref = ? ORDER BY created_at ASC, id ASC",
      )
      .all(providerRef) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  async claimForDispatch(
    id: string,
    patch: { provider: string },
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'processing', provider = ?, provider_ref = NULL,
                last_error = NULL, delivered_at = NULL,
                attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status IN ('pending','failed')`,
      )
      .run(patch.provider, new Date().toISOString(), id);
    return result.changes === 1;
  }

  async touchProcessing(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE studio_deliveries SET updated_at = ?
          WHERE id = ? AND status = 'processing'`,
      )
      .run(new Date().toISOString(), id);
  }

  async setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null> {
    this.db
      .prepare(
        `UPDATE studio_deliveries
            SET provider_ref = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'`,
      )
      .run(providerRef, new Date().toISOString(), id);
    return this.getById(id);
  }

  async markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null> {
    this.db
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'failed', last_error = ?, delivered_at = NULL,
                updated_at = ?
          WHERE id = ? AND status IN ('pending','processing','failed')`,
      )
      .run(patch.error, new Date().toISOString(), id);
    return this.getById(id);
  }

  async markDelivered(id: string): Promise<BundleDeliveryRecord | null> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE studio_deliveries
            SET status = 'delivered', delivered_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','processing')`,
      )
      .run(now, now, id);
    return this.getById(id);
  }
}

// --------------------------- PostgreSQL ------------------------------------

function pgRowToDelivery(
  row: typeof studioDeliveries.$inferSelect,
): BundleDeliveryRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    ownerId: row.ownerId,
    lineIndex: row.lineIndex,
    unitIndex: row.unitIndex,
    itemId: row.itemId,
    itemName: row.itemName,
    network: row.network as BundleNetworkId,
    dataMb: row.dataMb,
    validity: row.validity ?? undefined,
    recipientPhone: row.recipientPhone,
    provider: row.provider,
    status: isDeliveryStatus(row.status) ? row.status : "pending",
    attempts: row.attempts,
    providerRef: row.providerRef ?? undefined,
    lastError: row.lastError ?? undefined,
    deliveredAt: row.deliveredAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresBundleDeliveriesStore implements BundleDeliveriesStore {
  async createMany(
    inputs: NewBundleDeliveryInput[],
  ): Promise<BundleDeliveryRecord[]> {
    if (inputs.length === 0) return [];
    await getDatabase()
      .insert(studioDeliveries)
      .values(
        inputs.map((input) => ({
          orderId: input.orderId,
          ownerId: input.ownerId,
          lineIndex: input.lineIndex,
          unitIndex: input.unitIndex,
          itemId: input.itemId,
          itemName: input.itemName,
          network: input.network,
          dataMb: input.dataMb,
          validity: input.validity ?? null,
          recipientPhone: input.recipientPhone,
          provider: input.provider,
        })),
      )
      .onConflictDoNothing({
        target: [
          studioDeliveries.orderId,
          studioDeliveries.lineIndex,
          studioDeliveries.unitIndex,
        ],
      });
    return this.listForOrder(inputs[0].orderId);
  }

  async listForOrder(orderId: string): Promise<BundleDeliveryRecord[]> {
    const rows = await getDatabase()
      .select()
      .from(studioDeliveries)
      .where(eq(studioDeliveries.orderId, orderId))
      .orderBy(asc(studioDeliveries.createdAt), asc(studioDeliveries.id));
    return rows.map(pgRowToDelivery);
  }

  async getById(id: string): Promise<BundleDeliveryRecord | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioDeliveries)
      .where(eq(studioDeliveries.id, id))
      .limit(1);
    return row ? pgRowToDelivery(row) : null;
  }

  async listByProviderRef(
    providerRef: string,
  ): Promise<BundleDeliveryRecord[]> {
    if (!providerRef) return [];
    const rows = await getDatabase()
      .select()
      .from(studioDeliveries)
      .where(eq(studioDeliveries.providerRef, providerRef))
      .orderBy(asc(studioDeliveries.createdAt), asc(studioDeliveries.id));
    return rows.map(pgRowToDelivery);
  }

  async claimForDispatch(
    id: string,
    patch: { provider: string },
  ): Promise<boolean> {
    const claimed = await getDatabase()
      .update(studioDeliveries)
      .set({
        status: "processing",
        provider: patch.provider,
        providerRef: null,
        lastError: null,
        deliveredAt: null,
        attempts: sql`${studioDeliveries.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDeliveries.id, id),
          inArray(studioDeliveries.status, ["pending", "failed"]),
        ),
      )
      .returning({ id: studioDeliveries.id });
    return claimed.length === 1;
  }

  async touchProcessing(id: string): Promise<void> {
    await getDatabase()
      .update(studioDeliveries)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(studioDeliveries.id, id),
          eq(studioDeliveries.status, "processing"),
        ),
      );
  }

  async setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null> {
    await getDatabase()
      .update(studioDeliveries)
      .set({ providerRef, updatedAt: new Date() })
      .where(
        and(
          eq(studioDeliveries.id, id),
          eq(studioDeliveries.status, "processing"),
        ),
      );
    return this.getById(id);
  }

  async markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null> {
    await getDatabase()
      .update(studioDeliveries)
      .set({
        status: "failed",
        lastError: patch.error,
        deliveredAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioDeliveries.id, id),
          inArray(studioDeliveries.status, ["pending", "processing", "failed"]),
        ),
      );
    return this.getById(id);
  }

  async markDelivered(id: string): Promise<BundleDeliveryRecord | null> {
    const now = new Date();
    await getDatabase()
      .update(studioDeliveries)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(
        and(
          eq(studioDeliveries.id, id),
          inArray(studioDeliveries.status, ["pending", "processing"]),
        ),
      );
    return this.getById(id);
  }
}

export function getBundleDeliveriesStore(): BundleDeliveriesStore {
  if (process.env.DATABASE_URL) return new PostgresBundleDeliveriesStore();
  return new SqliteBundleDeliveriesStore();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Injectable seams for tests; production callers use the defaults. */
export interface BundleDeliveryDeps {
  orders?: OrdersStore;
  deliveries?: BundleDeliveriesStore;
  provider?: BundleDeliveryProvider;
  /** Connection store used when the provider has to be resolved per order. */
  integrations?: IntegrationsStore;
  /** Replaces the merchant alert in tests; defaults to the real notifier. */
  notifyDeliveryFailed?: (
    input: MerchantDeliveryFailureInput,
  ) => Promise<unknown>;
}

interface ResolvedBundleLine {
  line: OrderLine;
  lineIndex: number;
  network: BundleNetworkId;
  dataMb: number;
  validity?: string;
}

/** True when any order line lacks a usable checkout-time bundle snapshot. */
function needsCatalogueFallback(order: OrderRecord): boolean {
  return order.lines.some((line) => {
    const networkOk =
      !!line.bundle?.network && isBundleNetworkId(line.bundle.network);
    const dataOk =
      typeof line.bundle?.dataMb === "number" && line.bundle.dataMb > 0;
    return !networkOk || !dataOk;
  });
}

/**
 * Resolves what each line must deliver. The checkout-time snapshot on the
 * order line is authoritative — a later catalogue edit can never change what
 * a paid order owes the customer. The draft catalogue is only consulted for
 * orders paid before Stage 4 (their lines carry no snapshot yet).
 */
function resolveBundleLines(
  order: OrderRecord,
  draftItems: Map<string, CatalogItem> | null,
): ResolvedBundleLine[] {
  const resolved: ResolvedBundleLine[] = [];
  order.lines.forEach((line, lineIndex) => {
    let network: BundleNetworkId | null = null;
    let dataMb: number | null = null;
    let validity: string | undefined;

    if (line.bundle) {
      if (line.bundle.network && isBundleNetworkId(line.bundle.network)) {
        network = line.bundle.network;
      }
      if (
        typeof line.bundle.dataMb === "number" &&
        Number.isFinite(line.bundle.dataMb) &&
        line.bundle.dataMb > 0
      ) {
        dataMb = Math.round(line.bundle.dataMb);
      }
      validity = line.bundle.validity || undefined;
    }

    if ((!network || !dataMb) && draftItems) {
      const item = draftItems.get(line.itemId);
      if (item) {
        if (!network) network = getBundleNetwork(item);
        if (!dataMb) dataMb = guessDataMbFromItem(item);
        if (!validity) validity = item.bundle?.validity || undefined;
      }
    }

    if (network && dataMb) {
      resolved.push({ line, lineIndex, network, dataMb, validity });
    }
  });
  return resolved;
}

/**
 * Ensures the one-row-per-paid-bundle-unit state exists (I1, I2, I5): every
 * resolved order line is expanded into `quantity` unit rows. Returns null
 * when the order is not deliverable — not paid, no recipient, or not a
 * data-bundles order — so callers share one cheap shape for "nothing to do".
 */
async function ensureBundleDeliveryRows(
  order: OrderRecord,
  provider: BundleDeliveryProvider,
  store: BundleDeliveriesStore,
): Promise<BundleDeliveryRecord[] | null> {
  // I1: payment first. Replay-safe because markPaid only ever transitions
  // pending/payment_failed → paid, so this runs exactly when money arrived.
  if (order.status !== "paid") return null;
  // I5 fast gate: only bundle checkouts ever store a recipient number.
  const recipientPhone = order.recipientPhone;
  if (!recipientPhone) return null;

  let draftItems: Map<string, CatalogItem> | null = null;
  if (needsCatalogueFallback(order)) {
    const draft = await publicGetDraft(order.draftId).catch(() => null);
    // A deleted draft blocks the legacy fallback, never the page or webhook.
    if (!draft) return null;
    // I5 explicit veto behind the legacy path: only data-bundles websites.
    if (draft.brief.category !== "data-bundles") return null;
    draftItems = new Map(draft.brief.items.map((item) => [item.id, item]));
  }

  const resolved = resolveBundleLines(order, draftItems);
  if (resolved.length === 0) return null;

  const inputs: NewBundleDeliveryInput[] = [];
  for (const { line, lineIndex, network, dataMb, validity } of resolved) {
    const quantity =
      Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1;
    for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
      inputs.push({
        orderId: order.id,
        ownerId: order.ownerId,
        lineIndex,
        unitIndex,
        itemId: line.itemId,
        itemName: line.name,
        network,
        dataMb,
        validity,
        recipientPhone,
        provider: provider.id,
      });
    }
  }
  return store.createMany(inputs);
}

/** A provider throw is a delivery failure, never a caller failure (I4). */
async function safeSend(
  provider: BundleDeliveryProvider,
  request: BundleDeliveryDispatchRequest,
): Promise<BundleDeliverySendResult> {
  try {
    return await provider.sendBundle(request);
  } catch {
    return {
      ok: false,
      error:
        "The delivery provider could not be reached. The top-up was not sent.",
    };
  }
}

/** Live-money orders must never be sent through a non-live provider (I1). */
export const NO_LIVE_DELIVERY_PROVIDER_MESSAGE =
  "No real delivery provider is connected; nothing was sent.";

/**
 * What a live-money bundle checkout is told while no live delivery provider
 * exists (Stage 5 makes it live-capable). Shown before any order row exists.
 */
export const LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE =
  "This shop cannot send bundles automatically yet. Please contact the shop.";

interface EnginePassContext {
  /** The order this pass is for — provider resolution and alerts need it. */
  order: OrderRecord;
  provider: BundleDeliveryProvider;
  deliveries: BundleDeliveriesStore;
  /** Connection store shared by the pass, so tests can inject one. */
  integrations?: IntegrationsStore;
  /** True when the order was paid with real money but no live provider exists. */
  liveBlocked: boolean;
  /** Rows that entered "failed" during this pass (alert candidates, I4). */
  newlyFailed: BundleDeliveryRecord[];
}

function dispatchRequestFor(
  row: BundleDeliveryRecord,
): BundleDeliveryDispatchRequest {
  return {
    orderId: row.orderId,
    deliveryId: row.id,
    attempt: row.attempts + 1,
    lineIndex: row.lineIndex,
    unitIndex: row.unitIndex,
    recipientPhone: row.recipientPhone,
    network: row.network,
    dataMb: row.dataMb,
    validity: row.validity,
  };
}

/** Sends every "pending" unit row to the provider and records the outcome. */
async function dispatchPendingRows(
  rows: BundleDeliveryRecord[],
  ctx: EnginePassContext,
): Promise<void> {
  for (const row of rows) {
    if (row.status !== "pending") continue;
    if (ctx.liveBlocked) {
      const failed = await ctx.deliveries.markFailed(row.id, {
        error: NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
      });
      if (failed) ctx.newlyFailed.push(failed);
      continue;
    }
    // Claim-before-send: exactly one concurrent caller moves the row to
    // "processing" and gets to send; every loser simply skips this unit (I2).
    if (
      !(await ctx.deliveries.claimForDispatch(row.id, {
        provider: ctx.provider.id,
      }))
    ) {
      continue;
    }
    const result = await safeSend(ctx.provider, dispatchRequestFor(row));
    if (result.ok) {
      await ctx.deliveries.setProviderRef(row.id, result.providerRef ?? null);
    } else {
      const failed = await ctx.deliveries.markFailed(row.id, {
        error: result.error,
      });
      if (failed) ctx.newlyFailed.push(failed);
    }
  }
}

/**
 * How many in-flight rows ONE recheck pass may ask a provider about (Stage 4b).
 *
 * A recheck runs on every load of the owner's order page and of the
 * unauthenticated guest confirmation page, so without a ceiling the cost of a
 * page load scales with the size of the order: an order created before the
 * basket caps, or one with many lines, would mean one provider call per row
 * per refresh. The rows that wait longest go first, so a busy order works
 * through its queue steadily instead of always re-asking about the newest
 * top-ups. Rows that cannot be polled yet (no provider reference) are skipped
 * and do **not** consume the budget — otherwise a row stuck without a
 * reference would permanently hold a slot at the front of the queue.
 *
 * This bounds one pass only; TechChief's own 50-request hourly budget and the
 * 10-minute per-row throttle inside the provider still apply on top of it.
 */
export const MAX_PROCESSING_POLLS_PER_PASS = 25;

/** Polls the provider for "processing" rows; transient outages are simply retried on the next recheck. */
async function refreshProcessingRows(
  rows: BundleDeliveryRecord[],
  ctx: EnginePassContext,
): Promise<void> {
  if (ctx.liveBlocked) return; // nothing to poll without a live provider
  // Oldest first: `updated_at` moves when a row is polled (the heartbeat) or
  // settled, so this is a fair queue rather than whatever order the database
  // happened to return.
  const inFlight = rows
    .filter((row) => row.status === "processing")
    .sort(
      (a, b) => (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0),
    );
  let polls = 0;
  for (const row of inFlight) {
    if (polls >= MAX_PROCESSING_POLLS_PER_PASS) break;
    const rowProvider = await providerForRow(row, ctx);
    if (!rowProvider || !row.providerRef) continue;
    polls += 1;
    let outcome: BundleDeliveryStatusResult;
    try {
      outcome = await rowProvider.checkStatus({
        providerRef: row.providerRef,
        deliveryId: row.id,
        // The row's own timestamps are what let a billed provider throttle
        // itself: TechChief polls at most once per 10 minutes per row.
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
      });
    } catch {
      continue;
    }
    if (outcome.status === "delivered") {
      await ctx.deliveries.markDelivered(row.id); // terminal (I3)
    } else if (outcome.status === "failed") {
      const failed = await ctx.deliveries.markFailed(row.id, {
        error: outcome.error || "The delivery provider reported a failure.",
      });
      if (failed) ctx.newlyFailed.push(failed);
    } else if (outcome.polled) {
      // Still in flight, but we really did ask: record the heartbeat so the
      // provider's own throttle keeps the next page load free.
      await ctx.deliveries.touchProcessing(row.id);
    }
  }
}

/**
 * One aggregated merchant alert per engine pass when at least one row
 * entered "failed" during this pass (I4). Rows that were already failed when
 * the pass started are never re-alerted. Alerts are best-effort and can
 * never break the engine — same discipline as the new-order notification.
 */
async function alertMerchantIfNeeded(
  order: OrderRecord,
  ctx: EnginePassContext,
  deps: BundleDeliveryDeps,
): Promise<void> {
  if (ctx.newlyFailed.length === 0) return;
  try {
    const draft = await publicGetDraft(order.draftId).catch(() => null);
    if (!draft) return;
    const total = (await ctx.deliveries.listForOrder(order.id)).length;
    const notify = deps.notifyDeliveryFailed ?? notifyMerchantDeliveryFailed;
    await notify({
      order,
      brief: draft.brief,
      deliveries: ctx.newlyFailed,
      total,
    }).catch(() => "failed");
  } catch {
    /* An alert must never break the engine (I4). */
  }
}

function passContext(
  order: OrderRecord,
  provider: BundleDeliveryProvider,
  deliveries: BundleDeliveriesStore,
  integrations?: IntegrationsStore,
): EnginePassContext {
  return {
    order,
    provider,
    deliveries,
    integrations,
    liveBlocked:
      order.paymentMode === "live" &&
      !bundleDeliveryAvailability(provider).live,
    newlyFailed: [],
  };
}

/**
 * Creates (idempotently) and dispatches the deliveries for a paid bundle
 * order. Called fire-and-forget by the payments webhook immediately after
 * `markPaid`: the webhook's caller must never wait on — or be failed by — the
 * delivery provider, and replayed webhooks re-run this safely.
 */
export async function dispatchBundleDeliveriesForOrder(
  orderId: string,
  deps: BundleDeliveryDeps = {},
): Promise<BundleDeliveryRecord[]> {
  const orders = deps.orders ?? getOrdersStore();
  const deliveries = deps.deliveries ?? getBundleDeliveriesStore();
  const order = await orders.getById(orderId);
  if (!order) return [];
  const provider =
    deps.provider ?? (await resolveProviderForOrder(order, deps));
  const rows = await ensureBundleDeliveryRows(order, provider, deliveries);
  if (!rows) return [];
  const ctx = passContext(order, provider, deliveries, deps.integrations);
  await dispatchPendingRows(rows, ctx);
  await alertMerchantIfNeeded(order, ctx, deps);
  return deliveries.listForOrder(order.id);
}

/**
 * Reconciliation pass for order-page loads ("recheckPending"). It recovers
 * rows that could not be created or dispatched when payment landed (process
 * restart, provider outage), flushes anything stuck at "pending", and polls
 * the provider about anything "processing". It never throws: the owner order
 * page and the guest confirmation page render with or without it.
 */
export async function recheckBundleDeliveriesForOrder(
  orderId: string,
  deps: BundleDeliveryDeps = {},
): Promise<BundleDeliveryRecord[]> {
  try {
    const orders = deps.orders ?? getOrdersStore();
    const deliveries = deps.deliveries ?? getBundleDeliveriesStore();
    const order = await orders.getById(orderId);
    if (!order) return [];
    const provider =
      deps.provider ?? (await resolveProviderForOrder(order, deps));
    const rows = await ensureBundleDeliveryRows(order, provider, deliveries);
    if (!rows) return [];
    const ctx = passContext(order, provider, deliveries, deps.integrations);
    await dispatchPendingRows(rows, ctx);
    await refreshProcessingRows(await deliveries.listForOrder(order.id), ctx);
    await alertMerchantIfNeeded(order, ctx, deps);
    return deliveries.listForOrder(order.id);
  } catch {
    return [];
  }
}

/** Raised when Retry is requested for an order whose payment is not settled. */
export class BundleDeliveryRetryError extends ConflictError {
  constructor(status: OrderStatus) {
    super(
      `Bundle top-ups can only be retried on a paid order; this order is "${status}".`,
    );
    this.name = "BundleDeliveryRetryError";
  }
}

/**
 * The owner's Retry button. Re-dispatches only the rows at "failed" (I4) on
 * an explicit request; rows at "processing" are left to rechecks and rows at
 * "delivered" are never touched (I3). Returns null for a cross-tenant or
 * unknown order — owner scoping happens before any delivery is revealed.
 */
export async function retryBundleDeliveryFailures(
  ownerId: string,
  orderId: string,
  deps: BundleDeliveryDeps = {},
): Promise<{
  order: OrderRecord;
  deliveries: BundleDeliveryRecord[];
} | null> {
  const orders = deps.orders ?? getOrdersStore();
  const deliveries = deps.deliveries ?? getBundleDeliveriesStore();
  const order = await orders.getForOwner(ownerId, orderId);
  if (!order) return null;
  if (order.status !== "paid") throw new BundleDeliveryRetryError(order.status);

  const provider =
    deps.provider ?? (await resolveProviderForOrder(order, deps));
  const rows = await deliveries.listForOrder(order.id);
  const ctx = passContext(order, provider, deliveries, deps.integrations);
  for (const row of rows) {
    if (row.status !== "failed") continue;
    if (ctx.liveBlocked) {
      // Never pretend a send happened: row stays failed with the reason.
      await deliveries.markFailed(row.id, {
        error: NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
      });
      continue;
    }
    if (!(await deliveries.claimForDispatch(row.id, { provider: provider.id })))
      continue;
    const result = await safeSend(provider, dispatchRequestFor(row));
    if (result.ok) {
      await deliveries.setProviderRef(row.id, result.providerRef ?? null);
    } else {
      const failed = await deliveries.markFailed(row.id, {
        error: result.error,
      });
      if (failed) ctx.newlyFailed.push(failed);
    }
  }
  await alertMerchantIfNeeded(order, ctx, deps);
  return { order, deliveries: await deliveries.listForOrder(order.id) };
}

// ---------------------------------------------------------------------------
// Guest-safe aggregate (I6)
// ---------------------------------------------------------------------------

export interface GuestBundleDeliverySummary {
  totalTopUps: number;
  deliveredTopUps: number;
  failedTopUps: number;
  totalDataMb: number;
  /** The single masked line rendered on the unauthenticated confirmation page. */
  line: string;
}

/**
 * Builds the one aggregate line a guest may see. The input is narrowed to the
 * fields needed, and the recipient reaches the output only through
 * `maskGhanaMobile` — so full phone numbers, provider references, attempt
 * counts and error text cannot leak onto an unauthenticated page (I6).
 */
export function guestBundleDeliverySummary(
  deliveries: ReadonlyArray<Pick<BundleDeliveryRecord, "status" | "dataMb">>,
  recipientPhone: string | null | undefined,
): GuestBundleDeliverySummary | null {
  if (deliveries.length === 0 || !recipientPhone) return null;

  const masked = maskGhanaMobile(recipientPhone);
  const total = deliveries.length;
  const delivered = deliveries.filter(
    (row) => row.status === "delivered",
  ).length;
  const failed = deliveries.filter((row) => row.status === "failed").length;
  const totalDataMb = deliveries.reduce((sum, row) => sum + row.dataMb, 0);
  const size = formatDataMb(totalDataMb);

  let line: string;
  if (delivered === total) {
    line =
      total === 1
        ? `${size} top-up delivered to ${masked}`
        : `All ${total} top-ups (${size}) delivered to ${masked}`;
  } else if (failed > 0 && delivered === 0) {
    line =
      total === 1
        ? `The ${size} top-up for ${masked} hit a problem — the shop can retry it.`
        : `Top-ups for ${masked} hit a problem — the shop can retry them (${size} total).`;
  } else if (failed > 0) {
    line = `${delivered} of ${total} top-ups delivered to ${masked}; ${failed} hit a problem — the shop can retry it.`;
  } else {
    line = `Sending ${size} of data to ${masked} — ${delivered} of ${total} delivered so far.`;
  }

  return {
    totalTopUps: total,
    deliveredTopUps: delivered,
    failedTopUps: failed,
    totalDataMb,
    line,
  };
}
