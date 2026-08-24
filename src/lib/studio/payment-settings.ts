import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { decryptSessionValue, encryptSessionValue } from "@/lib/security";

export type PaymentMode = "test" | "live";

interface StoredPaymentSettings {
  mode: PaymentMode;
  apiUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
}

export interface PaymentConfiguration {
  mode: PaymentMode;
  apiUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
  apiUrlSet: boolean;
  apiKeySet: boolean;
  webhookSecretSet: boolean;
  liveReady: boolean;
  liveActive: boolean;
}

const updateSchema = z.object({
  mode: z.enum(["test", "live"]),
  apiUrl: z.string().trim().max(2_000).optional(),
  apiKey: z.string().trim().max(10_000).optional(),
  webhookSecret: z.string().trim().max(10_000).optional(),
  clearApiUrl: z.boolean().optional(),
  clearApiKey: z.boolean().optional(),
  clearWebhookSecret: z.boolean().optional(),
});

function settingsPath(): string {
  return path.join(process.cwd(), ".data", "valmont-pay-settings.enc");
}

function readStored(): StoredPaymentSettings {
  try {
    const envelope = readFileSync(settingsPath(), "utf8");
    return JSON.parse(decryptSessionValue(envelope)) as StoredPaymentSettings;
  } catch {
    return { mode: "test" };
  }
}

/** Environment credentials take precedence, while the safety mode stays explicit. */
export function getPaymentConfiguration(): PaymentConfiguration {
  const stored = readStored();
  const apiUrl = process.env.VALMONT_PAY_API_URL?.trim() || stored.apiUrl;
  const apiKey = process.env.VALMONT_PAY_API_KEY?.trim() || stored.apiKey;
  const webhookSecret =
    process.env.VALMONT_PAY_WEBHOOK_SECRET?.trim() || stored.webhookSecret;
  const liveReady = Boolean(apiUrl && apiKey && webhookSecret);
  return {
    mode: stored.mode === "live" ? "live" : "test",
    apiUrl,
    apiKey,
    webhookSecret,
    apiUrlSet: Boolean(apiUrl),
    apiKeySet: Boolean(apiKey),
    webhookSecretSet: Boolean(webhookSecret),
    liveReady,
    liveActive: stored.mode === "live" && liveReady,
  };
}

export type PaymentSettingsUpdate = z.input<typeof updateSchema>;

/** Saves encrypted credentials without ever returning their values to a browser. */
export function updatePaymentSettings(
  input: PaymentSettingsUpdate,
): PaymentConfiguration {
  const value = updateSchema.parse(input);
  const current = readStored();
  const next: StoredPaymentSettings = { ...current, mode: value.mode };

  if (value.clearApiUrl) delete next.apiUrl;
  else if (value.apiUrl) {
    const url = new URL(value.apiUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("The Valmont Pay API address must start with https://");
    }
    next.apiUrl = url.toString().replace(/\/$/, "");
  }
  if (value.clearApiKey) delete next.apiKey;
  else if (value.apiKey) next.apiKey = value.apiKey;
  if (value.clearWebhookSecret) delete next.webhookSecret;
  else if (value.webhookSecret) next.webhookSecret = value.webhookSecret;

  const envUrl = Boolean(process.env.VALMONT_PAY_API_URL?.trim());
  const envKey = Boolean(process.env.VALMONT_PAY_API_KEY?.trim());
  const envSecret = Boolean(process.env.VALMONT_PAY_WEBHOOK_SECRET?.trim());
  const ready = Boolean(
    (envUrl || next.apiUrl) &&
    (envKey || next.apiKey) &&
    (envSecret || next.webhookSecret),
  );
  if (next.mode === "live" && !ready) {
    throw new Error(
      "Add all three Valmont Pay details before switching on Live mode.",
    );
  }

  mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const temporary = `${settingsPath()}.${process.pid}.tmp`;
  writeFileSync(temporary, encryptSessionValue(JSON.stringify(next)), {
    mode: 0o600,
  });
  renameSync(temporary, settingsPath());
  return getPaymentConfiguration();
}

export function publicPaymentSettings() {
  const config = getPaymentConfiguration();
  return {
    mode: config.mode,
    apiUrlSet: config.apiUrlSet,
    apiKeySet: config.apiKeySet,
    webhookSecretSet: config.webhookSecretSet,
    liveReady: config.liveReady,
    liveActive: config.liveActive,
  };
}
