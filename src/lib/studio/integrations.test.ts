/**
 * Stage 5 — the per-website TechChief connection: storage, encryption, the
 * hourly budget and the owner-facing view.
 *
 * The security assertions are the point of this file. A saved key must be
 * unreadable in the database and absent from everything the browser receives,
 * and it must only ever be saved after TechChief itself has confirmed it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { decryptSessionValue } from "@/lib/security";
import { starterBundleCatalogue } from "./bundles";
import { createDefaultBrief } from "./site-brief/defaults";
import {
  bundleCacheIsStale,
  connectTechChief,
  consumeTechChiefBudget,
  getTechChiefIntegration,
  getTechChiefIntegrationWithKey,
  markIntegrationError,
  parseCachedBundles,
  removeTechChiefIntegration,
  SqliteIntegrationsStore,
  syncTechChiefBundles,
  techChiefCallback,
  techChiefConnectionView,
  techChiefKeyPrefix,
  testTechChiefConnection,
  unmatchedBundleItems,
  TECHCHIEF_HOURLY_LIMIT,
  TECHCHIEF_HOURLY_POLL_BUDGET,
} from "./integrations";
import type { TechChiefBundle } from "./techchief";

const KEY = "TCHX-Ab12Cd34Ef56Gh78";
const PREFIX = "TCHX-Ab12";
const DRAFT_ID = "draft-1";
const OWNER_ID = "owner-1";

const dirs: string[] = [];
let store: SqliteIntegrationsStore;
const fetchMock = vi.fn();

const BUNDLES: Record<string, TechChiefBundle[]> = {
  MTN: [
    {
      id: 11,
      network: "MTN",
      sizeGb: 1,
      validityDays: 7,
      price: 8.5,
      currency: "GHS",
    },
    {
      id: 12,
      network: "MTN",
      sizeGb: 5,
      validityDays: 30,
      price: 38,
      currency: "GHS",
    },
  ],
  Telecel: [
    {
      id: 21,
      network: "Telecel",
      sizeGb: 1,
      validityDays: 7,
      price: 7,
      currency: "GHS",
    },
  ],
  AirtelTigo: [
    {
      id: 31,
      network: "AirtelTigo",
      sizeGb: 10,
      validityDays: 30,
      price: 66,
      currency: "GHS",
    },
  ],
  BigTime: [
    {
      id: 41,
      network: "BigTime",
      sizeGb: 50,
      validityDays: null,
      price: 300,
      currency: "GHS",
    },
  ],
};

function walletResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: true,
    wallet_balance: 42.5,
    currency: "GHS",
    low_balance: false,
    threshold: 20,
    account_status: "active",
    api_activated: true,
    key_name: "Adom Data",
    ...overrides,
  };
}

/**
 * A TechChief that behaves: wallet probes answer `wallet`, bundle lists answer
 * per network, and everything else is a 500. Each case overrides what it needs.
 */
function stubTechChief(
  options: {
    wallet?: Record<string, unknown> | null;
    walletStatus?: number;
    bundles?: boolean;
  } = {},
) {
  fetchMock.mockImplementation((url: string) => {
    const target = new URL(url);
    if (target.pathname.endsWith("dev_wallet.php")) {
      if (options.wallet === null) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(
        new Response(JSON.stringify(options.wallet ?? walletResponse()), {
          status: options.walletStatus ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (target.pathname.endsWith("dev_bundles.php")) {
      if (options.bundles === false) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, message: "nope" }), {
            status: 500,
          }),
        );
      }
      const network = target.searchParams.get("network") ?? "";
      const list = (BUNDLES[network] ?? []).map((bundle) => ({
        id: bundle.id,
        network: bundle.network,
        size_gb: bundle.sizeGb,
        validity_days: bundle.validityDays,
        price: bundle.price,
        currency: bundle.currency,
      }));
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, bundles: list }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 500 }));
  });
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-integrations-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  store = new SqliteIntegrationsStore();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  vi.stubEnv("APP_URL", "https://shop.example");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function connect(
  overrides: Partial<Parameters<typeof connectTechChief>[0]> = {},
) {
  return connectTechChief({
    draftId: DRAFT_ID,
    ownerId: OWNER_ID,
    apiKey: KEY,
    store,
    ...overrides,
  });
}

describe("connecting a TechChief key", () => {
  it("stores the key encrypted, verified, with the balance and the price list", async () => {
    stubTechChief();

    const result = await connect();

    expect(result.ok).toBe(true);
    const row = await store.getForDraft(DRAFT_ID);
    expect(row).not.toBeNull();
    // The plaintext key is nowhere in the row.
    expect(row!.api_key_enc).not.toContain(KEY);
    expect(row!.api_key_enc).not.toBe(KEY);
    expect(JSON.stringify(row)).not.toContain(KEY);
    // …and it decrypts back to exactly what the owner pasted.
    expect(decryptSessionValue(row!.api_key_enc)).toBe(KEY);
    expect(row!.key_prefix).toBe(PREFIX);
    expect(row!.status).toBe("verified");
    expect(row!.wallet_balance).toBe(42.5);
    expect(row!.low_balance).toBeFalsy();
    expect(row!.account_status).toBe("active");
    expect(row!.last_error).toBeNull();
    // All four networks were downloaded and cached.
    const cached = parseCachedBundles(row!.bundles_json);
    expect(cached).toHaveLength(5);
    expect(cached.map((bundle) => bundle.network).sort()).toEqual([
      "AirtelTigo",
      "BigTime",
      "MTN",
      "MTN",
      "Telecel",
    ]);
    expect(row!.bundles_synced_at).not.toBeNull();
  });

  it("encrypts the webhook secret too, and reports only that one is set", async () => {
    stubTechChief();

    await connect({ webhookSecret: "whsec-super-secret-value" });

    const row = await store.getForDraft(DRAFT_ID);
    expect(row!.webhook_secret_enc).not.toContain("whsec-super-secret-value");
    expect(decryptSessionValue(row!.webhook_secret_enc!)).toBe(
      "whsec-super-secret-value",
    );
    const integration = await getTechChiefIntegration(DRAFT_ID, store);
    expect(integration!.webhookSecretSet).toBe(true);
    expect(JSON.stringify(integration)).not.toContain("whsec-super-secret");
  });

  it("keeps a previously saved webhook secret when only the key changes", async () => {
    stubTechChief();
    await connect({ webhookSecret: "whsec-first" });

    await connect({ apiKey: "TCHX-Zz99Yy88Xx77Ww66", webhookSecret: null });

    const row = await store.getForDraft(DRAFT_ID);
    expect(decryptSessionValue(row!.webhook_secret_enc!)).toBe("whsec-first");
    expect(decryptSessionValue(row!.api_key_enc)).toBe("TCHX-Zz99Yy88Xx77Ww66");
    expect(row!.key_prefix).toBe("TCHX-Zz99");
  });

  it("stores nothing when TechChief rejects the key (401)", async () => {
    stubTechChief({
      wallet: { success: false, code: "INVALID_KEY", message: "Bad key" },
      walletStatus: 401,
    });

    const result = await connect();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rejected");
    expect(await store.getForDraft(DRAFT_ID)).toBeNull();
  });

  it("stores nothing when TechChief is unreachable, and says try again", async () => {
    stubTechChief({ wallet: null });

    const result = await connect();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreachable");
      expect(result.message).toContain("Could not reach TechChief");
    }
    expect(await store.getForDraft(DRAFT_ID)).toBeNull();
  });

  it("stores nothing when the key is not activated or the account is not active", async () => {
    stubTechChief({ wallet: walletResponse({ api_activated: false }) });
    const notActivated = await connect();
    expect(notActivated.ok).toBe(false);
    if (!notActivated.ok) expect(notActivated.reason).toBe("inactive");
    expect(await store.getForDraft(DRAFT_ID)).toBeNull();

    stubTechChief({ wallet: walletResponse({ account_status: "suspended" }) });
    const suspended = await connect();
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) {
      expect(suspended.message).toContain("not active");
    }
    expect(await store.getForDraft(DRAFT_ID)).toBeNull();
  });

  it("refuses a key that does not look like one, without calling TechChief", async () => {
    stubTechChief();

    const result = await connect({ apiKey: "sk-not-a-techchief-key" });

    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.getForDraft(DRAFT_ID)).toBeNull();
  });

  it("one connection per website: saving again replaces the row", async () => {
    stubTechChief();
    const first = await connect();
    expect(first.ok).toBe(true);

    stubTechChief({ wallet: walletResponse({ wallet_balance: 99 }) });
    const second = await connect({ apiKey: "TCHX-SecondKey123456789" });
    expect(second.ok).toBe(true);

    const rows = await store.getForDraft(DRAFT_ID);
    expect(rows).not.toBeNull();
    expect(rows!.key_prefix).toBe("TCHX-Seco");
    expect(Number(rows!.wallet_balance)).toBe(99);
    // The same row id: an upsert, not a second connection.
    if (first.ok && second.ok) {
      expect(first.integration.id).toBe(second.integration.id);
    }
  });

  it("a new key does not inherit the previous account's price list", async () => {
    stubTechChief();
    await connect();
    expect(
      (await getTechChiefIntegration(DRAFT_ID, store))!.bundles.length,
    ).toBe(5);

    // The new account sells nothing: the sync fails, so the cache is empty
    // rather than still holding the old account's bundles.
    stubTechChief({ bundles: false });
    const result = await connect({ apiKey: "TCHX-OtherAccount123456" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.integration.bundles).toEqual([]);
  });
});

describe("reading a connection", () => {
  it("hands the server the decrypted key and the browser only a prefix", async () => {
    stubTechChief();
    await connect();

    const secrets = await getTechChiefIntegrationWithKey(DRAFT_ID, store);
    expect(secrets!.apiKey).toBe(KEY);
    expect(secrets!.status).toBe("verified");

    const integration = await getTechChiefIntegration(DRAFT_ID, store);
    expect(integration).not.toBeNull();
    expect(JSON.stringify(integration)).not.toContain(KEY);
    expect(integration!.keyPrefix).toBe(PREFIX);
    expect("apiKey" in integration!).toBe(false);
  });

  it("the owner-facing view never contains the key", async () => {
    stubTechChief();
    await connect({ webhookSecret: "whsec-hidden" });
    const integration = await getTechChiefIntegration(DRAFT_ID, store);
    const brief = createDefaultBrief({
      businessName: "Adom Data",
      category: "data-bundles",
      items: starterBundleCatalogue(),
    });

    const view = techChiefConnectionView(integration, brief);
    const serialised = JSON.stringify(view);

    expect(serialised).not.toContain(KEY);
    // The only "TCHX-" in the payload is the 9-character prefix.
    expect(serialised.match(/TCHX-/g)).toHaveLength(1);
    expect(serialised).not.toContain("whsec-hidden");
    expect(view).toMatchObject({
      connected: true,
      status: "verified",
      keyPrefix: PREFIX,
      walletBalance: 42.5,
      lowBalance: false,
      accountStatus: "active",
      bundleCount: 5,
      webhookUrl: `https://shop.example/api/bundle-delivery/techchief/webhook?integration=${integration!.id}`,
      webhookUrlIsHttps: true,
      requestsPerHour: TECHCHIEF_HOURLY_LIMIT,
    });
    // The starter catalogue's 1GB/5GB MTN items match; the rest do not.
    expect(view.unmatchedItems.length).toBeGreaterThan(0);
    expect(view.unmatchedItems.every((item) => item.name && item.reason)).toBe(
      true,
    );
  });

  it("an undecryptable key reads as an error, not as a live connection", async () => {
    stubTechChief();
    await connect();
    const row = await store.getForDraft(DRAFT_ID);
    await store.patch(row!.id, { apiKeyEnc: "not-a-valid-envelope" });

    const secrets = await getTechChiefIntegrationWithKey(DRAFT_ID, store);

    expect(secrets!.apiKey).toBe("");
    expect(secrets!.status).toBe("error");
    expect(secrets!.lastError).toContain("could not be decrypted");
  });

  it("reports which items TechChief cannot deliver, and why", async () => {
    const bundles = BUNDLES.MTN.concat(BUNDLES.Telecel);
    const brief = createDefaultBrief({
      category: "data-bundles",
      items: [
        {
          id: "ok",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
        {
          id: "small",
          name: "MTN 500MB",
          price: 6,
          bundle: { network: "mtn", dataMb: 500, validity: "1 day" },
        },
        {
          id: "nonetwork",
          name: "Data bundle",
          price: 5,
        },
        {
          id: "free",
          name: "MTN 2GB (not priced)",
          bundle: { network: "mtn", dataMb: 2048, validity: "30 days" },
        },
      ],
    });

    const unmatched = unmatchedBundleItems(brief, bundles);

    expect(unmatched.map((item) => item.itemId)).toEqual([
      "small",
      "nonetwork",
    ]);
    expect(unmatched[0].reason).toContain("does not sell");
    expect(unmatched[1].reason).toContain("No network");
  });
});

describe("checking the balance", () => {
  it("refreshes the balance, the low-balance flag and the account status", async () => {
    stubTechChief();
    await connect();
    stubTechChief({
      wallet: walletResponse({ wallet_balance: 3, low_balance: true }),
    });

    const result = await testTechChiefConnection(DRAFT_ID, store);

    expect(result.ok).toBe(true);
    const integration = await getTechChiefIntegration(DRAFT_ID, store);
    expect(integration!.walletBalance).toBe(3);
    expect(integration!.lowBalance).toBe(true);
    expect(integration!.status).toBe("verified");
    expect(integration!.lastCheckedAt).toBeTruthy();
  });

  it("a rejected key flips the connection to error with a reason", async () => {
    stubTechChief();
    await connect();
    stubTechChief({
      wallet: { success: false, message: "Key disabled" },
      walletStatus: 403,
    });

    const result = await testTechChiefConnection(DRAFT_ID, store);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rejected");
    const integration = await getTechChiefIntegration(DRAFT_ID, store);
    expect(integration!.status).toBe("error");
    expect(integration!.lastError).toContain("TechChief rejected this key");
  });

  it("an unreachable API leaves a verified connection verified", async () => {
    stubTechChief();
    await connect();
    stubTechChief({ wallet: null });

    const result = await testTechChiefConnection(DRAFT_ID, store);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
    const integration = await getTechChiefIntegration(DRAFT_ID, store);
    expect(integration!.status).toBe("verified");
    expect(integration!.lastError).toBeFalsy();
  });

  it("says so when there is no connection to test", async () => {
    const result = await testTechChiefConnection(DRAFT_ID, store);
    expect(result).toMatchObject({ ok: false, reason: "not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("syncing the price list", () => {
  it("caches every network and keeps a stale list when the sync fails", async () => {
    stubTechChief();
    await connect();
    const integration = (await getTechChiefIntegration(DRAFT_ID, store))!;
    expect(integration.bundles).toHaveLength(5);

    stubTechChief({ bundles: false });
    const failed = await syncTechChiefBundles(integration.id, store);

    expect(failed!.synced).toBe(false);
    expect(failed!.count).toBe(5);
    expect(failed!.error).toBeTruthy();
    // The cache survived: a day-old price list still delivers, an empty one
    // fails every paying customer's top-up.
    expect(
      (await getTechChiefIntegration(DRAFT_ID, store))!.bundles,
    ).toHaveLength(5);
  });

  it("the cache is stale when empty or older than a day", () => {
    const now = Date.now();
    expect(
      bundleCacheIsStale({ bundles: [], bundlesSyncedAt: undefined }, now),
    ).toBe(true);
    expect(
      bundleCacheIsStale(
        {
          bundles: BUNDLES.MTN,
          bundlesSyncedAt: new Date(now - 60_000).toISOString(),
        },
        now,
      ),
    ).toBe(false);
    expect(
      bundleCacheIsStale(
        {
          bundles: BUNDLES.MTN,
          bundlesSyncedAt: new Date(now - 25 * 60 * 60_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
  });

  it("tolerates a cache written by an older shape", () => {
    expect(parseCachedBundles(null)).toEqual([]);
    expect(parseCachedBundles("not json")).toEqual([]);
    expect(parseCachedBundles([{ id: "x" }])).toEqual([]);
    expect(
      parseCachedBundles([
        { id: 11, network: "MTN", size_gb: 1, price: 8.5 },
        { id: 12, network: "Nope", size_gb: 1, price: 8.5 },
      ]),
    ).toEqual([
      {
        id: 11,
        network: "MTN",
        sizeGb: 1,
        validityDays: null,
        price: 8.5,
        currency: "GHS",
      },
    ]);
  });
});

describe("the hourly request budget", () => {
  async function connectedId(): Promise<string> {
    stubTechChief();
    const result = await connect();
    if (!result.ok) throw new Error("expected a verified connection");
    return result.integration.id;
  }

  it("spends polls up to 50 an hour and leaves the last ten for orders", async () => {
    const id = await connectedId();
    // Connecting already spent four polls (one bundle list per network).
    const spent = (await getTechChiefIntegration(DRAFT_ID, store))!.pollCount;
    expect(spent).toBe(4);

    let allowed = 0;
    for (let index = 0; index < TECHCHIEF_HOURLY_POLL_BUDGET; index += 1) {
      const decision = await consumeTechChiefBudget(store, id, "poll");
      if (decision.allowed) allowed += 1;
    }
    expect(allowed).toBe(TECHCHIEF_HOURLY_POLL_BUDGET - spent);

    // Polls are now refused…
    const poll = await consumeTechChiefBudget(store, id, "poll");
    expect(poll.allowed).toBe(false);
    // …but an order still goes, right up to TechChief's own ceiling.
    const order = await consumeTechChiefBudget(store, id, "order");
    expect(order.allowed).toBe(true);

    for (
      let index = TECHCHIEF_HOURLY_POLL_BUDGET + 1;
      index < TECHCHIEF_HOURLY_LIMIT;
      index += 1
    ) {
      expect((await consumeTechChiefBudget(store, id, "order")).allowed).toBe(
        true,
      );
    }
    expect((await consumeTechChiefBudget(store, id, "order")).allowed).toBe(
      false,
    );
  });

  it("the window rolls after an hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const id = await connectedId();

    for (let index = 0; index < TECHCHIEF_HOURLY_POLL_BUDGET; index += 1) {
      await consumeTechChiefBudget(store, id, "poll");
    }
    expect((await consumeTechChiefBudget(store, id, "poll")).allowed).toBe(
      false,
    );

    vi.setSystemTime(new Date("2026-09-03T11:00:01Z"));
    const decision = await consumeTechChiefBudget(store, id, "poll");
    expect(decision.allowed).toBe(true);
    expect(decision.spent).toBe(1);
  });

  it("refuses for a connection that does not exist", async () => {
    const decision = await consumeTechChiefBudget(store, "missing", "order");
    expect(decision.allowed).toBe(false);
  });
});

describe("removing a connection", () => {
  it("deletes the row so no key survives the shop", async () => {
    stubTechChief();
    await connect();
    expect(await getTechChiefIntegration(DRAFT_ID, store)).not.toBeNull();

    expect(await removeTechChiefIntegration(DRAFT_ID, store)).toBe(true);

    expect(await getTechChiefIntegration(DRAFT_ID, store)).toBeNull();
    expect(await removeTechChiefIntegration(DRAFT_ID, store)).toBe(false);
  });

  it("records an owner-readable error without touching the key", async () => {
    stubTechChief();
    await connect();
    const integration = (await getTechChiefIntegration(DRAFT_ID, store))!;

    await markIntegrationError(integration.id, "TechChief key rejected", store);

    const after = (await getTechChiefIntegration(DRAFT_ID, store))!;
    expect(after.status).toBe("error");
    expect(after.lastError).toBe("TechChief key rejected");
    // The key itself is untouched, so a network blip can be recovered by
    // re-testing rather than by asking the owner for the key again.
    expect(
      (await getTechChiefIntegrationWithKey(DRAFT_ID, store))!.apiKey,
    ).toBe(KEY);
  });
});

describe("the callback URL", () => {
  it("is built from an https APP_URL and carries the connection id", () => {
    expect(techChiefCallback("abc-123", "https://shop.example")).toEqual({
      url: "https://shop.example/api/bundle-delivery/techchief/webhook?integration=abc-123",
      https: true,
    });
  });

  it("is withheld unless APP_URL is https, because TechChief only calls https", () => {
    expect(techChiefCallback("abc-123", "http://shop.example")).toEqual({
      url: null,
      https: false,
    });
    expect(techChiefCallback("abc-123", "")).toEqual({
      url: null,
      https: false,
    });
    expect(techChiefCallback("abc-123", "not a url")).toEqual({
      url: null,
      https: false,
    });
    // With no usable APP_URL at all — the local-development case — the caller
    // gets nothing to paste and delivery falls back to polling.
    vi.stubEnv("APP_URL", "");
    expect(techChiefCallback("abc-123")).toEqual({ url: null, https: false });
  });
});

describe("the key prefix", () => {
  it("shows nine characters — enough to recognise, too short to use", () => {
    expect(techChiefKeyPrefix(KEY)).toBe(PREFIX);
    expect(techChiefKeyPrefix(KEY)).toHaveLength(9);
    expect(techChiefKeyPrefix("  TCHX-Short  ")).toBe("TCHX-Shor");
  });
});
