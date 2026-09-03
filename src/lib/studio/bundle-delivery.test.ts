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
  bundleDeliveryAvailability,
  BundleDeliveryRetryError,
  dispatchBundleDeliveriesForOrder,
  getBundleDeliveryProvider,
  guestBundleDeliverySummary,
  LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE,
  MisconfiguredDeliveryProvider,
  NO_LIVE_DELIVERY_PROVIDER_MESSAGE,
  recheckBundleDeliveriesForOrder,
  retryBundleDeliveryFailures,
  SIMULATED_FAIL_MESSAGE,
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
import type { MerchantDeliveryFailureInput } from "./notifications";

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

function depsWith(
  provider: BundleDeliveryProvider,
  extra: Partial<BundleDeliveryDeps> = {},
): BundleDeliveryDeps {
  return { orders, deliveries, provider, ...extra };
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
  vi.useRealTimers();
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

  it("I1 — a live-money order is never dispatched through a non-live provider", async () => {
    const order = await orders.create(bundleOrder({ paymentMode: "live" }));
    const simulator = new SimulatedProvider();
    const sendSpy = vi.spyOn(simulator, "sendBundle");

    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(simulator),
    );

    // Rows exist (so the merchant sees the problem) but nothing was sent…
    expect(rows).toHaveLength(2);
    expect(sendSpy).not.toHaveBeenCalled();
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.lastError).toBe(NO_LIVE_DELIVERY_PROVIDER_MESSAGE);
      expect(row.attempts).toBe(0);
    }
    expect((await orders.getById(order.id))?.status).toBe("paid");

    // …and the owner's Retry stays honest rather than fabricating sends.
    const retried = await retryBundleDeliveryFailures(
      "owner-1",
      order.id,
      depsWith(simulator),
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(
      retried?.deliveries.every(
        (row) =>
          row.status === "failed" &&
          row.lastError === NO_LIVE_DELIVERY_PROVIDER_MESSAGE &&
          row.attempts === 0,
      ),
    ).toBe(true);
  });

  it("I2 — exactly one row per purchased bundle unit across webhook replays and rechecks", async () => {
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
    expect(provider.sends).toHaveLength(BUNDLE_LINES.length);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(
      rows.map((row) => `${row.lineIndex}.${row.unitIndex}`).sort(),
    ).toEqual(["0.0", "1.0"]);
  });

  it("I2 — claim-before-send survives concurrent passes: no unit is sent twice", async () => {
    const order = await orders.create(bundleOrder());

    // A provider that pauses mid-send until the test lets it through.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sends: BundleDeliveryDispatchRequest[] = [];
    const provider: BundleDeliveryProvider = {
      id: "gated",
      async sendBundle(request) {
        sends.push(request);
        await gate;
        return { ok: true, providerRef: `gated-${sends.length}` };
      },
      async checkStatus() {
        return { status: "processing" };
      },
    };

    // A webhook dispatch and a page-load recheck that overlap in time.
    const pass1 = dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    const pass2 = recheckBundleDeliveriesForOrder(order.id, depsWith(provider));
    release();
    await Promise.all([pass1, pass2]);

    // Two rows, exactly two sends — the atomic claim gave every unit to
    // exactly one concurrent caller.
    expect(await deliveries.listForOrder(order.id)).toHaveLength(2);
    expect(sends).toHaveLength(2);
    expect(
      sends.map((send) => `${send.lineIndex}.${send.unitIndex}`).sort(),
    ).toEqual(["0.0", "1.0"]);

    // The same holds for two concurrent owner retries on failed rows.
    const failing = new StubProvider();
    failing.sendResult = { ok: false, error: "down" };
    const failedOrder = await orders.create(bundleOrder());
    await dispatchBundleDeliveriesForOrder(failedOrder.id, depsWith(failing));

    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retrySends: BundleDeliveryDispatchRequest[] = [];
    const retryProvider: BundleDeliveryProvider = {
      id: "gated-retry",
      async sendBundle(request) {
        retrySends.push(request);
        await retryGate;
        return { ok: true, providerRef: `gated-retry-${retrySends.length}` };
      },
      async checkStatus() {
        return { status: "processing" };
      },
    };
    const retries = [
      retryBundleDeliveryFailures(
        "owner-1",
        failedOrder.id,
        depsWith(retryProvider),
      ),
      retryBundleDeliveryFailures(
        "owner-1",
        failedOrder.id,
        depsWith(retryProvider),
      ),
    ];
    releaseRetry();
    await Promise.all(retries);
    expect(retrySends).toHaveLength(2);
    const settled = await deliveries.listForOrder(failedOrder.id);
    expect(
      settled.every((row) => row.status === "processing" && row.attempts === 2),
    ).toBe(true);
  });

  it("I2 — a line with quantity 3 gets exactly 3 rows and 3 sends; a replay adds none", async () => {
    const order = await orders.create(
      bundleOrder({
        lines: [
          {
            itemId: "b1",
            name: "MTN 1GB",
            price: 10,
            quantity: 3,
            bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
          },
        ],
      }),
    );
    const provider = new StubProvider();

    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(rows).toHaveLength(3);
    expect(provider.sends).toHaveLength(3);
    expect(rows.map((row) => row.unitIndex).sort((a, b) => a - b)).toEqual([
      0, 1, 2,
    ]);
    expect(rows.every((row) => row.lineIndex === 0)).toBe(true);

    // Replay creates nothing and the steady state stays at 3 units.
    await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider));
    await recheckBundleDeliveriesForOrder(order.id, depsWith(provider));
    expect(await deliveries.listForOrder(order.id)).toHaveLength(3);
    expect(provider.sends).toHaveLength(3);
  });

  it("I2 — two order lines carrying the same item id do not collapse into one delivery", async () => {
    // A crafted checkout body could put the same item on two lines; the
    // (order_id, line_index, unit_index) key keeps both units addressable.
    const order = await orders.create(
      bundleOrder({
        lines: [
          { ...BUNDLE_LINES[0] },
          { ...BUNDLE_LINES[0], price: 10, quantity: 1 },
        ],
      }),
    );
    const provider = new StubProvider();
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.lineIndex).sort()).toEqual([0, 1]);
    expect(provider.sends).toHaveLength(2);
  });

  it("I3 — delivered is terminal: rechecks, retries, claims and store guards cannot move it", async () => {
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
    expect(await deliveries.claimForDispatch(id, { provider: "stub" })).toBe(
      false,
    );
    const settled = await deliveries.getById(id);
    expect(settled?.status).toBe("delivered");
    expect(settled?.deliveredAt).toBe(deliveredAt);
    expect(settled?.attempts).toBe(1);
  });

  it("I4 — a provider failure lands on the row as failed, never thrown back at the caller, and alerts once per pass", async () => {
    const order = await orders.create(
      bundleOrder({ draftId: await seededDraftId() }),
    );
    const provider = new StubProvider();
    provider.throwOnSend = true;
    const notify = vi.fn<
      (input: MerchantDeliveryFailureInput) => Promise<unknown>
    >(async () => ({}));

    // Dispatch resolves normally despite the provider blowing up…
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(provider, { notifyDeliveryFailed: notify }),
    );
    // …every failure is recorded on the row…
    expect(rows).toHaveLength(BUNDLE_LINES.length);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatch(/could not be reached/i);
      expect(row.attempts).toBe(1);
    }
    // …the payment is untouched…
    expect((await orders.getById(order.id))?.status).toBe("paid");
    // …and the merchant got exactly one aggregated alert for this pass.
    expect(notify).toHaveBeenCalledTimes(1);
    const alertInput = notify.mock.calls[0][0];
    expect(alertInput.order.id).toBe(order.id);
    expect(alertInput.deliveries).toHaveLength(2);
    expect(alertInput.total).toBe(2);

    // A later recheck sees only already-failed rows: it must NOT alert again.
    await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider, { notifyDeliveryFailed: notify }),
    );
    expect(notify).toHaveBeenCalledTimes(1);

    // A retry that fails again transitions rows in this pass, so it alerts
    // again — the owner needs to know their retry did not fix it.
    await retryBundleDeliveryFailures(
      "owner-1",
      order.id,
      depsWith(provider, { notifyDeliveryFailed: notify }),
    );
    expect(notify).toHaveBeenCalledTimes(2);

    // Explicit owner retry once the provider recovers: failed → processing →
    // delivered, with the attempt counter proving a second dispatch happened.
    provider.throwOnSend = false;
    const retried = await retryBundleDeliveryFailures(
      "owner-1",
      order.id,
      depsWith(provider, { notifyDeliveryFailed: notify }),
    );
    expect(
      retried?.deliveries.every(
        (row) =>
          row.status === "processing" &&
          row.attempts === 3 &&
          row.lastError === undefined,
      ),
    ).toBe(true);
    const settled = await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider, { notifyDeliveryFailed: notify }),
    );
    expect(settled.every((row) => row.status === "delivered")).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("I5 — other website types are untouched: no rows, no provider calls, no alerts", async () => {
    // A restaurant-style paid order: no recipient, no bundle metadata.
    const restaurant = await orders.create(
      bundleOrder({
        lines: [{ itemId: "i1", name: "Jollof Rice", price: 45, quantity: 2 }],
        recipientPhone: undefined,
      }),
    );
    const provider = new StubProvider();
    const notify = vi.fn<
      (input: MerchantDeliveryFailureInput) => Promise<unknown>
    >(async () => ({}));
    expect(
      await dispatchBundleDeliveriesForOrder(
        restaurant.id,
        depsWith(provider, { notifyDeliveryFailed: notify }),
      ),
    ).toEqual([]);
    expect(await deliveries.listForOrder(restaurant.id)).toEqual([]);
    expect(provider.sends).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

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
      await dispatchBundleDeliveriesForOrder(
        odd.id,
        depsWith(provider, { notifyDeliveryFailed: notify }),
      ),
    ).toEqual([]);
    expect(await deliveries.listForOrder(odd.id)).toEqual([]);
    expect(provider.sends).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
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
      lineIndex: 0,
      unitIndex: 0,
      recipientPhone: "0240000001",
      network: "mtn",
      dataMb: 1024,
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
      lineIndex: 0,
      unitIndex: 0,
      recipientPhone: "12345",
      network: "mtn",
      dataMb: 1024,
    });
    expect(refused.ok).toBe(false);
  });

  it("simulator fails a test number ending 0000 so Failed → Retry can be rehearsed", async () => {
    const simulator = new SimulatedProvider();
    const request = {
      orderId: "o1",
      deliveryId: "d1",
      attempt: 1,
      lineIndex: 0,
      unitIndex: 0,
      recipientPhone: "0240000000",
      network: "mtn" as const,
      dataMb: 1024,
    };
    const sent = await simulator.sendBundle(request);
    expect(sent).toEqual({ ok: false, error: SIMULATED_FAIL_MESSAGE });

    // Through the engine the refusal becomes a failed, retryable row.
    const order = await orders.create(
      bundleOrder({ recipientPhone: "0240000000" }),
    );
    const rows = await dispatchBundleDeliveriesForOrder(
      order.id,
      depsWith(simulator),
    );
    expect(
      rows.every(
        (row) =>
          row.status === "failed" && row.lastError === SIMULATED_FAIL_MESSAGE,
      ),
    ).toBe(true);
  });

  it("simulator keeps a test number ending 9999 processing for 60 seconds, then delivers", async () => {
    const simulator = new SimulatedProvider();
    const sent = await simulator.sendBundle({
      orderId: "o1",
      deliveryId: "d1",
      attempt: 1,
      lineIndex: 0,
      unitIndex: 0,
      recipientPhone: "0240009999",
      network: "mtn",
      dataMb: 1024,
    });
    expect(sent.ok).toBe(true);
    const ref = sent.ok ? sent.providerRef! : "";
    expect(ref).toMatch(/^sim-slow-\d+-/);

    // Fresh slow refs are still in flight…
    await expect(simulator.checkStatus({ providerRef: ref })).resolves.toEqual({
      status: "processing",
    });
    // …a ref minted long enough ago settles. The send time travels inside the
    // reference, so this works across restarts with no in-memory state.
    await expect(
      simulator.checkStatus({ providerRef: "sim-slow-1-00000000" }),
    ).resolves.toEqual({ status: "delivered" });

    // The boundary itself, against a frozen clock.
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    const timed = await simulator.sendBundle({
      orderId: "o1",
      deliveryId: "d2",
      attempt: 1,
      lineIndex: 0,
      unitIndex: 0,
      recipientPhone: "0240009999",
      network: "mtn",
      dataMb: 1024,
    });
    const timedRef = timed.ok ? timed.providerRef! : "";
    await expect(
      simulator.checkStatus({ providerRef: timedRef }),
    ).resolves.toEqual({ status: "processing" });
    vi.setSystemTime(start + 61_000);
    await expect(
      simulator.checkStatus({ providerRef: timedRef }),
    ).resolves.toEqual({ status: "delivered" });
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
      lineIndex: 0,
      unitIndex: 0,
      recipientPhone: "0240000001",
      network: "mtn",
      dataMb: 1024,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("techcheif");
  });

  it("availability: nothing connected today is live-capable", () => {
    expect(bundleDeliveryAvailability(new SimulatedProvider())).toEqual({
      provider: "simulator",
      live: false,
    });
    expect(bundleDeliveryAvailability(new TechChiefProvider())).toEqual({
      provider: "techchief",
      live: false,
    });
    expect(bundleDeliveryAvailability()).toMatchObject({ live: false });
    expect(LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE).toContain("contact");
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
    const order = await orders.create(
      bundleOrder({ draftId: await seededDraftId() }),
    );
    const provider = new StubProvider();
    provider.checkResult = { status: "failed", error: "insufficient balance" };
    const notify = vi.fn<
      (input: MerchantDeliveryFailureInput) => Promise<unknown>
    >(async () => ({}));
    await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider));
    const rows = await recheckBundleDeliveriesForOrder(
      order.id,
      depsWith(provider, { notifyDeliveryFailed: notify }),
    );
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(rows.every((row) => row.lastError === "insufficient balance")).toBe(
      true,
    );
    // Provider-reported failures on recheck also alert, once, aggregated.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].deliveries).toHaveLength(2);
  });

  it("claimForDispatch moves pending→processing exactly once and counts the attempt", async () => {
    const order = await orders.create(bundleOrder());
    const provider = new StubProvider();
    await dispatchBundleDeliveriesForOrder(order.id, depsWith(provider));
    const [row] = await deliveries.listForOrder(order.id);

    // The row is already processing after dispatch, so a fresh claim fails…
    expect(row.status).toBe("processing");
    expect(row.attempts).toBe(1);
    expect(await deliveries.claimForDispatch(row.id, { provider: "x" })).toBe(
      false,
    );
    // …but after a failure the row is claimable again for Retry.
    await deliveries.markFailed(row.id, { error: "boom" });
    expect(await deliveries.claimForDispatch(row.id, { provider: "x" })).toBe(
      true,
    );
    const claimed = await deliveries.getById(row.id);
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attempts).toBe(2);
    expect(claimed?.provider).toBe("x");
    expect(claimed?.providerRef).toBeUndefined();
    expect(claimed?.lastError).toBeUndefined();
    // setProviderRef only applies to claimed rows.
    await deliveries.setProviderRef(row.id, "ref-123");
    expect((await deliveries.getById(row.id))?.providerRef).toBe("ref-123");
  });
});

// --------------------------------------------------------------------------

function seedBundleDraft() {
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

async function seededDraftId(): Promise<string> {
  return (await seedBundleDraft()).id;
}
