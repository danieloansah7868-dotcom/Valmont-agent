import { describe, expect, it } from "vitest";
import { orderAlertText } from "./notifications";
import type { OrderRecord } from "./orders";

const order: OrderRecord = {
  id: "83b1bfd7-0000-4000-8000-000000000001",
  ownerId: "owner",
  draftId: "draft",
  accessCode: "abc",
  status: "paid",
  currency: "GHS",
  subtotal: 70,
  deliveryFee: 15,
  total: 85,
  lines: [
    { itemId: "a", name: "Jollof Rice", price: 45, quantity: 1 },
    { itemId: "b", name: "Chicken", price: 25, quantity: 1 },
  ],
  customerName: "Ama",
  customerPhone: "+233240000000",
  customerAddress: "12 Independence Avenue Accra",
  paymentMethod: "valmont_pay",
  paymentMode: "live",
  createdAt: "2026-08-23T18:02:09.000Z",
  updatedAt: "2026-08-23T18:02:09.000Z",
  statusHistory: [{ status: "paid", at: "2026-08-23T18:02:09.000Z" }],
};

describe("orderAlertText", () => {
  it("summarises the order in plain language", () => {
    const text = orderAlertText(
      order,
      { businessName: "Akwaaba Bites" },
      "https://example.com/studio/orders/1",
    );
    expect(text).toContain("New order at Akwaaba Bites");
    expect(text).toContain("83b1bfd7");
    expect(text).toContain("GH₵85.00");
    expect(text).toContain("Jollof Rice × 1");
    expect(text).toContain("View: https://example.com/studio/orders/1");
  });
});
