/**
 * Stage 6a — manual delivery for a Starter Shop, inside the real engine.
 *
 * A website sold as Starter Shop has no supplier API, so the engine's job
 * changes shape but not discipline: rows are still created one per purchased
 * unit exactly as today, but they are born `provider = "manual"` and wait at
 * "pending" until a human marks them (Stage 6c). Everything under test here
 * is what makes that safe:
 *
 *  - the plan check comes FIRST in provider resolution — before the payment
 *    mode and before any TechChief key, so even a verified connection never
 *    makes a Starter shop send automatically;
 *  - guard (a): a dispatch pass never CLAIMS a manual row, so nothing can
 *    drag it to "processing" and fail it through a provider;
 *  - guard (b): the live-money block exempts manual providers, so a live
 *    Starter order produces PENDING rows, not failed ones;
 *  - rechecks skip manual rows entirely — no provider call, no TechChief
 *    budget;
 *  - a stray Retry can never fabricate a send.
 *
 * `fetch` is stubbed for every case and every call is recorded: no test in
 * this file makes real HTTP, and "zero provider calls" is asserted by count.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { canonicalUserId } from "@/lib/user-identity";
import {
  bundleDeliveryAvailabilityForDraft,
  dispatchBundleDeliveriesForOrder,
  guestBundleDeliverySummary,
  MANUAL_DELIVERY_PENDING_LABEL,
  MANUAL_DELIVERY_SEND_MESSAGE,
  ManualProvider,
  MANUAL_PROVIDER_ID,
  NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
  recheckBundleDeliveriesForOrder,
  resolveProviderForOrder,
  retryBundleDeliveryFailures,
  SqliteBundleDeliveriesStore,
  deliveryStatusLabel,
  type BundleDeliveryDeps,
} from "./bundle-delivery";
import { connectTechChief, SqliteIntegrationsStore } from "./integrations";
import { SqliteStudioDraftStore, getStudioSqliteDb } from "./draft-store";
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
/** Every outbound HTTP call made during a test, by URL. */
let calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    const target = new URL(url);
    calls.push(url);
    // Only what `connectTechChief` needs to reach "verified": the wallet
    // probe and the bundle sync. The engine itself must NEVER get this far —
    // every "zero calls" assertion proves it stopped before any endpoint.
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
      const bundles = [
        {
          id: 11,
          network: "MTN",
          size_gb: 1,
          validity_days: 7,
          price: 8.5,
          currency: "GHS",
        },
      ];
      return Promise.resolve(json({ success: true, bundles }));
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
    accessCode: `manual-code-${sequence}`,
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

function deps(): BundleDeliveryDeps {
  // Deliberately NO provider: the engine must resolve it from the website's
  // own brief (the plan) exactly as production does.
  return { orders, deliveries, integrations };
}

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-manual-delivery-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  vi.stubEnv("APP_URL", "https://shop.example");
  delete process.env.BUNDLE_DELIVERY_PROVIDER;

  orders = new SqliteOrdersStore();
  deliveries = new SqliteBundleDeliveriesStore();
  integrations = new SqliteIntegrationsStore();
  drafts = new SqliteStudioDraftStore();

  calls = [];
  fetchMock.mockReset();
  stubFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Creates a bundle website sold under the given package. */
async function seedDraft(
  plan?: "starter" | "auto_dispatch" | "command_center",
) {
  const draft = await drafts.create(
    userA,
    createDefaultBrief({
      businessName: "Adom Data Hub",
      category: "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
      items: starterBundleCatalogue(),
      ...(plan ? { plan } : {}),
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
  return draft;
}

/** Saves a verified TechChief connection the way the Studio card does. */
async function seedVerifiedConnection(): Promise<void> {
  const result = await connectTechChief({
    draftId,
    ownerId: OWNER_ID,
    apiKey: KEY,
    store: integrations,
  });
  if (!result.ok)
    throw new Error(`expected a verified connection: ${result.message}`);
  // Connecting spent budget slots on the bundle sync; start clean so every
  // "zero calls" assertion below counts only the engine's own behaviour.
  calls = [];
  fetchMock.mockClear();
}

/** Rewrites the stored brief with `plan` stripped — a pre-Stage-6 draft. */
async function stripPlanFromStoredBrief(): Promise<void> {
  const db = getStudioSqliteDb();
  const row = db
    .prepare("SELECT brief_json FROM studio_drafts WHERE id = ?")
    .get(draftId) as { brief_json: string };
  const brief = JSON.parse(row.brief_json) as Record<string, unknown>;
  delete brief.plan;
  db.prepare("UPDATE studio_drafts SET brief_json = ? WHERE id = ?").run(
    JSON.stringify(brief),
    draftId,
  );
}

describe("Stage 6a provider resolution — the plan comes first", () => {
  it("a Starter website resolves to manual delivery for a LIVE order with no key at all", async () => {
    await seedDraft("starter");
    const order = await orders.create(bundleOrder());

    const provider = await resolveProviderForOrder(order, { integrations });

    expect(provider).toBeInstanceOf(ManualProvider);
    expect(provider.id).toBe(MANUAL_PROVIDER_ID);
    expect(provider.live).toBe(false);
    expect(provider.manual).toBe(true);
    expect(calls).toEqual([]);
  });

  it("a Starter website resolves to manual delivery for a TEST order too (before the test-mode branch)", async () => {
    await seedDraft("starter");
    const order = await orders.create(bundleOrder({ paymentMode: "test" }));

    const provider = await resolveProviderForOrder(order, { integrations });

    expect(provider).toBeInstanceOf(ManualProvider);
  });

  it("even a VERIFIED TechChief key never makes a Starter website send automatically", async () => {
    await seedDraft("starter");
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    const provider = await resolveProviderForOrder(order, { integrations });

    expect(provider).toBeInstanceOf(ManualProvider);
    expect(calls).toEqual([]);
  });

  it("a website without a plan (saved before Stage 6) keeps the pre-package behaviour", async () => {
    await seedDraft();
    await stripPlanFromStoredBrief();
    const order = await orders.create(bundleOrder());

    const provider = await resolveProviderForOrder(order, { integrations });

    // No key saved, live order → environment default (simulator), NOT manual:
    // the default plan is Auto-Dispatch Pro, the exact old behaviour.
    expect(provider).not.toBeInstanceOf(ManualProvider);
    expect(provider.id).toBe("simulator");
    expect(provider.live).not.toBe(true);
  });
});

describe("Stage 6a bundleDeliveryAvailabilityForDraft", () => {
  it("answers manual: true with the plan for a Starter website", async () => {
    await seedDraft("starter");

    const availability = await bundleDeliveryAvailabilityForDraft(draftId, {
      integrations,
    });

    expect(availability).toEqual({
      provider: MANUAL_PROVIDER_ID,
      live: false,
      manual: true,
      plan: "starter",
    });
  });

  it("keeps the automatic answer for Auto-Dispatch Pro, with or without a key", async () => {
    await seedDraft("auto_dispatch");

    // The automatic branch answers exactly as it did before packages existed
    // (the Stage 5 contract tests assert this two-field shape as-is).
    expect(
      await bundleDeliveryAvailabilityForDraft(draftId, { integrations }),
    ).toEqual({
      provider: "simulator",
      live: false,
    });

    await seedVerifiedConnection();
    const connected = await bundleDeliveryAvailabilityForDraft(draftId, {
      integrations,
    });
    expect(connected).toEqual({ provider: "techchief", live: true });
    expect(connected.manual).not.toBe(true);
    expect(calls).toEqual([]);
  });

  it("treats a brief without a plan as auto_dispatch", async () => {
    await seedDraft();
    await stripPlanFromStoredBrief();

    const availability = await bundleDeliveryAvailabilityForDraft(draftId, {
      integrations,
    });

    expect(availability).toEqual({ provider: "simulator", live: false });
    expect(availability.manual).not.toBe(true);
    expect(availability.plan).toBeUndefined();
  });
});

describe("Stage 6a manual dispatch — rows wait for a human", () => {
  it("a LIVE Starter order with no key creates pending manual rows and makes zero provider calls (guard b)", async () => {
    await seedDraft("starter");
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.provider).toBe(MANUAL_PROVIDER_ID);
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.providerRef).toBeUndefined();
      expect(row.lastError).toBeUndefined();
    }
    // NOT the live-block failure — the manual provider is exempt (guard b).
    expect(rows.every((row) => row.status !== "failed")).toBe(true);
    expect(
      rows.some((row) => row.lastError === NO_LIVE_DELIVERY_PROVIDER_MESSAGE),
    ).toBe(false);
    expect(calls).toEqual([]);
    expect((await orders.getById(order.id))?.status).toBe("paid");
  });

  it("a TEST-mode Starter order also produces manual rows — the simulator is never consulted", async () => {
    await seedDraft("starter");
    // Sharpen the proof: with the env default switched to the keyless
    // TechChief stub, any leak past the plan gate would fail the rows with
    // TECHCHIEF_NOT_CONNECTED instead of leaving them pending and manual.
    vi.stubEnv("BUNDLE_DELIVERY_PROVIDER", "techchief");
    const order = await orders.create(bundleOrder({ paymentMode: "test" }));

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe(MANUAL_PROVIDER_ID);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);
    expect(calls).toEqual([]);
  });

  it("a Starter order with a VERIFIED key still delivers by hand — zero fetch calls", async () => {
    await seedDraft("starter");
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, deps());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe(MANUAL_PROVIDER_ID);
    expect(rows[0]?.status).toBe("pending");
    expect(calls).toEqual([]);
  });

  it("guard a — repeated dispatch and recheck passes never CLAIM a manual row", async () => {
    await seedDraft("starter");
    const order = await orders.create(bundleOrder());

    await dispatchBundleDeliveriesForOrder(order.id, deps());
    await dispatchBundleDeliveriesForOrder(order.id, deps());
    await recheckBundleDeliveriesForOrder(order.id, deps());
    await recheckBundleDeliveriesForOrder(order.id, deps());

    const rows = await deliveries.listForOrder(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.provider).toBe(MANUAL_PROVIDER_ID);
  });

  it("rechecks skip manual rows even with a verified connection — no poll, no budget", async () => {
    await seedDraft("starter");
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    await dispatchBundleDeliveriesForOrder(order.id, deps());
    await recheckBundleDeliveriesForOrder(order.id, deps());
    await recheckBundleDeliveriesForOrder(order.id, deps());

    const rows = await deliveries.listForOrder(order.id);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);
    // The connection's hourly budget is spent only inside provider calls; a
    // clean call log after two rechecks proves none was made or spent.
    expect(calls).toEqual([]);
  });

  it("a stray Retry can never fabricate a manual send", async () => {
    await seedDraft("starter");
    const order = await orders.create(bundleOrder());
    await dispatchBundleDeliveriesForOrder(order.id, deps());

    // Force the row to "failed" the only way a manual row can ever get there
    // (a stray human/tool action in Stage 6c terms)…
    const rows = await deliveries.listForOrder(order.id);
    await deliveries.markFailed(rows[0]!.id, { error: "forced for test" });

    const retried = await retryBundleDeliveryFailures(
      OWNER_ID,
      order.id,
      deps(),
    );

    const row = retried?.deliveries[0];
    expect(row?.status).toBe("failed");
    expect(row?.status).not.toBe("delivered");
    expect(row?.providerRef).toBeUndefined();
    expect(row?.lastError).toBe(MANUAL_DELIVERY_SEND_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("a non-bundle website is untouched: plan or not, no rows and no calls", async () => {
    const restaurant = await drafts.create(
      userA,
      createDefaultBrief({
        businessName: "Not Bundles",
        category: "restaurant",
        plan: "starter",
        items: [{ id: "i1", name: "Jollof Rice", price: 45 }],
      }),
    );
    const odd = await orders.create(
      bundleOrder({
        draftId: restaurant.id,
        lines: [{ itemId: "i1", name: "Jollof Rice", price: 45, quantity: 1 }],
        recipientPhone: "0240000001",
      }),
    );

    expect(await dispatchBundleDeliveriesForOrder(odd.id, deps())).toEqual([]);
    expect(await deliveries.listForOrder(odd.id)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("Stage 6a guest summary — manual rows get their own pending line", () => {
  it("pending manual rows read 'sent by hand' with the masked number", () => {
    const summary = guestBundleDeliverySummary(
      [
        {
          provider: MANUAL_PROVIDER_ID,
          status: "pending",
          dataMb: 1024,
        },
      ],
      "0240000001",
    );

    expect(summary?.line).toBe(
      "The shop will send your bundle to 024 ••• 0001 by hand. Contact the shop if it does not arrive.",
    );
    // No full number on a guest surface.
    expect(summary?.line).not.toContain("0240000001");
  });

  it("pluralises for several pending manual units", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 2048 },
      ],
      "0240000001",
    );

    expect(summary?.line).toContain("your bundles");
    expect(summary?.line).toContain("by hand");
  });

  it("delivered and failed manual rows keep their existing wording", () => {
    const delivered = guestBundleDeliverySummary(
      [{ provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 1024 }],
      "0240000001",
    );
    expect(delivered?.line).toBe("1GB top-up delivered to 024 ••• 0001");

    const failed = guestBundleDeliverySummary(
      [{ provider: MANUAL_PROVIDER_ID, status: "failed", dataMb: 1024 }],
      "0240000001",
    );
    expect(failed?.line).toContain("hit a problem");
  });

  it("automatic pending rows keep the 'Sending…' line", () => {
    const summary = guestBundleDeliverySummary(
      [{ provider: "simulator", status: "pending", dataMb: 1024 }],
      "0240000001",
    );
    expect(summary?.line).toContain("Sending 1GB of data");
    expect(summary?.line).not.toContain("by hand");
  });
});

describe("Stage 6a owner-panel labels", () => {
  it("a pending manual row reads 'To send by hand'", () => {
    expect(
      deliveryStatusLabel({
        provider: MANUAL_PROVIDER_ID,
        status: "pending",
      }),
    ).toBe(MANUAL_DELIVERY_PENDING_LABEL);
    expect(MANUAL_DELIVERY_PENDING_LABEL).toBe("To send by hand");
  });

  it("every other status — and every automatic row — keeps its label", () => {
    expect(
      deliveryStatusLabel({ provider: "simulator", status: "pending" }),
    ).toBe("Waiting to send");
    expect(
      deliveryStatusLabel({
        provider: MANUAL_PROVIDER_ID,
        status: "delivered",
      }),
    ).toBe("Delivered");
    expect(
      deliveryStatusLabel({ provider: MANUAL_PROVIDER_ID, status: "failed" }),
    ).toBe("Failed");
  });
});
