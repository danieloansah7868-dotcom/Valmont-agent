/**
 * Stage 4 bundle delivery engine — contract and invariant tests.
 *
 * Every invariant in the module header of `bundle-delivery.ts` has a
 * dedicated test below (I1–I6). The tests run against the real SQLite stores
 * (orders + deliveries) with a recording stub provider, so they cover the
 * engine's row lifecycle exactly as production uses it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  BundleDeliveryRetryError,
  dispatchBundleDeliveriesForOrder,
  getBundleDeliveryProvider,
  guestBundleDeliverySummary,
  MisconfiguredDeliveryProvider,
  recheckBundleDeliveriesForOrder,
  retryBundleDeliveryFailures,
  SimulatedProvider,
  SqliteBundleDeliveriesStore,
  TECHCHIEF_NOT_CONNECTED_MESSAGE,
  TechChiefProvider,
  type BundleDeliveryDeps,
  type BundleDeliveryDispatchRequest,
  type BundleDeliveryProvider,
  type BundleDeliverySendResult,
  type BundleDeliveryStatusRequest,
  type BundleDeliveryStatusResult,
} from "./bundle-delivery";
import { SqliteOrdersStore, type NewOrderInput } from "./orders";
import { SqliteStudioDraftStore } from "./draft-store";
import { createDefaultBrief } from "./site-brief/defaults";

const dirs: string[] = [];
let orders: SqliteOrdersStore;
let deliveries: SqliteBundleDeliveriesStore;
let sequence = 0;

/** A provider the tests steer: it records every call and replays scripted outcomes. */
class StubProvider implements BundleDeliveryProvider {
  readonly id = "stub";
  sends: BundleDeliveryDispatchRequest[] = [];
  checks: BundleDeliveryStatusRequest[] = [];
  sendResult: BundleDeliverySendResult = { ok: true };
  checkResult: BundleDeliveryStatusResult = { status: "delivered" };
  throwOnSend = false;

  async sendBundle(
    request: BundleDeliveryDispatchRequest,
  ): Promise<BundleDeliverySendResult> {
    this.sends.push(request);
    if (this.throwOnSend) throw new Error("provider is down");
    if (this.sendResult.ok && !this.sendResult.providerRef) {
      return {
        ...this.sendResult,
        providerRef: `stub-ref-${this.sends.length}`,
      };
    }
    return this.sendResult;
  }

  async checkStatus(
    request: BundleDeliveryStatusRequest,
  ): Promise<BundleDeliveryStatusResult> {
    this.checks.push(request);
    return this.checkResult;
  }
}

function depsWith(provider: BundleDeliveryProvider): BundleDeliveryDeps {
  return { orders, deliveries, provider };
}

const BUNDLE_LINES = [
  {
    itemId: "b1",
    name: "MTN 1GB",
    price: 10,
    quantity: 1,
    bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
  },
  {
    itemId: "b2",
    name: "Telecel 2GB",
    price: 14,
    quantity: 1,
    bundle: { network: "telecel", dataMb: 2048, validity: "30 days" },
  },
];

function bundleOrder(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  sequence += 1;
  return {
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: `bundle-code-${sequence}`,
    status: "paid",
    currency: "GHS",
    subtotal: 24,
    deliveryFee: 0,
    total: 24,
    lines: BUNDLE_LINES,
    customerName: "Ama",
    customerPhone: "0240000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "test",
    ...overrides,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-deliveries-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  orders = new SqliteOrdersStore();
  deliveries = new SqliteBundleDeliveriesStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("bundle delivery engine invariants", () => {
  it("I1 — creates nothing and never calls the provider before payment", async () => {
    for (const status of [
      "pending",
      "payment_failed",
      "cancelled",
      "refunded",
    ] as const) {
      const order = await orders.create(bundleOrder({ status }));
      const provider = new StubProvider();

      const rows = await dispatchBundleDeliveriesForOrder(
        order.id,
        depsWith(provider),
      );

      expect(rows).toEqual([]);
      expect(await deliveries.listForOrder(order.id)).toEqual([]);
      expect(provider.sends).toEqual([]);

      const reconciled = await recheckBundleDeliveriesForOrder(
        order.id,
        depsWith(provider),
      );
      expect(reconciled).toEqual([]);
      expect(provider.sends).toEqual([]);
      expect(provider.checks).toEqual([]);
    }
  });

  it("I2 — exactly one row per paid bundle line across webhook replays and rechecks", async () => {
    // The realistic sequence: checkout created a pending order, the webhook
    // marked it paid, dispatched — then the same webhook was delivered again.
    const order = await orders.create(bundleOrder({ status: "pending" }));
    const provider = new StubProvider();

    await orders.markPaid(order.accessCode, "pay-ref-1");
    const first = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(first).toHaveLength(BUNDLE_LINES.length);
    expect(provider.sends).toHaveLength(BUNDLE_LINES.length);

    // Webhook replay: markPaid is a no-op and so is the dispatch.
    await orders.markPaid(order.accessCode, "pay-ref-1");
    const replayed = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(replayed).toHaveLength(BUNDLE_LINES.length);
    expect(provider.sends).toHaveLength(BUNDLE_LINES.length);

    // Page-load rechecks keep the same rows and send nothing new.
    await recheckBundleDeliveriesForOrder(order.id, depsWith(provider));
    const rows = await deliveries.listForOrder(order.id);
    expect(rows).toHaveLength(BUNDLE_LINES.length);
    expect(new Set(rows.map((row) => row.itemId))).toEqual(
      new Set(BUNDLE_LINES.map((line) => line.itemId)),
    );
    expect(provider.sends).toHaveLength(BUNDLE_LINES.length);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });

  it("I3 — delivered is terminal: rechecks, retries and store guards cannot move it", async () => {
    const order = await orders.create(bundleOrder());
    const provider = new StubProvider();

    await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider));
    const done = await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(done.every((row) => row.status === "delivered")).toBe(true);
    const deliveredAt = done[0].deliveredAt;
    expect(deliveredAt).toBeTruthy();

    // A steady-state recheck asks the provider nothing more.
    provider.checks.length = 0;
    provider.sends.length = 0;
    const again = await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(again.every((row) => row.status === "delivered")).toBe(true);
    expect(provider.checks).toEqual([]);
    expect(provider.sends).toEqual([]);
    expect(again[0].deliveredAt).toBe(deliveredAt);

    // The owner Retry action leaves delivered rows untouched.
    const attempted = await retryBundleDeliveryFailures(
      "owner-1",
      order.id,
      depsWith(provider),
    );
    expect(provider.sends).toEqual([]);
    expect(
      attempted?.deliveries.every(
        (row) => row.status === "delivered" && row.attempts === 1,
      ),
    ).toBe(true);

    // Store-level guards agree: nothing moves a delivered row.
    const id = done[0].id;
    await deliveries.markFailed(id, { error: "late failure" });
    await deliveries.markProcessing(id, {
      provider: "stub",
      providerRef: "stub-ref-late",
    });
    const settled = await deliveries.getById(id);
    expect(settled?.status).toBe("delivered");
    expect(settled?.deliveredAt).toBe(deliveredAt);
    expect(settled?.attempts).toBe(1);
  });

  it("I4 — a provider failure lands on the row as failed, never thrown back at the caller", async () => {
    const order = await orders.create(bundleOrder());
    const provider = new StubProvider();
    provider.throwOnSend = true;

    // Dispatch resolves normally despite the provider blowing up…
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    // …every failure is recorded on the row…
    expect(rows).toHaveLength(BUNDLE_LINES.length);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatch(/could not be reached/i);
      expect(row.attempts).toBe(1);
    }
    // …and the payment is untouched.
    expect((await orders.getById(order.id))?.status).toBe("paid");

    // Explicit owner retry once the provider recovers: failed → processing →
    // delivered, with the attempt counter proving a second dispatch happened.
    provider.throwOnSend = false;
    const retried = await retryBundleDeliveryFailures(
      "owner-1",
      order.id,
      depsWith(provider),
    );
    expect(provider.sends).toHaveLength(BUNDLE_LINES.length * 2);
    expect(
      retried?.deliveries.every(
        (row) =>
          row.status === "processing" &&
          row.attempts === 2 &&
          row.lastError === undefined,
      ),
    ).toBe(true);
    const settled = await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(settled.every((row) => row.status === "delivered")).toBe(true);
  });

  it("I5 — other website types are untouched: no rows, no provider calls", async () => {
    // A restaurant-style paid order: no recipient, no bundle metadata.
    const restaurant = await orders.create(
      bundleOrder({
        lines: [{ itemId: "i1", name: "Jollof Rice", price: 45, quantity: 2 }],
        recipientPhone: undefined,
      }),
    );
    const provider = new StubProvider();
    expect(
      await dispatchBundleDeliveriesForOrder(restaurant.id, depsWith(provider)),
    ).toEqual([]);
    expect(await deliveries.listForOrder(restaurant.id)).toEqual([]);
    expect(provider.sends).toEqual([]);

    // Even an inconsistent order that somehow carries a recipient but belongs
    // to a non-bundle website is vetoed by the draft's category.
    const draftStore = new SqliteStudioDraftStore();
    const restaurantDraft = await draftStore.create(
      { id: "owner-1", login: "merchant", name: "Merchant" },
      createDefaultBrief({
        businessName: "Not Bundles",
        category: "restaurant",
        items: [{ id: "i1", name: "Jollof Rice", price: 45 }],
      }),
    );
    const odd = await orders.create(
      bundleOrder({
        draftId: restaurantDraft.id,
        lines: [{ itemId: "i1", name: "Jollof Rice", price: 45, quantity: 1 }],
        recipientPhone: "0240000001",
      }),
    );
    expect(
      await dispatchBundleDeliveriesForOrder(odd.id, depsWith(provider)),
    ).toEqual([]);
    expect(await deliveries.listForOrder(odd.id)).toEqual([]);
    expect(provider.sends).toEqual([]);
  });

  it("I6 — the guest line is an aggregate with a masked number and no internals", async () => {
    const order = await orders.create(bundleOrder());
    const simulator = new SimulatedProvider();
    await dispatchBundleDeliveriesForOrder(order.id, depsWith(simulator));
    let rows = await deliveries.listForOrder(order.id);

    // In-progress aggregate (3GB total, masked recipient, no provider refs).
    const inProgress = guestBundleDeliverySummary(rows, order.recipientPhone);
    expect(inProgress).not.toBeNull();
    expect(inProgress?.line).toContain("024 ••• 0001");
    expect(inProgress?.line).toContain("3GB");
    expect(inProgress?.line).toMatch(/0 of 2 delivered/);
    expect(inProgress?.line).not.toContain("0240000001");
    expect(inProgress?.line).not.toContain("sim-");

    // Fully delivered aggregate.
    rows = await recheckBundleDeliveriesForOrder(order.id, depsWith(simulator));
    const finished = guestBundleDeliverySummary(rows, order.recipientPhone);
    expect(finished?.line).toBe(
      "All 2 top-ups (3GB) delivered to 024 ••• 0001",
    );

    // Failure aggregate: plain language, still no internals or full number.
    const failing = new StubProvider();
    failing.sendResult = { ok: false, error: "provider internals: balance" };
    const second = await orders.create(bundleOrder());
    const failedRows = await dispatchBundleDeliveriesForOrder(
      second.id,
      depsWith(failing),
    );
    expect(failedRows.every((row) => row.status === "failed")).toBe(true);
    const broken = guestBundleDeliverySummary(
      failedRows,
      second.recipientPhone,
    );
    expect(broken?.line).toContain("024 ••• 0001");
    expect(broken?.line).toMatch(/problem/);
    expect(broken?.line).not.toContain("internals");
    expect(broken?.line).not.toContain("balance");
    expect(broken?.line).not.toContain("0240000001");

    // Nothing to say → nothing rendered.
    expect(guestBundleDeliverySummary([], order.recipientPhone)).toBeNull();
    expect(guestBundleDeliverySummary(rows, undefined)).toBeNull();
  });
});

describe("providers", () => {
  it("simulator accepts as processing and reports delivered on the next check", async () => {
    const simulator = new SimulatedProvider();
    const sent = await simulator.sendBundle({
      orderId: "o1",
      deliveryId: "d1",
      attempt: 1,
      recipientPhone: "0240000001",
      network: "mtn",
      dataMb: 1024,
      quantity: 1,
    });
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.providerRef).toMatch(/^sim-/);
    const ref = sent.ok ? sent.providerRef! : "";
    await expect(simulator.checkStatus({ providerRef: ref })).resolves.toEqual({
      status: "delivered",
    });
    await expect(
      simulator.checkStatus({ providerRef: "unknown-ref" }),
    ).resolves.toEqual({ status: "processing" });

    // A malformed recipient can never be reported as sent.
    const refused = await simulator.sendBundle({
      orderId: "o1",
      deliveryId: "d2",
      attempt: 1,
      recipientPhone: "12345",
      network: "mtn",
      dataMb: 1024,
      quantity: 1,
    });
    expect(refused.ok).toBe(false);
  });

  it("techchief stub fails every send loudly and records the reason on the row", async () => {
    const order = await orders.create(bundleOrder());
    const techchief = new TechChiefProvider();
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(techchief),
    );
    expect(rows).toHaveLength(BUNDLE_LINES.length);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.provider).toBe("techchief");
      expect(row.lastError).toBe(TECHCHIEF_NOT_CONNECTED_MESSAGE);
    }
    // Retry stays loud instead of pretending a Stage 5 connection exists.
    const retried = await retryBundleDeliveryFailures(
      "owner-1",
      order.id,
      depsWith(techchief),
    );
    expect(
      retried?.deliveries.every(
        (row) => row.status === "failed" && row.attempts === 2,
      ),
    ).toBe(true);
    expect(await techchief.checkStatus({ providerRef: "anything" })).toEqual({
      status: "processing",
    });
  });

  it("provider selection: default simulator, explicit techchief, unknown fails closed", async () => {
    delete process.env.BUNDLE_DELIVERY_PROVIDER;
    expect(getBundleDeliveryProvider()).toBeInstanceOf(SimulatedProvider);
    vi.stubEnv("BUNDLE_DELIVERY_PROVIDER", "simulator");
    expect(getBundleDeliveryProvider()).toBeInstanceOf(SimulatedProvider);
    vi.stubEnv("BUNDLE_DELIVERY_PROVIDER", "techchief");
    expect(getBundleDeliveryProvider()).toBeInstanceOf(TechChiefProvider);
    // A typo must never activate the simulator in production.
    vi.stubEnv("BUNDLE_DELIVERY_PROVIDER", "techcheif");
    const typo = getBundleDeliveryProvider();
    expect(typo).toBeInstanceOf(MisconfiguredDeliveryProvider);
    const refused = await typo.sendBundle({
      orderId: "o1",
      deliveryId: "d1",
      attempt: 1,
      recipientPhone: "0240000001",
      network: "mtn",
      dataMb: 1024,
      quantity: 1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("techcheif");
  });
});

describe("bundle metadata resolution", () => {
  /** The same bundle lines as they look on orders paid before Stage 4: no snapshot. */
  function unsnapshottedLines() {
    return BUNDLE_LINES.map((line) => ({
      itemId: line.itemId,
      name: line.name,
      price: line.price,
      quantity: line.quantity,
    }));
  }

  async function seedBundleDraft() {
    const draftStore = new SqliteStudioDraftStore();
    return draftStore.create(
      { id: "owner-1", login: "merchant", name: "Merchant" },
      createDefaultBrief({
        businessName: "Bundle Shop",
        category: "data-bundles",
        items: [
          {
            id: "b1",
            name: "MTN 1GB",
            price: 10,
            bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
          },
          {
            id: "b2",
            name: "Telecel 2GB",
            price: 14,
            bundle: { network: "telecel", dataMb: 2048, validity: "30 days" },
          },
        ],
      }),
    );
  }

  it("resolves legacy orders (no snapshot) from the live catalogue", async () => {
    const draft = await seedBundleDraft();
    const order = await orders.create(
      bundleOrder({
        draftId: draft.id,
        lines: unsnapshottedLines(),
      }),
    );
    const provider = new StubProvider();
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(rows).toHaveLength(2);
    const byItem = new Map(rows.map((row) => [row.itemId, row]));
    expect(byItem.get("b1")).toMatchObject({
      network: "mtn",
      dataMb: 1024,
      validity: "7 days",
    });
    expect(byItem.get("b2")).toMatchObject({
      network: "telecel",
      dataMb: 2048,
    });
  });

  it("the checkout snapshot wins over later catalogue edits", async () => {
    const draft = await seedBundleDraft();
    // The order line carries its checkout-time snapshot, so the engine never
    // needs the live catalogue for it — the draft could even change later.
    const order = await orders.create(bundleOrder({ draftId: draft.id }));
    const provider = new StubProvider();
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(rows.map((row) => row.dataMb).sort((a, b) => a - b)).toEqual([
      1024, 2048,
    ]);
    expect(
      provider.sends.map((send) => send.dataMb).sort((a, b) => a - b),
    ).toEqual([1024, 2048]);
  });

  it("a deleted draft with no snapshot simply skips — never breaks the caller", async () => {
    const order = await orders.create(
      bundleOrder({
        draftId: "draft-that-no-longer-exists",
        lines: unsnapshottedLines(),
      }),
    );
    const provider = new StubProvider();
    expect(
      await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider)),
    ).toEqual([]);
    expect(
      await recheckBundleDeliveriesForOrder(order.id, depsWith(provider)),
    ).toEqual([]);
    expect(provider.sends).toEqual([]);
  });
});

describe("retry route semantics", () => {
  it("is owner-scoped: a cross-tenant order id yields null before any row is revealed", async () => {
    const order = await orders.create(bundleOrder());
    const provider = new StubProvider();
    await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider));

    const result = await retryBundleDeliveryFailures(
      "someone-else",
      order.id,
      depsWith(provider),
    );
    expect(result).toBeNull();
    expect(provider.sends).toHaveLength(BUNDLE_LINES.length);
  });

  it("refuses to retry on an order whose payment is not settled", async () => {
    const order = await orders.create(bundleOrder({ status: "pending" }));
    await expect(
      retryBundleDeliveryFailures("owner-1", order.id),
    ).rejects.toBeInstanceOf(BundleDeliveryRetryError);
    await expect(
      retryBundleDeliveryFailures("owner-1", order.id),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("a failed check from the provider marks the row failed with its reason", async () => {
    const order = await orders.create(bundleOrder());
    const provider = new StubProvider();
    provider.checkResult = { status: "failed", error: "insufficient balance" };
    await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider));
    const rows = await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(rows.every((row) => row.lastError === "insufficient balance")).toBe(
      true,
    );
  });
});
