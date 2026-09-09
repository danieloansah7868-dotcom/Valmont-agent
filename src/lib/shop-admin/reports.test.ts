/**
 * Stage 6d — every money definition of the Sales & margin report.
 *
 * `aggregateShopReport` is pure, so the exact rules in section 4 of the 6d
 * spec are pinned here one by one: a sale is paid + live + not refunded +
 * not cancelled; test-mode paid orders are counted but never in money;
 * refunded and cancelled orders are excluded everywhere; failed rows never
 * count in revenue or cost; a row's unit price is its order line's snapshot
 * price (0 when the line is missing); margin comes from costed rows only;
 * per-network and per-bundle rows carry the same columns; an empty period is
 * all zeros. The range resolver is tested on UTC boundaries (Ghana is UTC).
 */
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "@/lib/studio/orders";
import type { BundleDeliveryRecord } from "@/lib/studio/bundle-delivery";
import {
  aggregateShopReport,
  resolveShopReportRange,
  type ShopReportDeliveryRow,
} from "./reports";

type RowOverrides = Partial<
  Pick<
    BundleDeliveryRecord,
    "orderId" | "lineIndex" | "itemName" | "network" | "dataMb" | "status"
  > & { apiPrice: number | null }
>;

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "order-1",
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: "acc-1",
    status: "paid",
    currency: "GHS",
    subtotal: 20,
    deliveryFee: 5,
    total: 25,
    lines: [
      {
        itemId: "bundle-00",
        name: "MTN 1GB",
        price: 10,
        quantity: 2,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    customerName: "Ama",
    customerPhone: "0240000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    paidAt: "2026-09-01T10:00:00.000Z",
    statusHistory: [],
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

/** One unit row: orderId set in the first argument, defaults for the rest. */
function row(
  orderId: string,
  overrides: RowOverrides = {},
): ShopReportDeliveryRow {
  return {
    orderId,
    lineIndex: 0,
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    status: "delivered",
    apiPrice: 4.5,
    ...overrides,
  };
}

describe("resolveShopReportRange", () => {
  const NOW = Date.UTC(2026, 8, 9, 14, 30, 0); // 2026-09-09 14:30 UTC

  it("unknown and missing values fall back to the 30-day default", () => {
    expect(resolveShopReportRange("bogus", NOW)).toEqual({
      range: "30d",
      createdAfter: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(resolveShopReportRange(null, NOW)).toEqual({
      range: "30d",
      createdAfter: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(resolveShopReportRange(undefined, NOW)).toEqual({
      range: "30d",
      createdAfter: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("today starts at 00:00 UTC (Ghana local midnight)", () => {
    expect(resolveShopReportRange("today", NOW)).toEqual({
      range: "today",
      createdAfter: "2026-09-09T00:00:00.000Z",
    });
  });

  it("this month starts at the 1st of the month, 00:00 UTC", () => {
    expect(resolveShopReportRange("month", NOW)).toEqual({
      range: "month",
      createdAfter: "2026-09-01T00:00:00.000Z",
    });
  });

  it("7d and 30d are rolling windows", () => {
    expect(resolveShopReportRange("7d", NOW)).toEqual({
      range: "7d",
      createdAfter: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });
});

describe("aggregateShopReport — sales and money", () => {
  it("counts live paid orders as sales and sums their totals", () => {
    const a = order({ id: "o-a", total: 25, paymentMode: "live" });
    const b = order({
      id: "o-b",
      accessCode: "acc-b",
      total: 11.5,
      paymentMode: "live",
      subtotal: 11.5,
      deliveryFee: 0,
    });
    const report = aggregateShopReport([a, b], []);

    expect(report.orders).toBe(2);
    expect(report.moneyCollected).toBe(36.5);
    expect(report.testOrdersExcluded).toBe(0);
    expect(report.deliveredTopUps).toBe(0);
  });

  it("an unpaid order is never a sale even when paymentMode is live", () => {
    const report = aggregateShopReport(
      [order({ id: "o-u", status: "pending", paidAt: undefined, total: 50 })],
      [],
    );
    expect(report.orders).toBe(0);
    expect(report.moneyCollected).toBe(0);
  });

  it("test-mode paid orders are excluded from money and counted", () => {
    const live = order({ id: "o-live", total: 25 });
    const testOrder = order({
      id: "o-test",
      accessCode: "acc-t",
      total: 60,
      subtotal: 60,
      deliveryFee: 0,
      paymentMode: "test",
    });
    // The test order's rows exist but must not count anywhere.
    const report = aggregateShopReport(
      [live, testOrder],
      [row("o-test", { apiPrice: 12 }), row("o-test", { status: "failed" })],
    );

    expect(report.orders).toBe(1);
    expect(report.moneyCollected).toBe(25);
    expect(report.testOrdersExcluded).toBe(1);
    expect(report.deliveredTopUps).toBe(0);
    expect(report.failedTopUps).toBe(0);
    expect(report.supplierCost).toBe(0);
  });

  it("refunded and cancelled orders are excluded everywhere, rows included", () => {
    const refunded = order({
      id: "o-ref",
      status: "refunded",
      total: 40,
      refundedAt: "2026-09-02T00:00:00.000Z",
    });
    const cancelled = order({
      id: "o-can",
      status: "cancelled",
      total: 40,
      cancelledAt: "2026-09-02T00:00:00.000Z",
    });
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [refunded, cancelled, live],
      [
        row("o-ref", { apiPrice: 6 }),
        row("o-can", { status: "failed" }),
        row("o-live", { apiPrice: 4.5 }),
      ],
    );

    expect(report.orders).toBe(1);
    expect(report.moneyCollected).toBe(25);
    expect(report.deliveredTopUps).toBe(1);
    expect(report.failedTopUps).toBe(0);
    expect(report.supplierCost).toBe(4.5);
  });
});

describe("aggregateShopReport — top-up counts over the sales' rows", () => {
  it("counts delivered, failed and in-flight (pending or processing) rows", () => {
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [
        row("o-live", { status: "delivered", apiPrice: 4.5 }),
        row("o-live", { status: "delivered", apiPrice: null }),
        row("o-live", { status: "failed", apiPrice: 9 }),
        row("o-live", { status: "pending" }),
        row("o-live", { status: "processing", apiPrice: null }),
      ],
    );

    expect(report.deliveredTopUps).toBe(2);
    expect(report.failedTopUps).toBe(1);
    expect(report.inFlightTopUps).toBe(2);
    // A failed row that carries a price must not cost anything (never clear
    // api_price on failure — the report just ignores it until delivered).
    expect(report.supplierCost).toBe(4.5);
    expect(report.costedTopUps).toBe(1);
    expect(report.costedRevenue).toBe(10);
    expect(report.margin).toBe(5.5);
    expect(report.marginPercent).toBe(55);
  });

  it("ignores rows that do not belong to a sale", () => {
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [row("some-other-order", { apiPrice: 4.5 })],
    );
    expect(report.deliveredTopUps).toBe(0);
    expect(report.supplierCost).toBe(0);
  });
});

describe("aggregateShopReport — cost, margin and coverage", () => {
  it("computes margin only over delivered rows with a finite api_price", () => {
    // One delivered row without a price (sent by hand / test / pre-0016):
    // its revenue is known, its cost is not — it can never create margin.
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [
        row("o-live", { status: "delivered", apiPrice: null }),
        row("o-live", { status: "delivered", apiPrice: 4.5 }),
      ],
    );

    expect(report.deliveredTopUps).toBe(2);
    expect(report.costedTopUps).toBe(1);
    expect(report.costedRevenue).toBe(10); // only the costed row's price
    expect(report.supplierCost).toBe(4.5);
    expect(report.margin).toBe(5.5);
    expect(report.marginPercent).toBe(55);
  });

  it("a delivered row without a price is covered: known of delivered", () => {
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [
        row("o-live", { status: "delivered", apiPrice: 4.5 }),
        row("o-live", { status: "delivered", apiPrice: null }),
        row("o-live", { status: "delivered", apiPrice: null }),
      ],
    );
    expect(report.costedTopUps).toBe(1);
    expect(report.deliveredTopUps).toBe(3);
  });

  it("marginPercent is 0 when costedRevenue is 0", () => {
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [row("o-live", { status: "delivered", apiPrice: null })],
    );
    expect(report.costedRevenue).toBe(0);
    expect(report.supplierCost).toBe(0);
    expect(report.margin).toBe(0);
    expect(report.marginPercent).toBe(0);
  });

  it("a missing order line prices at 0 — cost still counts, revenue does not", () => {
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [row("o-live", { lineIndex: 99, apiPrice: 2 })],
    );
    expect(report.costedTopUps).toBe(1);
    expect(report.costedRevenue).toBe(0);
    expect(report.supplierCost).toBe(2);
    expect(report.margin).toBe(-2);
  });

  it("rounds money to 2 decimals at the end", () => {
    const a = order({ id: "o-a", total: 10.005 });
    const b = order({ id: "o-b", accessCode: "b", total: 10.005 });
    const report = aggregateShopReport([a, b], []);
    expect(report.moneyCollected).toBe(20.01);

    const live = order({ id: "o-live", total: 25 });
    const decimals = aggregateShopReport(
      [live],
      [row("o-live", { apiPrice: 4.565 }), row("o-live", { apiPrice: 4.565 })],
    );
    expect(decimals.supplierCost).toBe(9.13);
  });
});

describe("aggregateShopReport — per network and per bundle", () => {
  function multiLineOrder(id: string): OrderRecord {
    return order({
      id,
      total: 45,
      subtotal: 45,
      deliveryFee: 0,
      lines: [
        {
          itemId: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          quantity: 1,
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
        {
          itemId: "bundle-10",
          name: "Telecel 2GB",
          price: 15,
          quantity: 1,
          bundle: { network: "telecel", dataMb: 2048, validity: "30 days" },
        },
      ],
    });
  }

  it("groups by network with delivered units, revenue, cost, margin, costed units", () => {
    const live = multiLineOrder("o-live");
    const report = aggregateShopReport(
      [live],
      [
        row("o-live", {
          lineIndex: 0,
          itemName: "MTN 1GB",
          network: "mtn",
          dataMb: 1024,
          apiPrice: 4.5,
        }),
        row("o-live", {
          lineIndex: 0,
          itemName: "MTN 1GB",
          network: "mtn",
          dataMb: 1024,
          status: "delivered",
          apiPrice: null,
        }),
        row("o-live", {
          lineIndex: 1,
          itemName: "Telecel 2GB",
          network: "telecel",
          dataMb: 2048,
          status: "delivered",
          apiPrice: 9,
        }),
        row("o-live", {
          lineIndex: 1,
          itemName: "Telecel 2GB",
          network: "telecel",
          dataMb: 2048,
          status: "failed",
          apiPrice: 9,
        }),
      ],
    );

    expect(report.perNetwork).toEqual([
      {
        network: "mtn",
        deliveredUnits: 2,
        revenue: 20,
        cost: 4.5,
        margin: 5.5, // costedRevenue 10 − cost 4.5
        costedUnits: 1,
      },
      {
        network: "telecel",
        deliveredUnits: 1,
        revenue: 15,
        cost: 9,
        margin: 6, // costedRevenue 15 − cost 9
        costedUnits: 1,
      },
    ]);
    expect(report.perBundle).toHaveLength(2);
  });

  it("only networks that delivered appear (mtn → telecel → airteltigo order)", () => {
    const live = order({ id: "o-live", total: 25 });
    const report = aggregateShopReport(
      [live],
      [
        row("o-live", { status: "failed" }), // network appears but never delivered
      ],
    );
    expect(report.failedTopUps).toBe(1);
    expect(report.perNetwork).toEqual([]);
  });

  it("perBundle groups by itemName + network + dataMb and takes the top 10 by delivered units", () => {
    const ordersList: OrderRecord[] = [];
    const rows: ShopReportDeliveryRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `o-${i}`;
      ordersList.push(
        order({
          id,
          accessCode: `acc-${i}`,
          lines: [
            {
              itemId: `b-${i}`,
              name: `Bundle ${i}`,
              price: 10,
              quantity: 1,
              bundle: { network: "mtn", dataMb: 1024 + i, validity: "7 days" },
            },
          ],
          total: 10,
          subtotal: 10,
          deliveryFee: 0,
        }),
      );
      rows.push(
        row(id, { itemName: `Bundle ${i}`, dataMb: 1024 + i, apiPrice: 5 }),
      );
    }
    const report = aggregateShopReport(ordersList, rows);
    expect(report.perBundle).toHaveLength(10);
    // All tied at 1 delivered unit; the ten kept are deterministic.
    expect(report.perBundle[0]?.deliveredUnits).toBe(1);
    const names = report.perBundle.map((group) => group.itemName);
    expect(names).toHaveLength(10);
  });

  it("sorts bundle groups by delivered units, highest first", () => {
    const ordersList: OrderRecord[] = [];
    const rows: ShopReportDeliveryRow[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = `o-${i}`;
      ordersList.push(
        order({
          id,
          accessCode: `acc-${i}`,
          lines: [
            {
              itemId: `b-${i}`,
              name: `Bundle ${i}`,
              price: 10,
              quantity: 3,
              bundle: { network: "mtn", dataMb: 1024 + i, validity: "7 days" },
            },
          ],
          total: 30,
          subtotal: 30,
          deliveryFee: 0,
        }),
      );
      for (let unit = 0; unit <= i; unit += 1) {
        rows.push(
          row(id, {
            lineIndex: 0,
            itemName: `Bundle ${i}`,
            dataMb: 1024 + i,
            apiPrice: 5,
          }),
        );
      }
    }
    const report = aggregateShopReport(ordersList, rows);
    const counts = report.perBundle.map((group) => group.deliveredUnits);
    expect(counts).toEqual([4, 3, 2, 1]);
  });
});

describe("aggregateShopReport — empty period", () => {
  it("is all zeros with no rows", () => {
    const report = aggregateShopReport([], []);
    expect(report).toEqual({
      orders: 0,
      testOrdersExcluded: 0,
      moneyCollected: 0,
      deliveredTopUps: 0,
      failedTopUps: 0,
      inFlightTopUps: 0,
      costedTopUps: 0,
      supplierCost: 0,
      costedRevenue: 0,
      margin: 0,
      marginPercent: 0,
      perNetwork: [],
      perBundle: [],
    });
  });

  it("paid-but-not-sale orders still produce a zero-money report", () => {
    const report = aggregateShopReport(
      [order({ id: "o-t", paymentMode: "test", total: 60 })],
      [row("o-t", { apiPrice: 4.5 })],
    );
    expect(report.orders).toBe(0);
    expect(report.testOrdersExcluded).toBe(1);
    expect(report.moneyCollected).toBe(0);
    expect(report.deliveredTopUps).toBe(0);
    expect(report.supplierCost).toBe(0);
  });
});
