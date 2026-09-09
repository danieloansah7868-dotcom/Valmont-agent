/**
 * Stage 6d — the shop's Supplier page vocabulary and projection.
 *
 * The shop admin side never touches the TechChief key beyond the stored
 * 9-character prefix, never sees the webhook URL, and never calls TechChief
 * on page load. Everything this module exposes is either display wording or
 * the {@link shopSupplierView} projection built from the no-secret
 * `StudioIntegration` record (`getTechChiefIntegration`), so a route can
 * never accidentally serialise the decrypted key, the webhook secret or the
 * agency owner id — the projection simply has nowhere to put them.
 */

import type { StudioIntegration } from "@/lib/studio/integrations";
import { TECHCHIEF_HOURLY_LIMIT } from "@/lib/studio/integrations";

/** Where the owner tops up their wallet. External link, new tab. */
export const TECHCHIEF_PORTAL_URL = "https://techchiefxdata.com/";

/**
 * Stage 6d refresh rules. "Refresh balance" re-probes TechChief's wallet, so
 * it both spends a slice of the website's 60/hour TechChief allowance AND
 * must not be spammable: at most {@link SHOP_SUPPLIER_REFRESH_PER_HOUR}
 * refreshes per website per hour, and never more often than
 * {@link SHOP_SUPPLIER_REFRESH_MIN_INTERVAL_MS} apart — two staff members
 * refreshing together would otherwise burn real allowance for nothing.
 */
export const SHOP_SUPPLIER_REFRESH_RATE_LIMIT_OPERATION =
  "shop-supplier-refresh";
export const SHOP_SUPPLIER_REFRESH_PER_HOUR = 6;
export const SHOP_SUPPLIER_REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** 429 sentence when a refresh is attempted within the 10-minute window. */
export const SUPPLIER_REFRESH_TOO_SOON_MESSAGE =
  "The balance was checked less than 10 minutes ago - try again later.";

/** The page's empty state: no TechChief key has been connected in Studio. */
export const SUPPLIER_NOT_CONNECTED_MESSAGE =
  "No supplier key is connected yet. Ask your agency to connect your TechChief key in Studio.";

/**
 * The refresh route's answer when the website has no key at all (404). Kept
 * in the same sentence family as {@link SUPPLIER_NOT_CONNECTED_MESSAGE} but
 * distinct, and identical to the wording `testTechChiefConnection` already
 * uses for its `not_connected` outcome, so the shop side always reads one
 * sentence for "no key saved yet".
 */
export const SUPPLIER_NOT_CONNECTED_API_MESSAGE =
  "This website has no TechChief key saved yet.";

/** Low-balance banner: real top-ups start failing when the wallet runs dry. */
export const SUPPLIER_LOW_BALANCE_MESSAGE =
  "Your TechChief wallet is low - top up before customers' top-ups start failing.";

/**
 * Everything the shop side may know about its supplier connection. The key
 * set is the whole contract: `webhookUrl`, `webhookSecretSet`,
 * `unmatchedItems`, `ownerId` and `id` are deliberately absent, and
 * `keyPrefix` is the stored 9-character prefix ("TCHX-AB12") that the page
 * renders with trailing bullets — never a longer slice of the key.
 */
export interface ShopSupplierView {
  connected: boolean;
  status: StudioIntegration["status"] | null;
  keyPrefix: string | null;
  walletBalance: number | null;
  lowBalance: boolean;
  accountStatus: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  bundleCount: number;
  bundlesSyncedAt: string | null;
  /** Requests already spent against TechChief in the current hour. */
  requestsThisHour: number;
  requestsPerHour: number;
}

/**
 * Builds the supplier view from a no-secret integration row (or null when the
 * website has no connection). Values are copied field by field — never a
 * spread of the integration — so a future column added to
 * `StudioIntegration` cannot leak onto the shop side by accident.
 */
export function shopSupplierView(
  integration: StudioIntegration | null,
): ShopSupplierView {
  return {
    connected: Boolean(integration),
    status: integration?.status ?? null,
    keyPrefix: integration?.keyPrefix ?? null,
    walletBalance: integration?.walletBalance ?? null,
    lowBalance: integration?.lowBalance ?? false,
    accountStatus: integration?.accountStatus ?? null,
    lastCheckedAt: integration?.lastCheckedAt ?? null,
    lastError: integration?.lastError ?? null,
    bundleCount: integration?.bundles.length ?? 0,
    bundlesSyncedAt: integration?.bundlesSyncedAt ?? null,
    requestsThisHour: integration?.pollCount ?? 0,
    requestsPerHour: TECHCHIEF_HOURLY_LIMIT,
  };
}
