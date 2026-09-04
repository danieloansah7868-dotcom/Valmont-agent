/**
 * Stage 5 — the real TechChief adapter inside the delivery engine.
 *
 * Two things are under test here and nowhere else:
 *
 *  1. **Provider selection.** Which provider an order gets is decided per
 *     order and per website, and the rule that must never bend is that a
 *     TEST-mode order never reaches TechChief even when a verified key is
 *     saved — a rehearsal must not buy a real bundle for a stranger's phone.
 *  2. **Money-safe failure handling.** An insufficient wallet alerts the
 *     merchant once an hour and never resends; a timeout records an unknown
 *     outcome and makes exactly one POST, because TechChief has no idempotency
 *     key and a blind retry could charge the owner twice; status polls are
 *     throttled per row and stop entirely when the hourly budget is gone.
 *
 * `fetch` is stubbed for every case: no test in this file makes real HTTP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import {
  bundleDeliveryAvailability,
  bundleDeliveryAvailabilityForDraft,
  dispatchBundleDeliveriesForOrder,
  NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
  recheckBundleDeliveriesForOrder,
  resolveProviderForOrder,
  retryBundleDeliveryFailures,
  SimulatedProvider,
  SqliteBundleDeliveriesStore,
  TECHCHIEF_RATE_LIMITED_MESSAGE,
  TECHCHIEF_UNKNOWN_OUTCOME_MESSAGE,
  TechChiefProvider,
  type BundleDeliveryDeps,
} from "./bundle-delivery";
import {
  connectTechChief,
  consumeTechChiefBudget,
  getTechChiefIntegration,
  getTechChiefIntegrationWithKey,
  SqliteIntegrationsStore,
  TECHCHIEF_HOURLY_LIMIT,
  TECHCHIEF_HOURLY_POLL_BUDGET,
} from "./integrations";
import { SqliteStudioDraftStore } from "./draft-store";
import { SqliteOrdersStore, type NewOrderInput } from "./orders";
import { createDefaultBrief } from "./site-brief/defaults";
import { starterBundleCatalogue } from "./bundles";

const KEY = "TCHX-Ab12Cd34Ef56Gh78";
const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const OWNER_ID = canonicalUserId(userA);

const dirs: string[] = [];
let orders: SqliteOrdersStore;
let deliveries: SqliteBundleDeliveriesStore;
let integrations: SqliteIntegrationsStore;
let drafts: SqliteStudioDraftStore;
let draftId = "";
let sequence = 0;

const fetchMock = vi.fn();
/** Every TechChief call made during a test, by endpoint. */
let calls: string[] = [];
/** What `dev_order.php` answers next. */
let orderResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    success: true,
    order_ref: "DEV-A1B2C3D4",
    status: "accepted",
    api_price: 8.5,
    wallet_balance: 34,
    message: "Order accepted",
  },
};
let statusResponse: { status: number; body: unknown } = {
  status: 200,
  body: { success: true, order_ref: "DEV-A1B2C3D4", status: "processing" },
};
/** Set to make the next order call time out instead of answering. */
let orderTimesOut = false;
/** Subjects of every merchant email the stubbed Resend endpoint received. */
let emails: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = new URL(url);
    if (target.hostname === "api.resend.com") {
      // Recorded by subject so the two alerts a failure can produce — the
      // Stage 4 "top-up failed" message and the Stage 5 "wallet too low"
      // message — can be told apart.
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        subject?: string;
      };
      emails.push(body.subject ?? "(no subject)");
      return Promise.resolve(json({ id: "email-1" }));
    }
    calls.push(target.pathname.split("/").pop() ?? target.pathname);
    if (target.pathname.endsWith("dev_wallet.php")) {
      return Promise.resolve(
        json({
          success: true,
          wallet_balance: 42.5,
          currency: "GHS",
          low_balance: false,
          threshold: 20,
          account_status: "active",
          api_activated: true,
          key_name: "Adom Data",
        }),
      );
    }
    if (target.pathname.endsWith("dev_bundles.php")) {
      const network = target.searchParams.get("network");
      const bundles =
        network === "MTN"
          ? [
              {
                id: 11,
                network: "MTN",
                size_gb: 1,
                validity_days: 7,
                price: 8.5,
                currency: "GHS",
              },
            ]
          : [];
      return Promise.resolve(json({ success: true, bundles }));
    }
    if (target.pathname.endsWith("dev_order.php")) {
      if (orderTimesOut) {
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }
      return Promise.resolve(json(orderResponse.body, orderResponse.status));
    }
    if (target.pathname.endsWith("dev_status.php")) {
      return Promise.resolve(json(statusResponse.body, statusResponse.status));
    }
    return Promise.resolve(json({}, 500));
  });
}

const BUNDLE_LINES = [
  {
    itemId: "bundle-00",
    name: "MTN 1GB",
    price: 10,
    quantity: 1,
    bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
  },
];

function bundleOrder(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  sequence += 1;
  return {
    ownerId: OWNER_ID,
    draftId,
    accessCode: `tch-code-${sequence}`,
    status: "paid",
    currency: "GHS",
    subtotal: 10,
    deliveryFee: 0,
    total: 10,
    lines: BUNDLE_LINES,
    customerName: "Ama",
    customerPhone: "0240000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    ...overrides,
  };
}

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-techchief-engine-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  vi.stubEnv("APP_URL", "https://shop.example");
  // A configured sender makes the low-balance alert observable through the
  // stubbed fetch, exactly as it travels in production.
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("NOTIFY_EMAIL_FROM", "Valmont <noreply@shop.example>");
  delete process.env.BUNDLE_DELIVERY_PROVIDER;

  orders = new SqliteOrdersStore();
  deliveries = new SqliteBundleDeliveriesStore();
  integrations = new SqliteIntegrationsStore();
  drafts = new SqliteStudioDraftStore();

  calls = [];
  emails = [];
  orderTimesOut = false;
  orderResponse = {
    status: 200,
    body: {
      success: true,
      order_ref: "DEV-A1B2C3D4",
      status: "accepted",
      api_price: 8.5,
      wallet_balance: 34,
    },
  };
  statusResponse = {
    status: 200,
    body: { success: true, order_ref: "DEV-A1B2C3D4", status: "processing" },
  };
  fetchMock.mockReset();
  stubFetch();
  vi.stubGlobal("fetch", fetchMock);
  resetRateLimitForTests();

  const draft = await drafts.create(
    userA,
    createDefaultBrief({
      businessName: "Adom Data Hub",
      category: "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
      items: starterBundleCatalogue(),
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        valmontPay: { provisioned: true },
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        notifications: { email: "owner@adom.example" },
        staged: { enabled: false, stages: [] },
      },
    }),
  );
  draftId = draft.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetRateLimitForTests();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Saves a verified connection the way the Studio card does. */
async function seedVerifiedConnection(): Promise<string> {
  const result = await connectTechChief({
    draftId,
    ownerId: OWNER_ID,
    apiKey: KEY,
    store: integrations,
  });
  if (!result.ok)
    throw new Error(`expected a verified connection: ${result.message}`);
  // Connecting spent four budget slots on the bundle sync; start clean so the
  // budget tests count only what they mean to.
  calls = [];
  emails = [];
  fetchMock.mockClear();
  return result.integration.id;
}

function deps(provider?: BundleDeliveryDeps["provider"]): BundleDeliveryDeps {
  return { orders, deliveries, integrations, provider };
}

function countCalls(endpoint: string): number {
  return calls.filter((call) => call === endpoint).length;
}

describe("Stage 5 provider selection", () => {
  it("a live order on a verified connection gets a live TechChief adapter", async () => {
    const integrationId = await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    const provider = await resolveProviderForOrder(order, { integrations });

    expect(provider).toBeInstanceOf(TechChiefProvider);
    expect(provider.id).toBe("techchief");
    expect(provider.live).toBe(true);
    expect(bundleDeliveryAvailability(provider)).toEqual({
      provider: "techchief",
      live: true,
    });
    expect(
      await bundleDeliveryAvailabilityForDraft(draftId, { integrations }),
    ).toEqual({ provider: "techchief", live: true });
    // The adapter carries the connection it came from, and never the key in
    // anything that could be serialised.
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(integrationId).toBeTruthy();
  });

  it("a live order with no verified connection stays on the simulator and is blocked", async () => {
    const order = await orders.create(bundleOrder());

    const provider = await resolveProviderForOrder(order, { integrations });
    expect(provider).toBeInstanceOf(SimulatedProvider);
    expect(provider.live).toBeFalsy();
    expect(
      await bundleDeliveryAvailabilityForDraft(draftId, { integrations }),
    ).toEqual({ provider: "simulator", live: false });

    // The engine's I1 backstop: nothing is sent, and the row says so.
    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toBe(NO_LIVE_DELIVERY_PROVIDER_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("a key that TechChief now rejects is not live, even though it is saved", async () => {
    await seedVerifiedConnection();
    const integration = await getTechChiefIntegration(draftId, integrations);
    await integrations.patch(integration!.id, { status: "error" });
    const order = await orders.create(bundleOrder());

    expect(
      await bundleDeliveryAvailabilityForDraft(draftId, { integrations }),
    ).toEqual({ provider: "simulator", live: false });
    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());
    expect(rows[0].lastError).toBe(NO_LIVE_DELIVERY_PROVIDER_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("a TEST-mode order never touches TechChief, even with a verified key", async () => {
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder({ paymentMode: "test" }));
    calls = [];

    const provider = await resolveProviderForOrder(order, { integrations });
    expect(provider).toBeInstanceOf(SimulatedProvider);

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("simulator");
    expect(rows[0].status).toBe("processing");
    expect(rows[0].providerRef).toMatch(/^sim-/);

    // Not one request left the process: no order, no status poll, no probe.
    expect(calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    // And a recheck of that test-mode row keeps using the simulator, so a
    // "techchief" row can never be polled on a test-mode order either.
    await recheckBundleDeliveriesForOrder(order.id, deps());
    expect(calls).toEqual([]);
  });

  it("a techchief row on a test-mode order is skipped rather than polled", async () => {
    const integrationId = await seedVerifiedConnection();
    const order = await orders.create(bundleOrder({ paymentMode: "test" }));
    // A row that claims TechChief sent it, on an order that is not live.
    await deliveries.createMany([
      {
        orderId: order.id,
        ownerId: OWNER_ID,
        lineIndex: 0,
        unitIndex: 0,
        itemId: "bundle-00",
        itemName: "MTN 1GB",
        network: "mtn",
        dataMb: 1024,
        recipientPhone: "0240000001",
        provider: "techchief",
      },
    ]);
    const [row] = await deliveries.listForOrder(order.id);
    await deliveries.claimForDispatch(row.id, { provider: "techchief" });
    await deliveries.setProviderRef(row.id, "DEV-LEGACY");
    calls = [];
    void integrationId;

    const rows = await recheckBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("processing");
    expect(calls).toEqual([]);
  });
});

describe("Stage 5 dispatch through TechChief", () => {
  it("orders by bundle id and records their reference and the new balance", async () => {
    const integrationId = await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "processing",
      provider: "techchief",
      providerRef: "DEV-A1B2C3D4",
      attempts: 1,
    });
    expect(countCalls("dev_order.php")).toBe(1);
    // The wallet the owner sees follows the order response.
    const after = await getTechChiefIntegration(draftId, integrations);
    expect(after!.walletBalance).toBe(34);
    expect(after!.status).toBe("verified");
    expect(after!.id).toBe(integrationId);
  });

  it("sends the https callback URL for this connection only", async () => {
    const integrationId = await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    await dispatchBundleDeliveriesForOrder(order.id, deps());

    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) =>
          String(url).endsWith("dev_order.php"),
        )?.[1]?.body,
      ),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      network: "MTN",
      bundle_id: 11,
      phone: "0240000001",
      callback_url: `https://shop.example/api/bundle-delivery/techchief/webhook?integration=${integrationId}`,
    });
  });

  it("omits the callback when APP_URL is not https", async () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    await dispatchBundleDeliveriesForOrder(order.id, deps());

    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) =>
          String(url).endsWith("dev_order.php"),
        )?.[1]?.body,
      ),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("callback_url");
  });

  it("an item TechChief does not sell fails with owner wording, and spends no order", async () => {
    await seedVerifiedConnection();
    const order = await orders.create(
      bundleOrder({
        lines: [
          {
            itemId: "bundle-small",
            name: "MTN 500MB",
            price: 6,
            quantity: 1,
            bundle: { network: "mtn", dataMb: 500, validity: "1 day" },
          },
        ],
      }),
    );

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toContain(
      "No TechChief bundle matches MTN 500MB",
    );
    expect(rows[0].lastError).toContain("Sync bundles or change this item");
    expect(countCalls("dev_order.php")).toBe(0);
  });

  it("402 fails the row, flags the wallet and alerts the merchant once an hour", async () => {
    const integrationId = await seedVerifiedConnection();
    orderResponse = {
      status: 402,
      body: {
        success: false,
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient wallet balance",
        wallet_balance: 2.5,
        required: 8.5,
      },
    };
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toBe(
      "TechChief wallet too low (GHS 2.50, this bundle needs GHS 8.50). Top up your TechChief wallet, then Retry.",
    );
    // The connection now shows the short wallet the owner has to fix.
    const after = await getTechChiefIntegration(draftId, integrations);
    expect(after!.lowBalance).toBe(true);
    expect(after!.walletBalance).toBe(2.5);
    expect(after!.status).toBe("verified");
    // The merchant is told, through the real notifier: the Stage 4 "top-up
    // failed" alert and the Stage 5 "wallet too low" alert, once each.
    expect(
      emails.filter((subject) => subject.includes("wallet too low")),
    ).toHaveLength(1);
    expect(
      emails.filter((subject) => subject.includes("delivery failed")),
    ).toHaveLength(1);
    expect(integrationId).toBeTruthy();

    // The owner's Retry inside the same hour: the row fails again, but the
    // merchant is not told twice.
    await retryBundleDeliveryFailures(OWNER_ID, order.id, deps());
    expect(
      emails.filter((subject) => subject.includes("wallet too low")),
    ).toHaveLength(1);
    const retried = await deliveries.listForOrder(order.id);
    expect(retried[0].status).toBe("failed");
    expect(retried[0].attempts).toBe(2);
  });

  it("401 marks the connection as an error and tells the owner to save a new key", async () => {
    await seedVerifiedConnection();
    orderResponse = {
      status: 401,
      body: { success: false, message: "Invalid API key" },
    };
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toContain("save a new key");
    const after = await getTechChiefIntegration(draftId, integrations);
    expect(after!.status).toBe("error");
    // An errored connection is no longer live, so the next live checkout is
    // refused rather than half-delivered.
    expect(
      await bundleDeliveryAvailabilityForDraft(draftId, { integrations }),
    ).toEqual({ provider: "simulator", live: false });
  });

  it("404, 422 and 429 each get their own owner wording", async () => {
    await seedVerifiedConnection();

    orderResponse = {
      status: 404,
      body: { success: false, message: "Bundle not found" },
    };
    const notFound = await orders.create(bundleOrder());
    expect(
      (await dispatchBundleDeliveriesForOrder(notFound.id, deps()))[0]
        .lastError,
    ).toContain("no longer offered by TechChief");

    orderResponse = {
      status: 422,
      body: { success: false, message: "Phone number is not valid" },
    };
    const invalid = await orders.create(bundleOrder());
    expect(
      (await dispatchBundleDeliveriesForOrder(invalid.id, deps()))[0].lastError,
    ).toBe("Phone number is not valid");

    orderResponse = {
      status: 429,
      body: { success: false, message: "Rate limit exceeded" },
    };
    const limited = await orders.create(bundleOrder());
    expect(
      (await dispatchBundleDeliveriesForOrder(limited.id, deps()))[0].lastError,
    ).toBe(TECHCHIEF_RATE_LIMITED_MESSAGE);
  });

  it("a timeout fails the row once and NEVER resends on its own", async () => {
    await seedVerifiedConnection();
    orderTimesOut = true;
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());
    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toBe(TECHCHIEF_UNKNOWN_OUTCOME_MESSAGE);
    expect(rows[0].attempts).toBe(1);
    expect(countCalls("dev_order.php")).toBe(1);

    // A recheck must not quietly try again: the wallet may already have been
    // charged, and only the owner may decide to retry.
    await recheckBundleDeliveriesForOrder(order.id, deps());
    await recheckBundleDeliveriesForOrder(order.id, deps());
    expect(countCalls("dev_order.php")).toBe(1);

    // The owner's explicit Retry does send again — that is the point of it.
    orderTimesOut = false;
    await retryBundleDeliveryFailures(OWNER_ID, order.id, deps());
    expect(countCalls("dev_order.php")).toBe(2);
    const after = await deliveries.listForOrder(order.id);
    expect(after[0].status).toBe("processing");
    expect(after[0].providerRef).toBe("DEV-A1B2C3D4");
  });

  it('a TechChief "failed" answer refunds and fails the row with their reason', async () => {
    await seedVerifiedConnection();
    orderResponse = {
      status: 200,
      body: {
        success: true,
        order_ref: "DEV-FAILED",
        status: "failed",
        message: "Recipient number is not on MTN",
        wallet_balance: 40,
      },
    };
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toContain("Recipient number is not on MTN");
    expect(rows[0].lastError).toContain("refunded");
    expect(rows[0].providerRef).toBeFalsy();
  });

  it("spends the order budget last: dispatch stops at TechChief's ceiling", async () => {
    const integrationId = await seedVerifiedConnection();
    for (let index = 0; index < TECHCHIEF_HOURLY_LIMIT; index += 1) {
      await consumeTechChiefBudget(integrations, integrationId, "order");
    }
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toBe(TECHCHIEF_RATE_LIMITED_MESSAGE);
    // Refused locally: no request was made, so no money could move.
    expect(countCalls("dev_order.php")).toBe(0);
  });
});

describe("Stage 5 status polling", () => {
  async function dispatchedOrder(): Promise<string> {
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());
    await dispatchBundleDeliveriesForOrder(order.id, deps());
    calls = [];
    return order.id;
  }

  it("polls at most once per row per ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const orderId = await dispatchedOrder();

    // Ten minutes after the order was accepted, one poll is allowed…
    vi.setSystemTime(new Date("2026-09-03T10:11:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(1);

    // …and rechecks inside the next ten minutes cost nothing, however many
    // page loads happen (the guest confirmation page is unauthenticated).
    vi.setSystemTime(new Date("2026-09-03T10:12:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    vi.setSystemTime(new Date("2026-09-03T10:19:59Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(1);

    vi.setSystemTime(new Date("2026-09-03T10:22:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(2);
  });

  it("a delivered answer ends the row, and later polls cannot change it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const orderId = await dispatchedOrder();
    statusResponse = {
      status: 200,
      body: { success: true, order_ref: "DEV-A1B2C3D4", status: "delivered" },
    };

    vi.setSystemTime(new Date("2026-09-03T10:11:00Z"));
    const rows = await recheckBundleDeliveriesForOrder(orderId, deps());

    expect(rows[0].status).toBe("delivered");
    expect(rows[0].deliveredAt).toBeTruthy();

    // I3: a delivered row is terminal, so nothing polls or changes it again.
    statusResponse = {
      status: 200,
      body: { success: true, order_ref: "DEV-A1B2C3D4", status: "failed" },
    };
    vi.setSystemTime(new Date("2026-09-03T11:30:00Z"));
    const after = await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(after[0].status).toBe("delivered");
    expect(countCalls("dev_status.php")).toBe(1);
  });

  it("a failed answer marks the row and alerts the merchant once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const orderId = await dispatchedOrder();
    statusResponse = {
      status: 200,
      body: {
        success: true,
        order_ref: "DEV-A1B2C3D4",
        status: "failed",
        message: "Network rejected the top-up",
      },
    };

    vi.setSystemTime(new Date("2026-09-03T10:11:00Z"));
    const rows = await recheckBundleDeliveriesForOrder(orderId, deps());

    expect(rows[0].status).toBe("failed");
    expect(rows[0].lastError).toBe("Network rejected the top-up");
    expect(
      emails.filter((subject) => subject.includes("delivery failed")),
    ).toHaveLength(1);

    // A second pass over an already-failed row alerts nobody again.
    vi.setSystemTime(new Date("2026-09-03T10:40:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(
      emails.filter((subject) => subject.includes("delivery failed")),
    ).toHaveLength(1);
  });

  it("stops polling entirely once the hourly budget is spent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const orderId = await dispatchedOrder();
    const integration = (await getTechChiefIntegrationWithKey(
      draftId,
      integrations,
    ))!;
    for (let index = 0; index < TECHCHIEF_HOURLY_POLL_BUDGET; index += 1) {
      await consumeTechChiefBudget(integrations, integration.id, "poll");
    }

    vi.setSystemTime(new Date("2026-09-03T10:30:00Z"));
    const rows = await recheckBundleDeliveriesForOrder(orderId, deps());

    expect(rows[0].status).toBe("processing");
    expect(calls).toEqual([]);
  });

  it("a stale row (over 24 h in flight) is polled at most every six hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    const orderId = await dispatchedOrder();

    // Two days later the row is stale: one poll per six hours, not per ten
    // minutes, so an abandoned top-up cannot eat a shop's allowance.
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(1);

    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(1);

    vi.setSystemTime(new Date("2026-09-03T16:30:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(2);
  });

  it("a transient TechChief outage leaves the row in flight for the next pass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const orderId = await dispatchedOrder();
    statusResponse = { status: 503, body: { success: false, message: "Down" } };

    vi.setSystemTime(new Date("2026-09-03T10:11:00Z"));
    const rows = await recheckBundleDeliveriesForOrder(orderId, deps());

    expect(rows[0].status).toBe("processing");
    expect(rows[0].lastError).toBeFalsy();
    // The attempt really happened, so the heartbeat keeps the next ten minutes
    // free even though nothing changed.
    vi.setSystemTime(new Date("2026-09-03T10:15:00Z"));
    await recheckBundleDeliveriesForOrder(orderId, deps());
    expect(countCalls("dev_status.php")).toBe(1);
  });

  it("a key revoked mid-flight is reported on the connection, not guessed at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const orderId = await dispatchedOrder();
    statusResponse = {
      status: 403,
      body: { success: false, message: "Key disabled" },
    };

    vi.setSystemTime(new Date("2026-09-03T10:11:00Z"));
    const rows = await recheckBundleDeliveriesForOrder(orderId, deps());

    expect(rows[0].status).toBe("processing");
    const integration = await getTechChiefIntegration(draftId, integrations);
    expect(integration!.status).toBe("error");
    expect(integration!.lastError).toContain("save a new key");
  });
});

describe("Stage 5 bundle cache", () => {
  it("syncs a missing price list before the first order", async () => {
    const integrationId = await seedVerifiedConnection();
    // Drop the cache: an order must refresh it rather than fail.
    await integrations.patch(integrationId, {
      bundles: null,
      bundlesSyncedAt: null,
    });
    calls = [];
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("processing");
    expect(countCalls("dev_bundles.php")).toBe(4);
    expect(countCalls("dev_order.php")).toBe(1);
    const after = await getTechChiefIntegration(draftId, integrations);
    expect(after!.bundles).toHaveLength(1);
  });

  it("a stale cache is used when the refresh fails, so delivery continues", async () => {
    const integrationId = await seedVerifiedConnection();
    await integrations.patch(integrationId, {
      bundlesSyncedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
    });
    // Every bundle list call now fails; the cached MTN 1GB must still deliver.
    fetchMock.mockImplementation((url: string) => {
      const target = new URL(url);
      calls.push(target.pathname.split("/").pop() ?? "");
      if (target.pathname.endsWith("dev_bundles.php")) {
        return Promise.resolve(json({ success: false, message: "down" }, 500));
      }
      if (target.pathname.endsWith("dev_order.php")) {
        return Promise.resolve(json(orderResponse.body, orderResponse.status));
      }
      return Promise.resolve(json({}, 500));
    });
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows[0].status).toBe("processing");
    expect(countCalls("dev_order.php")).toBe(1);
  });
});
