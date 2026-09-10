/**
 * Stage 7b — the merchant "new order" alert names the wallet rail exactly
 * once, and only for agent wallet orders.
 *
 * Both the text and the HTML version add one line ("Paid from agent
 * wallet") when — and only when — the order's paymentMethod is the shared
 * AGENT_WALLET_PAYMENT_METHOD constant. The comparison reads that constant
 * (never a second hardcoded copy of the string), so an order stamped by the
 * buy route is always recognised: a drifted recogniser would leave the
 * merchant wondering why no payment link exists. Every other method keeps
 * the byte-for-byte Stage 1 rendering pinned by notifications.test.ts.
 */
import { describe, expect, it } from "vitest";
import { orderAlertHtml, orderAlertText } from "./notifications";
import { AGENT_WALLET_PAYMENT_METHOD, type OrderRecord } from "./orders";

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "83b1bfd7-0000-4000-8000-000000000001",
    ownerId: "owner",
    draftId: "draft",
    accessCode: "abc",
    status: "paid",
    currency: "GHS",
    subtotal: 70,
    deliveryFee: 0,
    total: 70,
    lines: [{ itemId: "a", name: "MTN 1GB", price: 70, quantity: 1 }],
    customerName: "Agent One",
    customerPhone: "0240000009",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "test",
    createdAt: "2026-09-10T08:02:09.000Z",
    updatedAt: "2026-09-10T08:02:09.000Z",
    statusHistory: [{ status: "paid", at: "2026-09-10T08:02:09.000Z" }],
    ...overrides,
  };
}

const brief = { businessName: "Data GH" };
const viewUrl = "https://example.com/studio/orders/1";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("orderAlertText — the agent wallet line", () => {
  it("appears exactly once for a wallet-paid agent order", () => {
    const text = orderAlertText(
      order({ paymentMethod: AGENT_WALLET_PAYMENT_METHOD, agentId: "agent-1" }),
      brief,
      viewUrl,
    );
    expect(occurrences(text, "Paid from agent wallet")).toBe(1);
    // The rest of the alert is untouched: same framing, same figures.
    expect(text).toContain("New order at Data GH");
    expect(text).toContain("83b1bfd7");
    expect(text).toContain("GH₵70.00");
    expect(text).toContain("Send to: 0240000001");
  });

  it("never appears for a public payment rail", () => {
    for (const method of [
      "valmont_pay",
      "momo",
      "card",
      "bank",
      "cod",
      "made_up_method",
    ]) {
      const text = orderAlertText(
        order({ paymentMethod: method }),
        brief,
        viewUrl,
      );
      expect(occurrences(text, "Paid from agent wallet")).toBe(0);
    }
  });
});

describe("orderAlertHtml — the agent wallet line", () => {
  it("appears exactly once for a wallet-paid agent order", () => {
    const html = orderAlertHtml(
      order({ paymentMethod: AGENT_WALLET_PAYMENT_METHOD, agentId: "agent-1" }),
      brief,
      viewUrl,
    );
    expect(occurrences(html, "<p>Paid from agent wallet</p>")).toBe(1);
    expect(html).toContain("New order — Data GH");
  });

  it("never appears for a public payment rail", () => {
    for (const method of ["valmont_pay", "momo", "card", "bank", "cod"]) {
      const html = orderAlertHtml(
        order({ paymentMethod: method }),
        brief,
        viewUrl,
      );
      expect(occurrences(html, "Paid from agent wallet")).toBe(0);
    }
  });
});
