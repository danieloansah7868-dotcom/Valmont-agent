/**
 * Data Bundles — Stage 5: per-website TechChief connections.
 *
 * One row per (website, provider) in `studio_integrations`. Each shop owner
 * pastes **their own** TechChief developer API key, so every website tops up
 * bundles from its own wallet and this deployment never holds a client's
 * float. What that means in practice, and the rules this module enforces:
 *
 *  1. **The key is encrypted at rest and invisible everywhere else.** It is
 *     stored as an AES-256-GCM envelope with `encryptSessionValue` — exactly
 *     the primitive `payment-settings.ts` uses for the Valmont Pay keys — and
 *     decrypted only on the server, only inside the delivery adapter. It is
 *     never logged, never returned by an API, never included in a Studio
 *     backup and never imported by a client component. The only part anybody
 *     ever sees again is the 9-character `key_prefix` ("TCHX-AB12•••").
 *  2. **Verified means probed.** A row reaches `status: "verified"` only after
 *     a live `dev_wallet.php` call answered `success` with `api_activated`
 *     and `account_status === "active"`. Nothing is stored when the probe
 *     fails, so a typo can never leave a half-connected shop behind. Only a
 *     verified row makes bundle delivery live for that website.
 *  3. **TechChief's 60 requests/hour is a shared budget.** Orders and status
 *     checks come out of the same allowance per key, so every call made on
 *     behalf of a draft goes through {@link consumeTechChiefBudget}: polls,
 *     wallet probes and bundle syncs stop at
 *     {@link TECHCHIEF_HOURLY_POLL_BUDGET} (50) and orders may use the last
 *     ten slots. Orders always go first — a shop that is selling must never be
 *     locked out of dispatch by its own status polling.
 *  4. **No safe retry exists upstream.** TechChief has no idempotency key, so
 *     after a timeout nobody knows whether the wallet was charged. This module
 *     never resends on its own; it records the outcome and leaves the decision
 *     to the owner ("check your TechChief dashboard before retrying").
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioIntegrations } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";
import { decryptSessionValue, encryptSessionValue } from "@/lib/security";
import {
  guessDataMbFromItem,
  getBundleNetwork,
  type BundleNetworkId,
} from "./bundles";
import type { SiteBriefV1 } from "./site-brief/schema";
import {
  getTechChiefWallet,
  listTechChiefBundles,
  matchTechChiefBundle,
  TECHCHIEF_NETWORKS,
  type TechChiefBundle,
  type TechChiefWallet,
} from "./techchief";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Which wholesaler a row connects. TechChief is the only one today. */
export const INTEGRATION_PROVIDERS = ["techchief"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = [
  "unverified",
  "verified",
  "error",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export function isIntegrationStatus(
  value: unknown,
): value is IntegrationStatus {
  return (
    typeof value === "string" &&
    (INTEGRATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * A connection as the rest of the server sees it. There is deliberately no
 * `apiKey` field: the plaintext key lives only in
 * {@link StudioIntegrationSecrets}, which is never returned from an API route
 * and never crosses into a component.
 */
export interface StudioIntegration {
  id: string;
  draftId: string;
  ownerId: string;
  provider: IntegrationProvider;
  /** The visible reminder of the saved key, e.g. "TCHX-AB12". */
  keyPrefix: string;
  /** True when a webhook signing secret is stored for this connection. */
  webhookSecretSet: boolean;
  status: IntegrationStatus;
  lastCheckedAt?: string;
  walletBalance: number | null;
  lowBalance: boolean;
  accountStatus?: string;
  lastError?: string;
  /** Cached wholesale price list from the last successful sync. */
  bundles: TechChiefBundle[];
  bundlesSyncedAt?: string;
  pollWindowStart?: string;
  pollCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Server-side only: the record plus the decrypted secrets. */
export interface StudioIntegrationSecrets extends StudioIntegration {
  apiKey: string;
  webhookSecret?: string;
}

/** What a new or updated row needs. Secrets arrive already encrypted. */
export interface IntegrationWrite {
  id?: string;
  draftId: string;
  ownerId: string;
  provider: IntegrationProvider;
  apiKeyEnc: string;
  keyPrefix: string;
  webhookSecretEnc?: string | null;
  status: IntegrationStatus;
  lastCheckedAt?: string | null;
  walletBalance?: number | null;
  lowBalance?: boolean;
  accountStatus?: string | null;
  lastError?: string | null;
  bundles?: TechChiefBundle[] | null;
  bundlesSyncedAt?: string | null;
  pollWindowStart?: string | null;
  pollCount?: number;
}

/** Fields a caller may change after the row exists. */
export type IntegrationPatch = Partial<
  Omit<IntegrationWrite, "id" | "draftId" | "ownerId" | "provider">
>;

// ---------------------------------------------------------------------------
// Key shape
// ---------------------------------------------------------------------------

/** TechChief keys look like `TCHX-` followed by the account's own characters. */
export const TECHCHIEF_KEY_PATTERN = /^TCHX-/;
/** Longest key we are willing to store (generous; theirs are short). */
export const TECHCHIEF_KEY_MAX_LENGTH = 200;
/** Longest webhook secret we are willing to store. */
export const TECHCHIEF_WEBHOOK_SECRET_MAX_LENGTH = 200;
/** How much of the key is ever shown again: "TCHX-AB12". */
export const TECHCHIEF_KEY_PREFIX_LENGTH = 9;

/**
 * The only part of a key that is ever displayed or logged. Nine characters
 * keeps the `TCHX-` marker plus four key characters — enough for an owner to
 * recognise which key they saved, far too short to be useful to anyone else,
 * and too short to trip the `TCHX-[A-Za-z0-9]{16,}` redaction pattern.
 */
export function techChiefKeyPrefix(apiKey: string): string {
  return apiKey.trim().slice(0, TECHCHIEF_KEY_PREFIX_LENGTH);
}

/** Format gate for a pasted key. The live probe is what actually proves it. */
export function isTechChiefKeyFormat(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length <= TECHCHIEF_KEY_MAX_LENGTH &&
    TECHCHIEF_KEY_PATTERN.test(value.trim())
  );
}

// ---------------------------------------------------------------------------
// Callback URL
// ---------------------------------------------------------------------------

/** The webhook path TechChief calls, with the connection id as its only key. */
export const TECHCHIEF_WEBHOOK_PATH = "/api/bundle-delivery/techchief/webhook";

export interface TechChiefCallback {
  /** Absolute https URL, or null when this deployment cannot offer one. */
  url: string | null;
  /** True when APP_URL is an https origin (TechChief only calls https). */
  https: boolean;
}

/**
 * Builds the callback URL for one connection.
 *
 * TechChief only POSTs to https endpoints, and `APP_URL` is the only trusted
 * source of this deployment's public origin (see `auth-redirect.ts`), so a
 * missing or non-https `APP_URL` yields `url: null`. Callers then omit
 * `callback_url` and fall back to polling — delivering without a callback is
 * slower, but inventing an http URL that TechChief will never call would be
 * worse.
 */
export function techChiefCallback(
  integrationId: string,
  appUrl: string | undefined = process.env.APP_URL,
): TechChiefCallback {
  const configured = appUrl?.trim();
  if (!configured) return { url: null, https: false };
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { url: null, https: false };
  }
  if (parsed.protocol !== "https:") return { url: null, https: false };
  const url = new URL(TECHCHIEF_WEBHOOK_PATH, parsed.origin);
  url.searchParams.set("integration", integrationId);
  return { url: url.toString(), https: true };
}

// ---------------------------------------------------------------------------
// Hourly request budget
// ---------------------------------------------------------------------------

/** TechChief's published ceiling: 60 requests per hour per key. */
export const TECHCHIEF_HOURLY_LIMIT = 60;
/**
 * What this deployment spends on everything except orders, leaving headroom
 * for the calls that actually move money. A busy shop that needs more must
 * ask TechChief to raise the limit.
 */
export const TECHCHIEF_HOURLY_POLL_BUDGET = 50;
export const TECHCHIEF_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/** What a budgeted call is for. Orders get the headroom; everything else waits. */
export type TechChiefRequestKind = "order" | "poll";

export type TechChiefBudgetDecision =
  | { allowed: true; remaining: number; spent: number }
  | { allowed: false; remaining: 0; spent: number; limit: number };

export const TECHCHIEF_BUDGET_EXHAUSTED_MESSAGE =
  "TechChief rate limit reached — Retry in a few minutes.";

/**
 * Claims one request against the connection's rolling hourly budget, counting
 * it in `poll_window_start` / `poll_count` on the row itself so the budget
 * survives a restart and is shared by every process serving the shop.
 *
 * The window rolls: once an hour has passed since `poll_window_start`, the
 * counter restarts. Polls, wallet probes and bundle syncs stop at
 * {@link TECHCHIEF_HOURLY_POLL_BUDGET}; orders may continue to
 * {@link TECHCHIEF_HOURLY_LIMIT}, because refusing a paid customer's top-up to
 * protect a status poll would be exactly backwards. Past TechChief's own
 * ceiling even orders stop — a local refusal costs nothing, while a 429 from
 * them costs a slot and tells the owner nothing useful.
 *
 * The counter is advisory under concurrency: two simultaneous claims can spend
 * one slot between them. TechChief's own 429 is the backstop, and it is mapped
 * to a retryable owner-visible error, so nothing here needs a lock.
 */
export async function consumeTechChiefBudget(
  store: IntegrationsStore,
  integrationId: string,
  kind: TechChiefRequestKind = "poll",
  now: number = Date.now(),
): Promise<TechChiefBudgetDecision> {
  const row = await store.getById(integrationId);
  if (!row) {
    return {
      allowed: false,
      remaining: 0,
      spent: 0,
      limit: TECHCHIEF_HOURLY_POLL_BUDGET,
    };
  }

  const windowStart = row.poll_window_start
    ? Date.parse(row.poll_window_start)
    : NaN;
  const fresh =
    Number.isFinite(windowStart) &&
    now - windowStart < TECHCHIEF_BUDGET_WINDOW_MS;
  const spent = fresh ? Number(row.poll_count ?? 0) : 0;
  const limit =
    kind === "order" ? TECHCHIEF_HOURLY_LIMIT : TECHCHIEF_HOURLY_POLL_BUDGET;

  if (spent >= limit) {
    return { allowed: false, remaining: 0, spent, limit };
  }

  await store.patch(integrationId, {
    pollWindowStart: fresh
      ? (row.poll_window_start ?? new Date(now).toISOString())
      : new Date(now).toISOString(),
    pollCount: spent + 1,
  });
  return { allowed: true, remaining: limit - spent - 1, spent: spent + 1 };
}

// ---------------------------------------------------------------------------
// Bundle cache
// ---------------------------------------------------------------------------

/** The cached price list is refreshed at most once a day per connection. */
export const TECHCHIEF_BUNDLE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** True when the cached list is missing or older than a day. */
export function bundleCacheIsStale(
  integration: Pick<StudioIntegration, "bundles" | "bundlesSyncedAt">,
  now: number = Date.now(),
): boolean {
  if (integration.bundles.length === 0) return true;
  if (!integration.bundlesSyncedAt) return true;
  const syncedAt = Date.parse(integration.bundlesSyncedAt);
  if (!Number.isFinite(syncedAt)) return true;
  return now - syncedAt > TECHCHIEF_BUNDLE_CACHE_MAX_AGE_MS;
}

/** Reads `bundles_json`, tolerating anything a previous version wrote. */
export function parseCachedBundles(value: unknown): TechChiefBundle[] {
  if (!value) return [];
  const parsed: unknown =
    typeof value === "string" ? safeJsonParse(value) : value;
  if (!Array.isArray(parsed)) return [];
  const bundles: TechChiefBundle[] = [];
  for (const entry of parsed) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = Number(item.id);
    const sizeGb = Number(item.sizeGb ?? item.size_gb);
    const price = Number(item.price);
    const network = item.network;
    if (
      !Number.isFinite(id) ||
      !Number.isFinite(sizeGb) ||
      !Number.isFinite(price) ||
      typeof network !== "string" ||
      !(TECHCHIEF_NETWORKS as readonly string[]).includes(network)
    ) {
      continue;
    }
    bundles.push({
      id: Math.trunc(id),
      network: network as TechChiefBundle["network"],
      sizeGb,
      validityDays: Number.isFinite(Number(item.validityDays))
        ? Number(item.validityDays)
        : null,
      price,
      currency: typeof item.currency === "string" ? item.currency : "GHS",
    });
  }
  return bundles;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catalogue matching
// ---------------------------------------------------------------------------

/** A catalogue item TechChief cannot deliver, as the owner sees it. */
export interface UnmatchedBundleItem {
  itemId: string;
  name: string;
  network: BundleNetworkId | null;
  dataMb: number | null;
  /** Plain-language reason, so the card can say what to do about it. */
  reason: string;
}

/**
 * Which of this shop's priced items have no TechChief bundle behind them.
 *
 * This is the honest answer to "can my shop actually deliver?": an item with
 * no network, no readable size, or a size TechChief does not sell (500 MB is
 * the classic — they start at 1 GB) can never be auto-delivered, and the owner
 * needs to see that list next to the balance rather than discover it when a
 * paying customer's top-up fails.
 */
export function unmatchedBundleItems(
  brief: Pick<SiteBriefV1, "items">,
  bundles: ReadonlyArray<TechChiefBundle>,
): UnmatchedBundleItem[] {
  const unmatched: UnmatchedBundleItem[] = [];
  for (const item of brief.items ?? []) {
    if (item.price === undefined) continue;
    const network = getBundleNetwork(item);
    const dataMb = guessDataMbFromItem(item);
    if (!network) {
      unmatched.push({
        itemId: item.id,
        name: item.name,
        network: null,
        dataMb,
        reason: "No network is set on this item.",
      });
      continue;
    }
    if (!dataMb) {
      unmatched.push({
        itemId: item.id,
        name: item.name,
        network,
        dataMb: null,
        reason: "No data size is set on this item.",
      });
      continue;
    }
    if (!matchTechChiefBundle(bundles, network, dataMb)) {
      unmatched.push({
        itemId: item.id,
        name: item.name,
        network,
        dataMb,
        reason: "TechChief does not sell this network and size.",
      });
    }
  }
  return unmatched;
}

// ---------------------------------------------------------------------------
// Storage — SQLite (default, shared Studio database) and PostgreSQL
// ---------------------------------------------------------------------------

/** The row exactly as the database holds it. Secrets are still encrypted. */
export interface IntegrationRow {
  id: string;
  draft_id: string;
  owner_id: string;
  provider: string;
  api_key_enc: string;
  key_prefix: string;
  webhook_secret_enc: string | null;
  status: string;
  last_checked_at: string | null;
  wallet_balance: number | null;
  low_balance: number | boolean;
  account_status: string | null;
  last_error: string | null;
  bundles_json: string | TechChiefBundle[] | null;
  bundles_synced_at: string | null;
  poll_window_start: string | null;
  poll_count: number;
  created_at: string;
  updated_at: string;
}

export interface IntegrationsStore {
  getForDraft(
    draftId: string,
    provider?: IntegrationProvider,
  ): Promise<IntegrationRow | null>;
  getById(id: string): Promise<IntegrationRow | null>;
  insert(write: IntegrationWrite): Promise<IntegrationRow | null>;
  patch(id: string, patch: IntegrationPatch): Promise<IntegrationRow | null>;
  remove(id: string): Promise<boolean>;
  /**
   * Removes every connection belonging to a draft. PostgreSQL cascades from
   * `studio_drafts`; SQLite has no foreign keys on the shared Studio file, so
   * deleting a website calls this explicitly and no orphan keeps a key alive.
   */
  removeForDraft(draftId: string): Promise<number>;
}

function rowToIntegration(row: IntegrationRow): StudioIntegration {
  return {
    id: row.id,
    draftId: row.draft_id,
    ownerId: row.owner_id,
    // "techchief" is the only provider this table holds today; rows are always
    // selected by provider, so the column is a future-proofing label.
    provider: "techchief",
    keyPrefix: row.key_prefix,
    webhookSecretSet: Boolean(row.webhook_secret_enc),
    status: isIntegrationStatus(row.status) ? row.status : "unverified",
    lastCheckedAt: row.last_checked_at ?? undefined,
    walletBalance:
      row.wallet_balance === null || row.wallet_balance === undefined
        ? null
        : Number(row.wallet_balance),
    lowBalance: Boolean(row.low_balance),
    accountStatus: row.account_status ?? undefined,
    lastError: row.last_error ?? undefined,
    bundles: parseCachedBundles(row.bundles_json),
    bundlesSyncedAt: row.bundles_synced_at ?? undefined,
    pollWindowStart: row.poll_window_start ?? undefined,
    pollCount: Number(row.poll_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates the integrations table on the shared SQLite connection if it is
 * missing. Idempotent, and safe to call on every store access like the orders
 * and deliveries schemas.
 */
export function ensureIntegrationsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_integrations (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'techchief',
      api_key_enc TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      webhook_secret_enc TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      last_checked_at TEXT,
      wallet_balance REAL,
      low_balance INTEGER NOT NULL DEFAULT 0,
      account_status TEXT,
      last_error TEXT,
      bundles_json TEXT,
      bundles_synced_at TEXT,
      poll_window_start TEXT,
      poll_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS studio_integrations_draft_provider ON studio_integrations(draft_id, provider);
    CREATE INDEX IF NOT EXISTS studio_integrations_owner ON studio_integrations(owner_id);
  `);
}

const SQLITE_COLUMNS = `id, draft_id, owner_id, provider, api_key_enc, key_prefix,
  webhook_secret_enc, status, last_checked_at, wallet_balance, low_balance,
  account_status, last_error, bundles_json, bundles_synced_at,
  poll_window_start, poll_count, created_at, updated_at`;

export class SqliteIntegrationsStore implements IntegrationsStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensureIntegrationsSchema(store.connection);
    return store.connection;
  }

  async getForDraft(
    draftId: string,
    provider: IntegrationProvider = "techchief",
  ): Promise<IntegrationRow | null> {
    const row = this.db
      .prepare(
        `SELECT ${SQLITE_COLUMNS} FROM studio_integrations WHERE draft_id = ? AND provider = ?`,
      )
      .get(draftId, provider) as unknown as IntegrationRow | undefined;
    return row ?? null;
  }

  async getById(id: string): Promise<IntegrationRow | null> {
    const row = this.db
      .prepare(`SELECT ${SQLITE_COLUMNS} FROM studio_integrations WHERE id = ?`)
      .get(id) as unknown as IntegrationRow | undefined;
    return row ?? null;
  }

  async insert(write: IntegrationWrite): Promise<IntegrationRow | null> {
    const now = new Date().toISOString();
    const id = write.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO studio_integrations(
           id, draft_id, owner_id, provider, api_key_enc, key_prefix,
           webhook_secret_enc, status, last_checked_at, wallet_balance,
           low_balance, account_status, last_error, bundles_json,
           bundles_synced_at, poll_window_start, poll_count, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(draft_id, provider) DO UPDATE SET
           api_key_enc = excluded.api_key_enc,
           key_prefix = excluded.key_prefix,
           webhook_secret_enc = excluded.webhook_secret_enc,
           status = excluded.status,
           last_checked_at = excluded.last_checked_at,
           wallet_balance = excluded.wallet_balance,
           low_balance = excluded.low_balance,
           account_status = excluded.account_status,
           last_error = excluded.last_error,
           bundles_json = excluded.bundles_json,
           bundles_synced_at = excluded.bundles_synced_at,
           poll_window_start = excluded.poll_window_start,
           poll_count = excluded.poll_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        write.draftId,
        write.ownerId,
        write.provider,
        write.apiKeyEnc,
        write.keyPrefix,
        write.webhookSecretEnc ?? null,
        write.status,
        write.lastCheckedAt ?? null,
        write.walletBalance ?? null,
        write.lowBalance ? 1 : 0,
        write.accountStatus ?? null,
        write.lastError ?? null,
        write.bundles ? JSON.stringify(write.bundles) : null,
        write.bundlesSyncedAt ?? null,
        write.pollWindowStart ?? null,
        write.pollCount ?? 0,
        now,
        now,
      );
    return this.getForDraft(write.draftId, write.provider);
  }

  async patch(
    id: string,
    patch: IntegrationPatch,
  ): Promise<IntegrationRow | null> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.apiKeyEnc !== undefined) add("api_key_enc", patch.apiKeyEnc);
    if (patch.keyPrefix !== undefined) add("key_prefix", patch.keyPrefix);
    if (patch.webhookSecretEnc !== undefined)
      add("webhook_secret_enc", patch.webhookSecretEnc);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.lastCheckedAt !== undefined)
      add("last_checked_at", patch.lastCheckedAt);
    if (patch.walletBalance !== undefined)
      add("wallet_balance", patch.walletBalance);
    if (patch.lowBalance !== undefined)
      add("low_balance", patch.lowBalance ? 1 : 0);
    if (patch.accountStatus !== undefined)
      add("account_status", patch.accountStatus);
    if (patch.lastError !== undefined) add("last_error", patch.lastError);
    if (patch.bundles !== undefined)
      add("bundles_json", patch.bundles ? JSON.stringify(patch.bundles) : null);
    if (patch.bundlesSyncedAt !== undefined)
      add("bundles_synced_at", patch.bundlesSyncedAt);
    if (patch.pollWindowStart !== undefined)
      add("poll_window_start", patch.pollWindowStart);
    if (patch.pollCount !== undefined) add("poll_count", patch.pollCount);

    if (sets.length > 0) {
      add("updated_at", new Date().toISOString());
      this.db
        .prepare(
          `UPDATE studio_integrations SET ${sets.join(", ")} WHERE id = ?`,
        )
        .run(...values, id);
    }
    return this.getById(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM studio_integrations WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  }

  async removeForDraft(draftId: string): Promise<number> {
    const result = this.db
      .prepare("DELETE FROM studio_integrations WHERE draft_id = ?")
      .run(draftId);
    return Number(result.changes);
  }
}

function pgRowToIntegrationRow(
  row: typeof studioIntegrations.$inferSelect,
): IntegrationRow {
  return {
    id: row.id,
    draft_id: row.draftId,
    owner_id: row.ownerId,
    provider: row.provider,
    api_key_enc: row.apiKeyEnc,
    key_prefix: row.keyPrefix,
    webhook_secret_enc: row.webhookSecretEnc,
    status: row.status,
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    wallet_balance:
      row.walletBalance === null ? null : Number(row.walletBalance),
    low_balance: row.lowBalance,
    account_status: row.accountStatus,
    last_error: row.lastError,
    bundles_json: (row.bundlesJson as TechChiefBundle[] | null) ?? null,
    bundles_synced_at: row.bundlesSyncedAt?.toISOString() ?? null,
    poll_window_start: row.pollWindowStart?.toISOString() ?? null,
    poll_count: row.pollCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export class PostgresIntegrationsStore implements IntegrationsStore {
  async getForDraft(
    draftId: string,
    provider: IntegrationProvider = "techchief",
  ): Promise<IntegrationRow | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioIntegrations)
      .where(
        and(
          eq(studioIntegrations.draftId, draftId),
          eq(studioIntegrations.provider, provider),
        ),
      )
      .limit(1);
    return row ? pgRowToIntegrationRow(row) : null;
  }

  async getById(id: string): Promise<IntegrationRow | null> {
    const [row] = await getDatabase()
      .select()
      .from(studioIntegrations)
      .where(eq(studioIntegrations.id, id))
      .limit(1);
    return row ? pgRowToIntegrationRow(row) : null;
  }

  async insert(write: IntegrationWrite): Promise<IntegrationRow | null> {
    const now = new Date();
    const id = write.id ?? randomUUID();
    await getDatabase()
      .insert(studioIntegrations)
      .values({
        id,
        draftId: write.draftId,
        ownerId: write.ownerId,
        provider: write.provider,
        apiKeyEnc: write.apiKeyEnc,
        keyPrefix: write.keyPrefix,
        webhookSecretEnc: write.webhookSecretEnc ?? null,
        status: write.status,
        lastCheckedAt: write.lastCheckedAt
          ? new Date(write.lastCheckedAt)
          : null,
        walletBalance:
          write.walletBalance === null || write.walletBalance === undefined
            ? null
            : String(write.walletBalance),
        lowBalance: Boolean(write.lowBalance),
        accountStatus: write.accountStatus ?? null,
        lastError: write.lastError ?? null,
        bundlesJson: (write.bundles ?? null) as TechChiefBundle[] | null,
        bundlesSyncedAt: write.bundlesSyncedAt
          ? new Date(write.bundlesSyncedAt)
          : null,
        pollWindowStart: write.pollWindowStart
          ? new Date(write.pollWindowStart)
          : null,
        pollCount: write.pollCount ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [studioIntegrations.draftId, studioIntegrations.provider],
        set: {
          apiKeyEnc: write.apiKeyEnc,
          keyPrefix: write.keyPrefix,
          webhookSecretEnc: write.webhookSecretEnc ?? null,
          status: write.status,
          lastCheckedAt: write.lastCheckedAt
            ? new Date(write.lastCheckedAt)
            : null,
          walletBalance:
            write.walletBalance === null || write.walletBalance === undefined
              ? null
              : String(write.walletBalance),
          lowBalance: Boolean(write.lowBalance),
          accountStatus: write.accountStatus ?? null,
          lastError: write.lastError ?? null,
          bundlesJson: (write.bundles ?? null) as TechChiefBundle[] | null,
          bundlesSyncedAt: write.bundlesSyncedAt
            ? new Date(write.bundlesSyncedAt)
            : null,
          pollWindowStart: write.pollWindowStart
            ? new Date(write.pollWindowStart)
            : null,
          pollCount: write.pollCount ?? 0,
          updatedAt: now,
        },
      });
    return this.getForDraft(write.draftId, write.provider);
  }

  async patch(
    id: string,
    patch: IntegrationPatch,
  ): Promise<IntegrationRow | null> {
    const set: Partial<typeof studioIntegrations.$inferInsert> = {};
    if (patch.apiKeyEnc !== undefined) set.apiKeyEnc = patch.apiKeyEnc;
    if (patch.keyPrefix !== undefined) set.keyPrefix = patch.keyPrefix;
    if (patch.webhookSecretEnc !== undefined)
      set.webhookSecretEnc = patch.webhookSecretEnc;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.lastCheckedAt !== undefined)
      set.lastCheckedAt = patch.lastCheckedAt
        ? new Date(patch.lastCheckedAt)
        : null;
    if (patch.walletBalance !== undefined)
      set.walletBalance =
        patch.walletBalance === null ? null : String(patch.walletBalance);
    if (patch.lowBalance !== undefined) set.lowBalance = patch.lowBalance;
    if (patch.accountStatus !== undefined)
      set.accountStatus = patch.accountStatus;
    if (patch.lastError !== undefined) set.lastError = patch.lastError;
    if (patch.bundles !== undefined)
      set.bundlesJson = (patch.bundles ?? null) as TechChiefBundle[] | null;
    if (patch.bundlesSyncedAt !== undefined)
      set.bundlesSyncedAt = patch.bundlesSyncedAt
        ? new Date(patch.bundlesSyncedAt)
        : null;
    if (patch.pollWindowStart !== undefined)
      set.pollWindowStart = patch.pollWindowStart
        ? new Date(patch.pollWindowStart)
        : null;
    if (patch.pollCount !== undefined) set.pollCount = patch.pollCount;

    if (Object.keys(set).length > 0) {
      set.updatedAt = new Date();
      await getDatabase()
        .update(studioIntegrations)
        .set(set)
        .where(eq(studioIntegrations.id, id));
    }
    return this.getById(id);
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await getDatabase()
      .delete(studioIntegrations)
      .where(eq(studioIntegrations.id, id))
      .returning({ id: studioIntegrations.id });
    return deleted.length > 0;
  }

  async removeForDraft(draftId: string): Promise<number> {
    const deleted = await getDatabase()
      .delete(studioIntegrations)
      .where(eq(studioIntegrations.draftId, draftId))
      .returning({ id: studioIntegrations.id });
    return deleted.length;
  }
}

export function getIntegrationsStore(): IntegrationsStore {
  if (process.env.DATABASE_URL) return new PostgresIntegrationsStore();
  return new SqliteIntegrationsStore();
}

// ---------------------------------------------------------------------------
// Encryption boundary
// ---------------------------------------------------------------------------

function encryptSecret(value: string): string {
  return encryptSessionValue(value);
}

/**
 * Decrypts a stored envelope. A value that cannot be decrypted — because
 * `SESSION_SECRET` changed after it was saved, for example — is treated as
 * missing rather than fatal: the connection then reads as unverified and the
 * owner is asked for the key again, instead of every checkout crashing on an
 * unreadable row.
 */
function decryptSecret(
  envelope: string | null | undefined,
): string | undefined {
  if (!envelope) return undefined;
  try {
    return decryptSessionValue(envelope);
  } catch {
    return undefined;
  }
}

/**
 * The connection plus its decrypted key. **Server-side only.** Callers must
 * never serialise this object into a response, a log line or a page prop; the
 * API layer returns {@link techChiefConnectionView} instead.
 */
export async function getTechChiefIntegrationWithKey(
  draftId: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<StudioIntegrationSecrets | null> {
  const row = await store.getForDraft(draftId, "techchief");
  if (!row) return null;
  const integration = rowToIntegration(row);
  const apiKey = decryptSecret(row.api_key_enc);
  // An undecryptable key is not a connection: report it as an error so the
  // owner is told to save a new one instead of silently falling back to the
  // simulator for live orders.
  if (!apiKey) {
    return {
      ...integration,
      status: integration.status === "verified" ? "error" : integration.status,
      apiKey: "",
      lastError:
        integration.lastError ??
        "The saved TechChief key could not be decrypted on this server. Save it again.",
    };
  }
  return {
    ...integration,
    apiKey,
    webhookSecret: decryptSecret(row.webhook_secret_enc),
  };
}

/** The connection without any secret, or null when the shop has none. */
export async function getTechChiefIntegration(
  draftId: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<StudioIntegration | null> {
  const row = await store.getForDraft(draftId, "techchief");
  return row ? rowToIntegration(row) : null;
}

/** Looks a connection up by id — the webhook's only handle on a shop. */
export async function getIntegrationById(
  id: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<StudioIntegrationSecrets | null> {
  const row = await store.getById(id);
  if (!row) return null;
  const integration = rowToIntegration(row);
  return {
    ...integration,
    apiKey: decryptSecret(row.api_key_enc) ?? "",
    webhookSecret: decryptSecret(row.webhook_secret_enc),
  };
}

// ---------------------------------------------------------------------------
// Connecting, testing, syncing
// ---------------------------------------------------------------------------

/** What {@link connectTechChief} reports back to the PUT route. */
export type TechChiefConnectResult =
  | {
      ok: true;
      integration: StudioIntegration;
      wallet: TechChiefWallet;
      /** Bundle sync outcome; a failed sync never blocks a verified key. */
      bundleCount: number;
      bundleSyncError?: string;
    }
  | {
      ok: false;
      /** "rejected" → 400, "unreachable" → 502, "inactive" → 400. */
      reason: "rejected" | "unreachable" | "inactive" | "invalid";
      message: string;
    };

export const TECHCHIEF_KEY_REJECTED_MESSAGE =
  "TechChief rejected this key. Check it in your TechChief developer dashboard and paste it again.";
export const TECHCHIEF_UNREACHABLE_MESSAGE =
  "Could not reach TechChief, try again.";
export const TECHCHIEF_NOT_ACTIVATED_MESSAGE =
  "This TechChief key is not activated yet. Activate the API in your TechChief developer dashboard, then save the key again.";
export const TECHCHIEF_ACCOUNT_NOT_ACTIVE_MESSAGE =
  "TechChief says this account is not active. Resolve it in your TechChief dashboard, then save the key again.";
export const TECHCHIEF_KEY_FORMAT_MESSAGE =
  "That does not look like a TechChief API key. It should start with TCHX-.";

function unreachable(kind: string): boolean {
  return kind === "network" || kind === "timeout" || kind === "server";
}

/**
 * Saves a key only after TechChief has confirmed it.
 *
 * The order matters: the probe runs first and, unless it answers `success`
 * with `api_activated` and `account_status === "active"`, **nothing is
 * stored**. A rejected key therefore leaves no row behind at all (the shop
 * stays "not connected" rather than "connected but broken"), and an
 * unreachable API is reported as a 502-shaped "try again" rather than being
 * guessed at. The bundle sync afterwards is best-effort: a verified key with
 * an empty price list is still a working connection, and the first order
 * retries the sync.
 */
export async function connectTechChief(input: {
  draftId: string;
  ownerId: string;
  apiKey: string;
  webhookSecret?: string | null;
  store?: IntegrationsStore;
  now?: () => Date;
}): Promise<TechChiefConnectResult> {
  const store = input.store ?? getIntegrationsStore();
  const apiKey = input.apiKey.trim();
  if (!isTechChiefKeyFormat(apiKey)) {
    return {
      ok: false,
      reason: "invalid",
      message: TECHCHIEF_KEY_FORMAT_MESSAGE,
    };
  }

  const probe = await getTechChiefWallet(apiKey);
  if (!probe.ok) {
    if (probe.kind === "auth") {
      return {
        ok: false,
        reason: "rejected",
        message: TECHCHIEF_KEY_REJECTED_MESSAGE,
      };
    }
    if (unreachable(probe.kind)) {
      return {
        ok: false,
        reason: "unreachable",
        message: TECHCHIEF_UNREACHABLE_MESSAGE,
      };
    }
    if (probe.kind === "rate_limited") {
      return {
        ok: false,
        reason: "unreachable",
        message: TECHCHIEF_BUDGET_EXHAUSTED_MESSAGE,
      };
    }
    return { ok: false, reason: "rejected", message: probe.message };
  }

  const wallet = probe.data;
  if (!wallet.apiActivated) {
    return {
      ok: false,
      reason: "inactive",
      message: TECHCHIEF_NOT_ACTIVATED_MESSAGE,
    };
  }
  if (wallet.accountStatus !== "active") {
    return {
      ok: false,
      reason: "inactive",
      message: TECHCHIEF_ACCOUNT_NOT_ACTIVE_MESSAGE,
    };
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const existing = await store.getForDraft(input.draftId, "techchief");
  const webhookSecretEnc =
    input.webhookSecret && input.webhookSecret.trim()
      ? encryptSecret(input.webhookSecret.trim())
      : // Keeping a previously saved secret is deliberate: the dashboard shows
        // no way to read it back, so re-saving a key must not silently drop
        // signature verification.
        (existing?.webhook_secret_enc ?? null);

  const saved = await store.insert({
    id: existing?.id,
    draftId: input.draftId,
    ownerId: input.ownerId,
    provider: "techchief",
    apiKeyEnc: encryptSecret(apiKey),
    keyPrefix: techChiefKeyPrefix(apiKey),
    webhookSecretEnc,
    status: "verified",
    lastCheckedAt: now,
    walletBalance: wallet.walletBalance,
    lowBalance: wallet.lowBalance,
    accountStatus: wallet.accountStatus,
    lastError: null,
    // A new key belongs to a different TechChief account, so the previous
    // account's price list must not survive the change.
    bundles: null,
    bundlesSyncedAt: null,
    pollWindowStart: existing?.poll_window_start ?? null,
    pollCount: Number(existing?.poll_count ?? 0),
  });
  if (!saved) {
    return {
      ok: false,
      reason: "unreachable",
      message: TECHCHIEF_UNREACHABLE_MESSAGE,
    };
  }

  const integration = rowToIntegration(saved);
  // Best-effort: a verified key with an empty price list is still a working
  // connection, and the first order retries the sync.
  const synced = await syncTechChiefBundles(integration.id, store);
  return {
    ok: true,
    integration: synced?.integration ?? integration,
    wallet,
    bundleCount: synced?.count ?? 0,
    ...(synced?.error ? { bundleSyncError: synced.error } : {}),
  };
}

/** What {@link testTechChiefConnection} reports back to the POST /test route. */
export type TechChiefTestResult =
  | { ok: true; integration: StudioIntegration; wallet: TechChiefWallet }
  | {
      ok: false;
      reason: "not_connected" | "rejected" | "unreachable" | "budget";
      message: string;
      integration?: StudioIntegration;
    };

/**
 * "Check balance": re-probes the wallet and refreshes the balance, the
 * low-balance flag and the account status. An auth failure flips the row to
 * `error` with an owner-readable reason — a key revoked at TechChief must stop
 * being treated as live immediately — while an unreachable API leaves the
 * verified status alone, because a network blip says nothing about the key.
 */
export async function testTechChiefConnection(
  draftId: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<TechChiefTestResult> {
  const integration = await getTechChiefIntegrationWithKey(draftId, store);
  if (!integration || !integration.apiKey) {
    return {
      ok: false,
      reason: "not_connected",
      message: "This website has no TechChief key saved yet.",
    };
  }

  const budget = await consumeTechChiefBudget(store, integration.id, "poll");
  if (!budget.allowed) {
    return {
      ok: false,
      reason: "budget",
      message: TECHCHIEF_BUDGET_EXHAUSTED_MESSAGE,
      integration,
    };
  }

  const probe = await getTechChiefWallet(integration.apiKey);
  const now = new Date().toISOString();
  if (!probe.ok) {
    if (probe.kind === "auth") {
      const patched = await store.patch(integration.id, {
        status: "error",
        lastCheckedAt: now,
        lastError: TECHCHIEF_KEY_REJECTED_MESSAGE,
      });
      return {
        ok: false,
        reason: "rejected",
        message: TECHCHIEF_KEY_REJECTED_MESSAGE,
        integration: patched ? rowToIntegration(patched) : integration,
      };
    }
    const message = unreachable(probe.kind)
      ? TECHCHIEF_UNREACHABLE_MESSAGE
      : probe.message;
    return {
      ok: false,
      reason: "unreachable",
      message,
      integration,
    };
  }

  const wallet = probe.data;
  const patched = await store.patch(integration.id, {
    // A key that stops being activated/active is no longer a live provider.
    status:
      wallet.apiActivated && wallet.accountStatus === "active"
        ? "verified"
        : "error",
    lastCheckedAt: now,
    walletBalance: wallet.walletBalance,
    lowBalance: wallet.lowBalance,
    accountStatus: wallet.accountStatus,
    lastError:
      wallet.apiActivated && wallet.accountStatus === "active"
        ? null
        : TECHCHIEF_ACCOUNT_NOT_ACTIVE_MESSAGE,
  });
  return {
    ok: true,
    integration: patched ? rowToIntegration(patched) : integration,
    wallet,
  };
}

/** What {@link syncTechChiefBundles} reports. */
export interface TechChiefSyncResult {
  integration: StudioIntegration;
  /** How many bundles are cached after the sync. */
  count: number;
  /** Set when the sync failed and the stale cache was kept. */
  error?: string;
  /** True when the cache was refreshed by this call. */
  synced: boolean;
}

/**
 * Downloads TechChief's wholesale price list and caches it on the row.
 *
 * Ordering is by TechChief's bundle **id**, never by size, so this list is the
 * join table between a shop's catalogue and what can actually be sent. One
 * call per network (their `network` parameter is a filter, not a grouping),
 * which costs 4 of the 60 hourly slots — MTN, AirtelTigo, Telecel and BigTime,
 * one request each — affordable once a day, and the
 * adapter falls back to the stale cache rather than blocking an order when a
 * refresh fails.
 */
export async function syncTechChiefBundles(
  integrationId: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<TechChiefSyncResult | null> {
  const row = await store.getById(integrationId);
  if (!row) return null;
  const integration = rowToIntegration(row);
  const apiKey = decryptSecret(row.api_key_enc);
  if (!apiKey) {
    return {
      integration,
      count: integration.bundles.length,
      synced: false,
      error: "The saved TechChief key could not be read on this server.",
    };
  }

  const collected: TechChiefBundle[] = [];
  let failure: string | null = null;
  for (const network of TECHCHIEF_NETWORKS) {
    const budget = await consumeTechChiefBudget(store, integrationId, "poll");
    if (!budget.allowed) {
      failure = TECHCHIEF_BUDGET_EXHAUSTED_MESSAGE;
      break;
    }
    const result = await listTechChiefBundles(apiKey, network);
    if (!result.ok) {
      failure =
        result.kind === "auth"
          ? TECHCHIEF_KEY_REJECTED_MESSAGE
          : unreachable(result.kind)
            ? TECHCHIEF_UNREACHABLE_MESSAGE
            : result.message;
      if (result.kind === "auth") break;
      continue;
    }
    collected.push(...result.data);
  }

  // Keep whatever we already had when the sync produced nothing: a stale price
  // list still delivers, an empty one does not.
  if (collected.length === 0) {
    return {
      integration,
      count: integration.bundles.length,
      synced: false,
      error: failure ?? TECHCHIEF_UNREACHABLE_MESSAGE,
    };
  }

  const patched = await store.patch(integrationId, {
    bundles: collected,
    bundlesSyncedAt: new Date().toISOString(),
    ...(failure ? { lastError: failure } : {}),
  });
  return {
    integration: patched ? rowToIntegration(patched) : integration,
    count: collected.length,
    synced: true,
    ...(failure ? { error: failure } : {}),
  };
}

/**
 * The price list the delivery adapter orders from.
 *
 * TechChief sells by bundle id, so an order cannot be placed without this
 * list. It is refreshed when the cache is empty or older than a day; when the
 * refresh fails the **stale cache is used rather than nothing**, because a
 * day-old price list still delivers the right bundle while an empty one fails
 * every paying customer's top-up. Each network costs one request out of the
 * hourly budget, and the sync gives up quietly once the budget is gone.
 */
export async function techChiefBundlesForDelivery(
  integrationId: string,
  store: IntegrationsStore = getIntegrationsStore(),
  now: number = Date.now(),
): Promise<{ bundles: TechChiefBundle[]; refreshed: boolean; error?: string }> {
  const row = await store.getById(integrationId);
  if (!row) return { bundles: [], refreshed: false };
  const cached = parseCachedBundles(row.bundles_json);
  const syncedAt = row.bundles_synced_at ?? undefined;
  if (
    !bundleCacheIsStale({ bundles: cached, bundlesSyncedAt: syncedAt }, now)
  ) {
    return { bundles: cached, refreshed: false };
  }

  const synced = await syncTechChiefBundles(integrationId, store);
  if (!synced) return { bundles: cached, refreshed: false };
  if (!synced.synced) {
    return {
      bundles:
        synced.integration.bundles.length > 0
          ? synced.integration.bundles
          : cached,
      refreshed: false,
      error: synced.error,
    };
  }
  return { bundles: synced.integration.bundles, refreshed: true };
}

/**
 * Records what TechChief told us about the wallet after an order, so the
 * balance the owner sees tracks reality instead of waiting for the next probe.
 * `lowBalance` is only ever set from their own flag or a 402, never inferred.
 */
export async function recordWalletFromOrder(
  integrationId: string,
  wallet: { balance: number | null; lowBalance?: boolean },
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<void> {
  const patch: IntegrationPatch = { lastCheckedAt: new Date().toISOString() };
  if (wallet.balance !== null && Number.isFinite(wallet.balance)) {
    patch.walletBalance = wallet.balance;
  }
  if (wallet.lowBalance !== undefined) patch.lowBalance = wallet.lowBalance;
  await store.patch(integrationId, patch);
}

/** Flips a connection to `error` with an owner-readable reason. */
export async function markIntegrationError(
  integrationId: string,
  message: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<void> {
  await store.patch(integrationId, {
    status: "error",
    lastError: message,
    lastCheckedAt: new Date().toISOString(),
  });
}

/** Removes a shop's connection (the owner's "Remove key"). */
export async function removeTechChiefIntegration(
  draftId: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<boolean> {
  const row = await store.getForDraft(draftId, "techchief");
  if (!row) return false;
  return store.remove(row.id);
}

/**
 * Deletes every connection for a draft. PostgreSQL cascades from
 * `studio_drafts`; the shared SQLite file has no foreign keys, so deleting a
 * website calls this and no orphan row keeps a decrypted-able key alive.
 */
export async function deleteIntegrationsForDraft(
  draftId: string,
  store: IntegrationsStore = getIntegrationsStore(),
): Promise<number> {
  return store.removeForDraft(draftId);
}

// ---------------------------------------------------------------------------
// The browser-safe view
// ---------------------------------------------------------------------------

/** What GET …/integrations/techchief returns. Contains no secret, ever. */
export interface TechChiefConnectionView {
  connected: boolean;
  status: IntegrationStatus | null;
  /** "TCHX-AB12" — the only part of the key anybody ever sees again. */
  keyPrefix: string | null;
  webhookSecretSet: boolean;
  walletBalance: number | null;
  lowBalance: boolean;
  accountStatus: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  bundlesSyncedAt: string | null;
  bundleCount: number;
  /** Priced catalogue items TechChief cannot deliver, with the reason. */
  unmatchedItems: UnmatchedBundleItem[];
  /** Where the owner pastes our webhook URL in their TechChief dashboard. */
  webhookUrl: string | null;
  /** False when APP_URL is not https, so callbacks cannot be delivered. */
  webhookUrlIsHttps: boolean;
  /** Requests already spent against TechChief in the current hour. */
  requestsThisHour: number;
  requestsPerHour: number;
}

/**
 * Builds the owner-facing view of a connection.
 *
 * The key itself is absent by construction — this function only ever reads
 * `key_prefix`, and `redactSecrets` masks a full `TCHX-…` string as a second
 * line of defence anywhere it might be logged.
 */
export function techChiefConnectionView(
  integration: StudioIntegration | null,
  brief?: Pick<SiteBriefV1, "items">,
): TechChiefConnectionView {
  const callback = integration ? techChiefCallback(integration.id) : null;
  return {
    connected: Boolean(integration),
    status: integration?.status ?? null,
    keyPrefix: integration?.keyPrefix ?? null,
    webhookSecretSet: integration?.webhookSecretSet ?? false,
    walletBalance: integration?.walletBalance ?? null,
    lowBalance: integration?.lowBalance ?? false,
    accountStatus: integration?.accountStatus ?? null,
    lastCheckedAt: integration?.lastCheckedAt ?? null,
    lastError: integration?.lastError ?? null,
    bundlesSyncedAt: integration?.bundlesSyncedAt ?? null,
    bundleCount: integration?.bundles.length ?? 0,
    unmatchedItems:
      integration && brief
        ? unmatchedBundleItems(brief, integration.bundles)
        : [],
    webhookUrl: callback?.url ?? null,
    webhookUrlIsHttps: callback?.https ?? false,
    requestsThisHour: integration?.pollCount ?? 0,
    requestsPerHour: TECHCHIEF_HOURLY_LIMIT,
  };
}
