import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";
import {
  canManagePayments,
  DEFAULT_PAYMENT_ADMIN_LOGINS,
  getPaymentSettingsStore,
  isSecurePaymentApiUrl,
  paymentAdminLogins,
  paymentSettingsStatus,
  readPaymentSettings,
  resolvePaymentConfig,
  SqlitePaymentSettingsStore,
  writePaymentSettings,
} from "./payment-settings";
import { verifyWebhookSignature } from "./valmont-pay";

const dirs: string[] = [];

const danny: SessionUser = {
  id: "1",
  login: "DanielOANSAH7868-dotcom",
  name: "Danny Pounds",
};
const stranger: SessionUser = { id: "2", login: "someone-else", name: "Eve" };

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-pay-settings-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  vi.stubEnv("VALMONT_PAY_API_URL", "");
  vi.stubEnv("VALMONT_PAY_API_KEY", "");
  vi.stubEnv("VALMONT_PAY_WEBHOOK_SECRET", "");
  vi.stubEnv("STUDIO_PAYMENT_ADMINS", "");
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("writePaymentSettings / readPaymentSettings", () => {
  it("round-trips values through the encrypted store", async () => {
    await writePaymentSettings({
      mode: "test",
      apiUrl: "https://pay.example.com",
      apiKey: "sk_live_12345",
      webhookSecret: "whsec_abc",
      updatedBy: "danieloansah7868-dotcom",
    });
    const stored = await readPaymentSettings();
    expect(stored?.mode).toBe("test");
    expect(stored?.apiUrl).toBe("https://pay.example.com");
    expect(stored?.apiKey).toBe("sk_live_12345");
    expect(stored?.webhookSecret).toBe("whsec_abc");
    expect(stored?.updatedBy).toBe("danieloansah7868-dotcom");
  });

  it("never stores the plaintext secrets in the database row", async () => {
    await writePaymentSettings({
      mode: "live",
      apiUrl: "https://pay.example.com",
      apiKey: "sk_live_PLAINTEXT",
      webhookSecret: "whsec_PLAINTEXT",
      updatedBy: "danieloansah7868-dotcom",
    });
    const row = await getPaymentSettingsStore().readRow();
    const raw = JSON.stringify(row);
    expect(raw).not.toContain("sk_live_PLAINTEXT");
    expect(raw).not.toContain("whsec_PLAINTEXT");
    expect(raw).not.toContain("https://pay.example.com");
  });

  it("null clears a saved value; undefined preserves it", async () => {
    await writePaymentSettings({
      mode: "test",
      apiUrl: "https://pay.example.com",
      apiKey: "first-key",
      updatedBy: "danieloansah7868-dotcom",
    });
    await writePaymentSettings({
      mode: "test",
      apiKey: null,
      updatedBy: "danieloansah7868-dotcom",
    });
    const stored = await readPaymentSettings();
    expect(stored?.apiUrl).toBe("https://pay.example.com");
    expect(stored?.apiKey).toBeUndefined();
  });
});

describe("resolvePaymentConfig", () => {
  it("defaults to test mode with nothing configured", async () => {
    const config = await resolvePaymentConfig();
    expect(config.mode).toBe("test");
    expect(config.liveActive).toBe(false);
    expect(config.keysPresent).toBe(false);
  });

  it("does not infer Live from environment keys without an explicit switch", async () => {
    vi.stubEnv("VALMONT_PAY_API_URL", "https://pay.example.com");
    vi.stubEnv("VALMONT_PAY_API_KEY", "env-key");
    const config = await resolvePaymentConfig();
    expect(config.mode).toBe("test");
    expect(config.keysPresent).toBe(true);
    expect(config.liveActive).toBe(false);
  });

  it("settings-page values win over environment values", async () => {
    vi.stubEnv("VALMONT_PAY_API_URL", "https://env.example.com");
    vi.stubEnv("VALMONT_PAY_API_KEY", "env-key");
    await writePaymentSettings({
      mode: "test",
      apiUrl: "https://saved.example.com",
      apiKey: "saved-key",
      updatedBy: "danieloansah7868-dotcom",
    });
    const config = await resolvePaymentConfig();
    expect(config.apiUrl).toBe("https://saved.example.com");
    expect(config.apiKey).toBe("saved-key");
  });

  it("test mode keeps the simulator even while real keys exist", async () => {
    await writePaymentSettings({
      mode: "test",
      apiUrl: "https://pay.example.com",
      apiKey: "saved-key",
      updatedBy: "danieloansah7868-dotcom",
    });
    const config = await resolvePaymentConfig();
    expect(config.mode).toBe("test");
    expect(config.keysPresent).toBe(true);
    expect(config.liveActive).toBe(false);
  });

  it("live mode without both keys cannot take real money", async () => {
    await writePaymentSettings({
      mode: "live",
      apiUrl: "https://pay.example.com",
      updatedBy: "danieloansah7868-dotcom",
    });
    const config = await resolvePaymentConfig();
    expect(config.mode).toBe("live");
    expect(config.keysPresent).toBe(false);
    expect(config.liveActive).toBe(false);
  });

  it("live mode with both keys takes real money", async () => {
    await writePaymentSettings({
      mode: "live",
      apiUrl: "https://pay.example.com",
      apiKey: "saved-key",
      updatedBy: "danieloansah7868-dotcom",
    });
    const config = await resolvePaymentConfig();
    expect(config.liveActive).toBe(true);
  });

  it("does not activate Live when the API URL is insecure", async () => {
    await writePaymentSettings({
      mode: "live",
      apiUrl: "http://pay.example.com",
      apiKey: "saved-key",
      updatedBy: "danieloansah7868-dotcom",
    });
    const config = await resolvePaymentConfig();
    expect(config.keysPresent).toBe(false);
    expect(config.liveActive).toBe(false);
  });
});

describe("isSecurePaymentApiUrl", () => {
  it("accepts HTTPS and rejects HTTP or malformed values", () => {
    expect(isSecurePaymentApiUrl("https://pay.example.com")).toBe(true);
    expect(isSecurePaymentApiUrl("http://pay.example.com")).toBe(false);
    expect(isSecurePaymentApiUrl("not a URL")).toBe(false);
  });
});

describe("payment managers", () => {
  it("makes the product owner's GitHub account the default payment manager", () => {
    expect(DEFAULT_PAYMENT_ADMIN_LOGINS).toContain("danieloansah7868-dotcom");
    expect(canManagePayments(danny)).toBe(true);
    expect(canManagePayments(stranger)).toBe(false);
  });

  it("matches logins case-insensitively", () => {
    expect(paymentAdminLogins().has("danieloansah7868-dotcom")).toBe(true);
  });

  it("STUDIO_PAYMENT_ADMINS overrides the default list", () => {
    vi.stubEnv("STUDIO_PAYMENT_ADMINS", "agency-one, agency-two");
    expect(canManagePayments({ ...danny, login: "agency-two" })).toBe(true);
    expect(canManagePayments(danny)).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ status: "success", reference: "order-1" });

  async function goLive(webhookSecret?: string) {
    await writePaymentSettings({
      mode: "live",
      apiUrl: "https://pay.example.com",
      apiKey: "saved-key",
      webhookSecret,
      updatedBy: "danieloansah7868-dotcom",
    });
  }

  it("accepts simulator webhooks in test mode with no signature", async () => {
    await expect(verifyWebhookSignature(body, {})).resolves.toBe(true);
  });

  it("accepts a Paystack-style HMAC-SHA512 hex signature in live mode", async () => {
    await goLive("whsec_abc");
    const signature = createHmac("sha512", "whsec_abc")
      .update(body, "utf8")
      .digest("hex");
    await expect(
      verifyWebhookSignature(body, { paystack: signature }),
    ).resolves.toBe(true);
  });

  it("accepts an HMAC-SHA256 signature (hex or base64) in live mode", async () => {
    await goLive("whsec_abc");
    const hex = createHmac("sha256", "whsec_abc")
      .update(body, "utf8")
      .digest("hex");
    const base64 = createHmac("sha256", "whsec_abc")
      .update(body, "utf8")
      .digest("base64");
    await expect(verifyWebhookSignature(body, { valmont: hex })).resolves.toBe(
      true,
    );
    await expect(
      verifyWebhookSignature(body, { valmont: base64 }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature(body, { valmont: `sha256=${hex}` }),
    ).resolves.toBe(true);
  });

  it("refuses a wrong signature in live mode", async () => {
    await goLive("whsec_abc");
    const forged = createHmac("sha512", "attacker-secret")
      .update(body, "utf8")
      .digest("hex");
    await expect(
      verifyWebhookSignature(body, { paystack: forged, valmont: forged }),
    ).resolves.toBe(false);
  });

  it("refuses unsigned live webhooks even when keys exist", async () => {
    await goLive("whsec_abc");
    await expect(verifyWebhookSignature(body, {})).resolves.toBe(false);
    await expect(
      verifyWebhookSignature(body, { valmont: null, paystack: null }),
    ).resolves.toBe(false);
  });

  it("refuses every live webhook until a signing secret is set", async () => {
    await goLive();
    const signature = createHmac("sha512", "anything")
      .update(body, "utf8")
      .digest("hex");
    await expect(
      verifyWebhookSignature(body, { paystack: signature }),
    ).resolves.toBe(false);
  });

  it("does not fall back to unsigned test behaviour when Live is incomplete", async () => {
    await writePaymentSettings({
      mode: "live",
      apiUrl: "https://pay.example.com",
      webhookSecret: "whsec_abc",
      updatedBy: "danieloansah7868-dotcom",
    });
    await expect(verifyWebhookSignature(body, {})).resolves.toBe(false);
  });
});

describe("paymentSettingsStatus", () => {
  it("reports SET / NOT SET and sources without exposing secrets", async () => {
    vi.stubEnv("VALMONT_PAY_WEBHOOK_SECRET", "env-secret");
    await writePaymentSettings({
      mode: "live",
      apiUrl: "https://pay.example.com",
      apiKey: "saved-key",
      updatedBy: "danieloansah7868-dotcom",
    });
    const status = await paymentSettingsStatus(danny);
    expect(status.mode).toBe("live");
    expect(status.liveActive).toBe(true);
    expect(status.apiUrlSet).toBe(true);
    expect(status.apiUrlSource).toBe("settings-page");
    expect(status.apiKeySet).toBe(true);
    expect(status.webhookSecretSet).toBe(true);
    expect(status.webhookSecretSource).toBe("environment");
    expect(status.canManage).toBe(true);
    expect(JSON.stringify(status)).not.toContain("saved-key");
    expect(JSON.stringify(status)).not.toContain("env-secret");
    expect(JSON.stringify(status)).not.toContain("https://pay.example.com");
  });

  it("flags live mode that cannot actually take payments", async () => {
    await writePaymentSettings({
      mode: "live",
      updatedBy: "danieloansah7868-dotcom",
    });
    const status = await paymentSettingsStatus(danny);
    expect(status.mode).toBe("live");
    expect(status.liveActive).toBe(false);
    expect(status.liveMisconfigured).toBe(true);
  });

  it("marks non-managers as view-only", async () => {
    const status = await paymentSettingsStatus(stranger);
    expect(status.canManage).toBe(false);
  });
});

describe("SqlitePaymentSettingsStore", () => {
  it("creates its table idempotently", async () => {
    const store = new SqlitePaymentSettingsStore();
    await expect(store.readRow()).resolves.toBeNull();
    await expect(store.readRow()).resolves.toBeNull();
  });
});
