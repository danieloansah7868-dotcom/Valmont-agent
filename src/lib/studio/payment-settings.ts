import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioSettings } from "@/db/schema";
import { decryptSessionValue, encryptSessionValue } from "@/lib/security";
import { getSqliteChatStore } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";

/**
 * Studio payment settings — the Valmont Pay account details the merchant
 * pastes in on the Studio → Settings → Payments page.
 *
 * Design rules this module enforces:
 *
 *  1. Secrets are stored ENCRYPTED (AES-256-GCM envelope keyed by the app's
 *     SESSION_SECRET, the same primitive that protects OAuth sessions) and are
 *     NEVER sent to the browser. The API and settings page only ever expose
 *     SET / NOT SET.
 *  2. Test mode is the default. Live mode — real Mobile Money and card
 *     charges — requires an explicit mode switch AND both Valmont Pay keys.
 *  3. Environment variables (VALMONT_PAY_API_URL / VALMONT_PAY_API_KEY /
 *     VALMONT_PAY_WEBHOOK_SECRET) remain as a fallback for the values, so
 *     deployments made before this page existed can still use their keys. The
 *     explicit mode switch on this page is still required before any
 *     deployment can take real payments. A value saved on the settings page
 *     wins over the environment for that field.
 *  4. Only approved GitHub accounts ("payment managers") may change these
 *     settings. Everyone signed in can see the status.
 */

export const PAYMENT_MODES = ["test", "live"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** What GET /api/studio/settings/payments returns. Safe for the browser. */
export interface PaymentSettingsStatus {
  mode: PaymentMode;
  /** Effective state: live only when mode is "live" AND both keys exist. */
  liveActive: boolean;
  apiUrlSet: boolean;
  apiKeySet: boolean;
  webhookSecretSet: boolean;
  /** Where each value came from, so the UI can say "saved here" vs ".env". */
  apiUrlSource: SettingSource;
  apiKeySource: SettingSource;
  webhookSecretSource: SettingSource;
  /** True when live mode is selected but a required piece is missing. */
  liveMisconfigured: boolean;
  canManage: boolean;
}

export type SettingSource = "settings-page" | "environment" | "none";

/** Decrypted settings, server-side only. */
export interface StoredPaymentSettings {
  mode: PaymentMode;
  apiUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** Fully resolved configuration used by the payment flow. */
export interface ResolvedPaymentConfig {
  mode: PaymentMode;
  apiUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
  /** Both credentials exist and the API URL is safe for live requests. */
  keysPresent: boolean;
  liveActive: boolean;
}

// ---------------------------------------------------------------------------
// Payment managers — the GitHub accounts allowed to change payment settings
// ---------------------------------------------------------------------------

/**
 * The product owner's own GitHub account is the default payment manager, as
 * agreed for Phase 5: "your GitHub account the payment manager by default".
 * Override or extend with STUDIO_PAYMENT_ADMINS="login1,login2".
 */
export const DEFAULT_PAYMENT_ADMIN_LOGINS = ["danieloansah7868-dotcom"];

export function paymentAdminLogins(): ReadonlySet<string> {
  const raw = process.env.STUDIO_PAYMENT_ADMINS;
  if (!raw || !raw.trim()) {
    return new Set(DEFAULT_PAYMENT_ADMIN_LOGINS);
  }
  return new Set(
    raw
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when the signed-in GitHub user may change payment settings. */
export function canManagePayments(user: SessionUser): boolean {
  return paymentAdminLogins().has(user.login.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM envelope shared with OAuth sessions)
// ---------------------------------------------------------------------------

function encryptSecret(value: string): string {
  return encryptSessionValue(value);
}

/**
 * Decrypts a stored envelope. A value that cannot be decrypted (for example
 * because SESSION_SECRET changed after it was saved) is treated as unset:
 * the settings page then shows NOT SET and asks for it again, rather than
 * crashing every checkout with an unreadable row.
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

// ---------------------------------------------------------------------------
// Storage — SQLite (default, shared Studio database) and PostgreSQL
// ---------------------------------------------------------------------------

interface SettingsRow {
  mode: string;
  api_url_enc: string | null;
  api_key_enc: string | null;
  webhook_secret_enc: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface PaymentSettingsStore {
  readRow(): Promise<SettingsRow | null>;
  writeRow(row: SettingsRow): Promise<void>;
}

/**
 * Creates the settings table on the shared SQLite connection if it is
 * missing. Idempotent, matching the pattern used for studio_orders.
 */
export function ensurePaymentSettingsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL DEFAULT 'test',
      api_url_enc TEXT,
      api_key_enc TEXT,
      webhook_secret_enc TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);
}

export class SqlitePaymentSettingsStore implements PaymentSettingsStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensurePaymentSettingsSchema(store.connection);
    return store.connection;
  }

  async readRow(): Promise<SettingsRow | null> {
    const row = this.db
      .prepare(
        `SELECT mode, api_url_enc, api_key_enc, webhook_secret_enc, updated_at, updated_by
         FROM studio_settings WHERE id = 1`,
      )
      .get() as SettingsRow | undefined;
    return row ?? null;
  }

  async writeRow(row: SettingsRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO studio_settings(id, mode, api_url_enc, api_key_enc, webhook_secret_enc, updated_at, updated_by)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mode = excluded.mode,
           api_url_enc = excluded.api_url_enc,
           api_key_enc = excluded.api_key_enc,
           webhook_secret_enc = excluded.webhook_secret_enc,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        row.mode,
        row.api_url_enc,
        row.api_key_enc,
        row.webhook_secret_enc,
        row.updated_at,
        row.updated_by,
      );
  }
}

export class PostgresPaymentSettingsStore implements PaymentSettingsStore {
  async readRow(): Promise<SettingsRow | null> {
    const rows = await getDatabase()
      .select()
      .from(studioSettings)
      .where(eq(studioSettings.id, 1));
    const row = rows[0];
    if (!row) return null;
    return {
      mode: row.mode,
      api_url_enc: row.apiUrlEnc,
      api_key_enc: row.apiKeyEnc,
      webhook_secret_enc: row.webhookSecretEnc,
      updated_at: row.updatedAt.toISOString(),
      updated_by: row.updatedBy,
    };
  }

  async writeRow(row: SettingsRow): Promise<void> {
    await getDatabase()
      .insert(studioSettings)
      .values({
        id: 1,
        mode: row.mode,
        apiUrlEnc: row.api_url_enc,
        apiKeyEnc: row.api_key_enc,
        webhookSecretEnc: row.webhook_secret_enc,
        updatedAt: new Date(row.updated_at),
        updatedBy: row.updated_by,
      })
      .onConflictDoUpdate({
        target: studioSettings.id,
        set: {
          mode: row.mode,
          apiUrlEnc: row.api_url_enc,
          apiKeyEnc: row.api_key_enc,
          webhookSecretEnc: row.webhook_secret_enc,
          updatedAt: new Date(row.updated_at),
          updatedBy: row.updated_by,
        },
      });
  }
}

export function getPaymentSettingsStore(): PaymentSettingsStore {
  if (process.env.DATABASE_URL) return new PostgresPaymentSettingsStore();
  return new SqlitePaymentSettingsStore();
}

// ---------------------------------------------------------------------------
// Read / write with encryption applied at the boundary
// ---------------------------------------------------------------------------

/** Reads and decrypts the saved settings, or null when none exist. */
export async function readPaymentSettings(): Promise<StoredPaymentSettings | null> {
  let row: SettingsRow | null;
  try {
    row = await getPaymentSettingsStore().readRow();
  } catch {
    // A settings read failure must never take public checkout down — fall
    // back to environment-only configuration instead.
    return null;
  }
  if (!row) return null;
  return {
    mode: row.mode === "live" ? "live" : "test",
    apiUrl: decryptSecret(row.api_url_enc),
    apiKey: decryptSecret(row.api_key_enc),
    webhookSecret: decryptSecret(row.webhook_secret_enc),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? undefined,
  };
}

export interface PaymentSettingsUpdate {
  mode: PaymentMode;
  /** New value to save, null to clear, undefined to leave unchanged. */
  apiUrl?: string | null;
  apiKey?: string | null;
  webhookSecret?: string | null;
  updatedBy: string;
}

export async function writePaymentSettings(
  update: PaymentSettingsUpdate,
): Promise<void> {
  const store = getPaymentSettingsStore();
  const existing = await store.readRow();

  const nextEncrypted = (
    incoming: string | null | undefined,
    current: string | null,
  ): string | null => {
    if (incoming === undefined) return current;
    if (incoming === null || incoming.trim() === "") return null;
    return encryptSecret(incoming.trim());
  };

  await store.writeRow({
    mode: update.mode,
    api_url_enc: nextEncrypted(update.apiUrl, existing?.api_url_enc ?? null),
    api_key_enc: nextEncrypted(update.apiKey, existing?.api_key_enc ?? null),
    webhook_secret_enc: nextEncrypted(
      update.webhookSecret,
      existing?.webhook_secret_enc ?? null,
    ),
    updated_at: new Date().toISOString(),
    updated_by: update.updatedBy,
  });
}

// ---------------------------------------------------------------------------
// Resolution — the single decision point for "are we taking real money?"
// ---------------------------------------------------------------------------

interface ResolvedField {
  value?: string;
  source: SettingSource;
}

/** Live payment credentials must never be sent to an HTTP endpoint. */
export function isSecurePaymentApiUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function resolveField(
  fromSettings: string | undefined,
  envValue: string | undefined,
): ResolvedField {
  if (fromSettings && fromSettings.trim()) {
    return { value: fromSettings.trim(), source: "settings-page" };
  }
  if (envValue && envValue.trim()) {
    return { value: envValue.trim(), source: "environment" };
  }
  return { source: "none" };
}

/**
 * Resolves the effective payment configuration.
 *
 * - With a saved settings row, the mode toggle is authoritative: Test mode
 *   keeps the local simulator even while real keys exist, exactly as Danny's
 *   handover requires.
 * - Without a settings row, Test mode is the safe default. Environment keys
 *   provide the values, but their presence can never silently opt a deployment
 *   into real charges; Live must be selected and saved explicitly.
 */
export async function resolvePaymentConfig(): Promise<ResolvedPaymentConfig> {
  const stored = await readPaymentSettings();

  const apiUrl = resolveField(stored?.apiUrl, process.env.VALMONT_PAY_API_URL);
  const apiKey = resolveField(stored?.apiKey, process.env.VALMONT_PAY_API_KEY);
  const webhookSecret = resolveField(
    stored?.webhookSecret,
    process.env.VALMONT_PAY_WEBHOOK_SECRET,
  );

  const keysPresent = Boolean(
    apiUrl.value && apiKey.value && isSecurePaymentApiUrl(apiUrl.value),
  );
  // Never infer Live from credentials alone. A deployment may have inherited
  // VALMONT_PAY_* values from before the settings page existed; the merchant
  // must still explicitly select and save Live before real charges are allowed.
  const mode: PaymentMode = stored?.mode ?? "test";

  return {
    mode,
    apiUrl: apiUrl.value,
    apiKey: apiKey.value,
    webhookSecret: webhookSecret.value,
    keysPresent,
    liveActive: mode === "live" && keysPresent,
  };
}

/** The browser-safe status view for the settings page and its API. */
export async function paymentSettingsStatus(
  user: SessionUser,
): Promise<PaymentSettingsStatus> {
  const stored = await readPaymentSettings();
  const config = await resolvePaymentConfig();

  const sourceOf = (
    fromSettings: string | undefined,
    envValue: string | undefined,
  ): { set: boolean; source: SettingSource } => {
    const field = resolveField(fromSettings, envValue);
    return { set: Boolean(field.value), source: field.source };
  };

  const apiUrl = sourceOf(stored?.apiUrl, process.env.VALMONT_PAY_API_URL);
  const apiKey = sourceOf(stored?.apiKey, process.env.VALMONT_PAY_API_KEY);
  const webhookSecret = sourceOf(
    stored?.webhookSecret,
    process.env.VALMONT_PAY_WEBHOOK_SECRET,
  );

  return {
    mode: config.mode,
    liveActive: config.liveActive,
    apiUrlSet: apiUrl.set,
    apiKeySet: apiKey.set,
    webhookSecretSet: webhookSecret.set,
    apiUrlSource: apiUrl.source,
    apiKeySource: apiKey.source,
    webhookSecretSource: webhookSecret.source,
    liveMisconfigured: config.mode === "live" && !config.liveActive,
    canManage: canManagePayments(user),
  };
}
