/**
 * Stage 4b — the per-pass ceiling on status polls.
 *
 * A recheck runs on every load of the owner's order page *and* of the
 * unauthenticated guest confirmation page, so the number of provider calls one
 * page load can cause has to be bounded by something other than the size of the
 * order. These tests pin the three properties that matter:
 *
 *  1. at most {@link MAX_PROCESSING_POLLS_PER_PASS} rows are asked about,
 *  2. the rows that have been waiting longest go first, so a big order works
 *     through its queue instead of forever re-asking about the newest top-ups,
 *  3. a row that cannot be polled yet (no provider reference) is skipped
 *     without spending the budget — otherwise one stuck row would hold a slot
 *     at the front of the queue and starve everything behind it.
 *
 * The store and the provider are both fakes here on purpose: the point is which
 * rows the engine *chooses*, and a fake lets the test hand over 30 rows whose
 * `updated_at` values are exact and whose list order is deliberately not
 * chronological.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PROCESSING_POLLS_PER_PASS,
  recheckBundleDeliveriesForOrder,
  type BundleDeliveriesStore,
  type BundleDeliveryProvider,
  type BundleDeliveryRecord,
  type BundleDeliveryStatusRequest,
  type NewBundleDeliveryInput,
} from "./bundle-delivery";
import type { OrderRecord, OrdersStore } from "./orders";

const ORDER_ID = "11111111-2222-4333-8444-555555555555";
const PROVIDER_ID = "fake-live";

/** One in-flight row, `minutesOld` minutes before "now". */
function processingRow(
  index: number,
  minutesOld: number,
): BundleDeliveryRecord {
  const stamp = new Date(
    Date.parse("2026-09-04T12:00:00.000Z") - minutesOld * 60_000,
  ).toISOString();
  return {
    id: `row-${String(index).padStart(2, "0")}`,
    orderId: ORDER_ID,
    ownerId: "owner-1",
    lineIndex: Math.floor(index / 10),
    unitIndex: index % 10,
    itemId: "bundle-00",
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    validity: "7 days",
    recipientPhone: "0240000001",
    provider: PROVIDER_ID,
    status: "processing",
    attempts: 1,
    providerRef: `DEV-${String(index).padStart(4, "0")}`,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** A paid live-money bundle order with three lines of ten units each. */
function paidOrder(): OrderRecord {
  return {
    id: ORDER_ID,
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: "ABC123",
    status: "paid",
    currency: "GHS",
    subtotal: 300,
    deliveryFee: 0,
    total: 300,
    lines: [0, 1, 2].map((lineIndex) => ({
      itemId: "bundle-00",
      name: "MTN 1GB",
      price: 10,
      quantity: 10,
      bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      // Unused by the engine, present so the record is a whole order.
      image: undefined,
      __lineIndex: lineIndex,
    })) as OrderRecord["lines"],
    customerName: "Kwame Buyer",
    customerPhone: "0200000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    statusHistory: [],
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:05:00.000Z",
  } as unknown as OrderRecord;
}

/** In-memory stand-in for the deliveries store. */
class FakeDeliveriesStore implements BundleDeliveriesStore {
  rows: BundleDeliveryRecord[] = [];
  /** Ids whose heartbeat the engine bumped, in order. */
  touched: string[] = [];

  constructor(rows: BundleDeliveryRecord[]) {
    this.rows = rows;
  }

  async createMany(
    inputs: NewBundleDeliveryInput[],
  ): Promise<BundleDeliveryRecord[]> {
    // Idempotent, like the real store: rows that already exist are left alone
    // and the full list for the order comes back.
    void inputs;
    return this.listForOrder(ORDER_ID);
  }

  async listForOrder(orderId: string): Promise<BundleDeliveryRecord[]> {
    return this.rows.filter((row) => row.orderId === orderId);
  }

  async getById(id: string): Promise<BundleDeliveryRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listByProviderRef(
    providerRef: string,
  ): Promise<BundleDeliveryRecord[]> {
    return this.rows.filter((row) => row.providerRef === providerRef);
  }

  async claimForDispatch(id: string): Promise<boolean> {
    const row = await this.getById(id);
    if (!row || (row.status !== "pending" && row.status !== "failed")) {
      return false;
    }
    row.status = "processing";
    row.attempts += 1;
    return true;
  }

  async touchProcessing(id: string): Promise<void> {
    const row = await this.getById(id);
    if (!row || row.status !== "processing") return;
    this.touched.push(id);
    row.updatedAt = new Date().toISOString();
  }

  async setProviderRef(
    id: string,
    providerRef: string | null,
  ): Promise<BundleDeliveryRecord | null> {
    const row = await this.getById(id);
    if (!row) return null;
    row.providerRef = providerRef ?? undefined;
    return row;
  }

  async markFailed(
    id: string,
    patch: { error: string },
  ): Promise<BundleDeliveryRecord | null> {
    const row = await this.getById(id);
    if (!row) return null;
    row.status = "failed";
    row.lastError = patch.error;
    return row;
  }

  async markDelivered(id: string): Promise<BundleDeliveryRecord | null> {
    const row = await this.getById(id);
    if (!row || row.status === "delivered" || row.status === "failed") {
      return row ?? null;
    }
    row.status = "delivered";
    return row;
  }
}

/** A live provider that records every status question it is asked. */
function fakeProvider(answers: "processing" | "delivered" = "processing") {
  const polled: string[] = [];
  const provider: BundleDeliveryProvider = {
    id: PROVIDER_ID,
    live: true,
    async sendBundle() {
      return { ok: true, providerRef: "DEV-SENT" };
    },
    async checkStatus(request: BundleDeliveryStatusRequest) {
      // The engine always passes the row id; the field is optional on the
      // contract, so the fake records a placeholder rather than failing types.
      polled.push(request.deliveryId ?? "");
      return answers === "delivered"
        ? { status: "delivered" as const }
        : { status: "processing" as const, polled: true };
    },
  };
  return { provider, polled };
}

function ordersReturning(order: OrderRecord | null) {
  return {
    getById: async (id: string) => (id === order?.id ? order : null),
  } as unknown as OrdersStore;
}

describe("recheck — the per-pass poll ceiling", () => {
  it("asks about at most 25 in-flight rows in one pass", async () => {
    // 30 rows, deliberately listed newest-first so the sort has to do the work.
    const rows = Array.from({ length: 30 }, (_, index) =>
      processingRow(index, index),
    ).reverse();
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider();

    await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    expect(polled).toHaveLength(MAX_PROCESSING_POLLS_PER_PASS);
    expect(MAX_PROCESSING_POLLS_PER_PASS).toBe(25);
  });

  it("polls the rows that have been waiting longest first", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      processingRow(index, index),
    ).reverse();
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider();

    await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    // row-29 is the oldest (29 minutes), row-00 the newest.
    expect(polled[0]).toBe("row-29");
    expect(polled[polled.length - 1]).toBe("row-05");
    // The five newest wait for the next pass rather than being polled twice.
    for (const skipped of ["row-00", "row-01", "row-02", "row-03", "row-04"]) {
      expect(polled).not.toContain(skipped);
    }
  });

  it("heartbeats only the rows it actually asked about", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      processingRow(index, index),
    );
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider();

    await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    // The Stage 5 heartbeat still fires for every real poll, and only for
    // those: an unpolled row keeps its old timestamp so it stays at the front
    // of the queue on the next pass instead of being permanently starved.
    expect(deliveries.touched).toEqual(polled);
    expect(deliveries.touched).toHaveLength(25);
  });

  it("does not spend the budget on rows that cannot be polled yet", async () => {
    // The ten oldest rows lost their provider reference (a dispatch that was
    // interrupted before the reference was recorded). They must be skipped
    // without eating the 25 slots, or they would block the queue forever.
    const rows = Array.from({ length: 30 }, (_, index) => {
      const row = processingRow(index, index);
      if (index >= 20) row.providerRef = undefined;
      return row;
    });
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider();

    await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    expect(polled).toHaveLength(20);
    expect(polled.every((id) => !["row-29", "row-20"].includes(id))).toBe(true);
    expect(polled).toContain("row-00");
  });

  it("polls every row when an order is inside the ceiling", async () => {
    // The ordinary case — a 20-unit order, the most the caps now allow — must
    // behave exactly as it did before the ceiling existed.
    const rows = Array.from({ length: 20 }, (_, index) =>
      processingRow(index, index),
    );
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider();

    await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    expect(polled).toHaveLength(20);
  });

  it("never polls a settled row, and does not count it against the ceiling", async () => {
    const rows: BundleDeliveryRecord[] = [
      // Ten settled rows that would otherwise occupy the front of the queue.
      ...Array.from({ length: 10 }, (_, index) => {
        const row = processingRow(index, 100 + index);
        row.status = index % 2 === 0 ? "delivered" : "failed";
        return row;
      }),
      ...Array.from({ length: 30 }, (_, index) =>
        processingRow(index + 10, index),
      ),
    ];
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider();

    await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    expect(polled).toHaveLength(25);
    expect(polled.some((id) => ["row-00", "row-01"].includes(id))).toBe(false);
    // A delivered row is terminal (I3): the pass did not touch it either.
    expect(deliveries.touched).not.toContain("row-00");
  });

  it("marks a row delivered when the provider says so, inside the ceiling", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      processingRow(index, index),
    );
    const deliveries = new FakeDeliveriesStore(rows);
    const { provider, polled } = fakeProvider("delivered");

    const result = await recheckBundleDeliveriesForOrder(ORDER_ID, {
      orders: ordersReturning(paidOrder()),
      deliveries,
      provider,
    });

    expect(polled).toHaveLength(25);
    const delivered = result.filter((row) => row.status === "delivered");
    expect(delivered).toHaveLength(25);
    expect(result.filter((row) => row.status === "processing")).toHaveLength(5);
  });

  it("polls nothing at all for an order it cannot find", async () => {
    const deliveries = new FakeDeliveriesStore([processingRow(0, 1)]);
    const { provider, polled } = fakeProvider();

    const result = await recheckBundleDeliveriesForOrder("missing-order", {
      orders: ordersReturning(null),
      deliveries,
      provider,
    });

    expect(result).toEqual([]);
    expect(polled).toEqual([]);
  });
});
