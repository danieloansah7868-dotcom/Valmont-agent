/**
 * Stage 5 — the API key is a secret, and these tests are the proof.
 *
 * The rule is not "be careful with the key"; it is that the decrypted key has
 * exactly one legitimate destination (the `X-API-Key` header on a request to
 * TechChief) and no others. So every surface that could plausibly carry it out
 * of the server is checked here: logs, the connection view the browser
 * receives, the backup file an owner downloads, free text pasted into the
 * Brief, and the column in the database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import {
  containsLikelySecret,
  decryptSessionValue,
  encryptSessionValue,
} from "@/lib/security";
import { redactSecrets } from "@/lib/redact";
import { buildBackup } from "./backup";
import { SqliteStudioDraftStore } from "./draft-store";
import {
  SqliteIntegrationsStore,
  getTechChiefIntegration,
  techChiefConnectionView,
  techChiefKeyPrefix,
  TECHCHIEF_KEY_PREFIX_LENGTH,
} from "./integrations";
import { createDefaultBrief } from "./site-brief/defaults";
import { siteBriefSchemaV1 } from "./site-brief/schema";

const apiKey = "TCHX-9F8E7D6C5B4A3210FEDCBA9876543210";
const owner: SessionUser = { id: "9001", login: "ama", name: "Ama" };

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;
let integrations: SqliteIntegrationsStore;

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-secrets-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  integrations = new SqliteIntegrationsStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Saves a data-bundles draft plus a verified TechChief connection for it. */
async function seedConnectedDraft() {
  const draft = await drafts.create(owner, {
    ...createDefaultBrief(),
    category: "data-bundles",
    businessName: "Data GH",
  });
  await integrations.insert({
    draftId: draft.id,
    ownerId: canonicalUserId(owner),
    provider: "techchief",
    apiKeyEnc: encryptSessionValue(apiKey),
    keyPrefix: techChiefKeyPrefix(apiKey),
    webhookSecretEnc: encryptSessionValue("whsec_super_secret_value"),
    status: "verified",
    walletBalance: 120,
    lowBalance: false,
    accountStatus: "active",
    bundles: [
      {
        id: 101,
        network: "MTN",
        sizeGb: 1,
        validityDays: 30,
        price: 6.2,
        currency: "GHS",
      },
    ],
    pollWindowStart: new Date().toISOString(),
    pollCount: 2,
  });
  return draft;
}

describe("the key in text that might be logged", () => {
  it("is masked by the shared redactor wherever it appears", () => {
    const line = `Connecting with ${apiKey} for draft 123`;
    const redacted = redactSecrets(line);
    expect(redacted).not.toContain(apiKey);
    expect(redacted).toContain("[REDACTED_TECHCHIEF_KEY]");
    expect(redacted).toContain("draft 123");
  });

  it("leaves the nine-character prefix the owner is meant to see", () => {
    // The prefix is deliberately shorter than the redactor's threshold, so the
    // UI can show "TCHX-9F8E" without tripping the mask.
    const prefix = techChiefKeyPrefix(apiKey);
    expect(prefix).toHaveLength(TECHCHIEF_KEY_PREFIX_LENGTH);
    expect(redactSecrets(`Saved key ${prefix}`)).toContain(prefix);
  });

  it("is recognised as a secret, so it cannot be pasted into chat unnoticed", () => {
    expect(containsLikelySecret(apiKey)).toBe(true);
    expect(containsLikelySecret("TCHX-9F8E")).toBe(false);
  });
});

describe("the key pasted into the Brief by mistake", () => {
  it("is redacted when the Brief is parsed, before it is ever stored", () => {
    const brief = createDefaultBrief();
    const parsed = siteBriefSchemaV1.parse({
      ...brief,
      category: "data-bundles",
      // The checkout note is free text an owner types, so it is the likeliest
      // place for a key to be pasted by accident.
      payments: {
        ...brief.payments,
        checkoutNote: `Top up instantly. Key: ${apiKey}`,
      },
    });

    expect(parsed.payments.checkoutNote).not.toContain(apiKey);
    expect(parsed.payments.checkoutNote).toContain("[REDACTED_TECHCHIEF_KEY]");
  });

  it("is redacted in the website's own description too", () => {
    const parsed = siteBriefSchemaV1.parse({
      ...createDefaultBrief(),
      description: `Fast data bundles — ${apiKey}`,
    });

    expect(parsed.description).not.toContain(apiKey);
  });
});

describe("the key at rest", () => {
  it("is stored as an envelope that does not contain the key", () => {
    const envelope = encryptSessionValue(apiKey);
    expect(envelope).not.toContain(apiKey);
    expect(decryptSessionValue(envelope)).toBe(apiKey);
  });

  it("produces different ciphertext each time, so identical keys cannot be matched up", () => {
    expect(encryptSessionValue(apiKey)).not.toBe(encryptSessionValue(apiKey));
  });

  it("cannot be read back with the wrong secret", () => {
    const envelope = encryptSessionValue(apiKey);
    expect(() =>
      decryptSessionValue(envelope, "a-completely-different-secret"),
    ).toThrow();
  });

  it("keeps only the ciphertext and the prefix in the database row", async () => {
    const draft = await seedConnectedDraft();
    const row = chatStore.connection
      .prepare("SELECT * FROM studio_integrations WHERE draft_id = ?")
      .get(draft.id) as Record<string, unknown>;

    expect(String(row.api_key_enc)).not.toContain(apiKey);
    expect(row.key_prefix).toBe("TCHX-9F8E");
    expect(JSON.stringify(row)).not.toContain(apiKey);
  });
});

describe("the key on its way to the browser", () => {
  it("is absent from the connection view the Studio card renders", async () => {
    const draft = await seedConnectedDraft();
    const integration = await getTechChiefIntegration(draft.id);
    expect(integration).not.toBeNull();

    const view = techChiefConnectionView(integration, draft.brief);
    const serialised = JSON.stringify(view);

    expect(serialised).not.toContain(apiKey);
    expect(serialised).not.toContain("whsec_super_secret_value");
    expect(serialised).not.toContain("AES256");
    expect(view.keyPrefix).toBe("TCHX-9F8E");
    expect(view.connected).toBe(true);
    // The view is what the client component receives: no field of it is a key.
    expect(Object.keys(view).some((key) => /key$/i.test(key))).toBe(false);
  });

  it("is absent from the record the store hands to server code", async () => {
    const draft = await seedConnectedDraft();
    const integration = await getTechChiefIntegration(draft.id);
    expect(JSON.stringify(integration)).not.toContain(apiKey);
  });
});

describe("the key in a backup", () => {
  it("is not exported, while the website it belongs to still is", async () => {
    const draft = await seedConnectedDraft();

    const backup = await buildBackup(owner);
    const serialised = JSON.stringify(backup);

    // The draft is really in the file — so the absence below is exclusion, not
    // an empty export.
    expect(serialised).toContain("Data GH");
    expect(backup.studio.drafts.some((entry) => entry.id === draft.id)).toBe(
      true,
    );

    expect(serialised).not.toContain(apiKey);
    expect(serialised).not.toContain("whsec_super_secret_value");
    expect(serialised).not.toContain("api_key_enc");
    expect(serialised).not.toContain("apiKeyEnc");
    expect(serialised).not.toContain("studio_integrations");
    // Not even the ciphertext travels: a backup is a file people keep.
    expect(serialised).not.toContain("AES256");
  });
});
