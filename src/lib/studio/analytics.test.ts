import { describe, expect, it } from "vitest";
import type { OrderRecord, OrderStatus } from "./orders";
import {
  accraDateKey,
  analyticsRangeStart,
  filterAnalyticsOrders,
  summariseOrders,
} from "./analytics";

function makeOrder(
  overrides: Partial<OrderRecord> & { id: string; status?: OrderStatus },
): OrderRecord {
  const { id, status, ...rest } = overrides;
  return {
    id,
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: `access-${id}`,
    status: status ?? "paid",
    currency: "GHS",
    subtotal: 10,
    deliveryFee: 0,
    total: 10,
    lines: [
      {
        itemId: "item-1",
        name: "Jollof Rice",
        price: 10,
        quantity: 1,
      },
    ],
    customerName: "Ama",
    customerPhone: "+233240000000",
    paymentMethod: "valmont_pay",
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    statusHistory: [],
    ...rest,
  };
}

describe("analytics date helpers", () => {
  it("formats timestamps in the Accra calendar", () => {
    expect(accraDateKey("2026-08-25T23:30:00.000Z")).toBe("2026-08-25");
  });

  it("uses inclusive Accra calendar days for a range", () => {
    expect(
      analyticsRangeStart("7d", new Date("2026-08-25T12:00:00.000Z")),
    ).toBe("2026-08-19");
  });

  it("returns no lower bound for all-time analytics", () => {
    expect(
      analyticsRangeStart("all", new Date("2026-08-25T12:00:00.000Z")),
    ).toBe(null);
  });
});

describe("filterAnalyticsOrders", () => {
  it("combines the website and date filters", () => {
    const orders = [
      makeOrder({
        id: "inside",
        draftId: "draft-1",
        createdAt: "2026-08-25T10:00:00.000Z",
      }),
      makeOrder({
        id: "wrong-website",
        draftId: "draft-2",
        createdAt: "2026-08-25T10:00:00.000Z",
      }),
      makeOrder({
        id: "too-old",
        draftId: "draft-1",
        createdAt: "2026-08-18T10:00:00.000Z",
      }),
    ];

    expect(
      filterAnalyticsOrders(orders, {
        draftId: "draft-1",
        dateRange: "7d",
        now: new Date("2026-08-25T12:00:00.000Z"),
      }).map((order) => order.id),
    ).toEqual(["inside"]);
  });

  it("keeps all dates when the range is all time", () => {
    const orders = [
      makeOrder({ id: "old", createdAt: "2020-01-01T00:00:00.000Z" }),
      makeOrder({ id: "current" }),
    ];

    expect(filterAnalyticsOrders(orders).map((order) => order.id)).toEqual([
      "old",
      "current",
    ]);
  });
});

describe("summariseOrders", () => {
  it("counts settled sales and subtracts full refunds from net revenue", () => {
    const result = summariseOrders([
      makeOrder({
        id: "paid",
        status: "paid",
        total: 45,
        paymentMethod: "momo",
        lines: [
          {
            itemId: "jollof",
            name: "Jollof Rice",
            price: 45,
            quantity: 1,
          },
        ],
      }),
      makeOrder({
        id: "delivered",
        status: "delivered",
        total: 30,
        paymentMethod: "card",
        lines: [
          {
            itemId: "banku",
            name: "Banku",
            price: 15,
            quantity: 2,
          },
        ],
      }),
      makeOrder({ id: "pending", status: "pending", total: 100 }),
      makeOrder({ id: "cash", status: "cod_pending", total: 55 }),
      makeOrder({ id: "cancelled", status: "cancelled", total: 20 }),
      makeOrder({ id: "failed", status: "payment_failed", total: 80 }),
      makeOrder({ id: "refund", status: "refunded", total: 15 }),
    ]);

    expect(result.paidOrders).toBe(2);
    expect(result.grossRevenue).toBe(90);
    expect(result.refundedOrders).toBe(1);
    expect(result.refundedRevenue).toBe(15);
    expect(result.paidRevenue).toBe(75);
    expect(result.averageOrderValue).toBe(37.5);
    expect(result.topItems).toEqual([
      { name: "Jollof Rice", quantity: 1, revenue: 45 },
      { name: "Banku", quantity: 2, revenue: 30 },
    ]);
    expect(result.paymentMethods).toEqual([
      { method: "momo", orders: 1, revenue: 45 },
      { method: "card", orders: 1, revenue: 30 },
    ]);
  });

  it("groups busiest order hours in Accra time", () => {
    const result = summariseOrders([
      makeOrder({ id: "early", createdAt: "2026-08-25T04:15:00.000Z" }),
      makeOrder({ id: "also-early", createdAt: "2026-08-25T04:45:00.000Z" }),
      makeOrder({ id: "later", createdAt: "2026-08-25T12:00:00.000Z" }),
    ]);

    expect(result.busiestHours).toEqual([
      { hour: 4, orders: 2 },
      { hour: 12, orders: 1 },
    ]);
  });

  it("returns an empty, safe summary when there are no orders", () => {
    expect(summariseOrders([])).toEqual({
      paidOrders: 0,
      paidRevenue: 0,
      grossRevenue: 0,
      refundedRevenue: 0,
      refundedOrders: 0,
      averageOrderValue: 0,
      topItems: [],
      paymentMethods: [],
      busiestHours: [],
    });
  });
});
