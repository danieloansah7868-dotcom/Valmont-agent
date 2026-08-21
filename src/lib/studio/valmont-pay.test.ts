import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeTotals,
  formatMoney,
  isLiveConfigured,
  paymentUrlFor,
  STATUS_LABELS,
} from "./valmont-pay";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("computeTotals", () => {
  it("sums line prices times quantity with no delivery", () => {
    const totals = computeTotals(
      [
        { price: 45, quantity: 2 },
        { price: 30, quantity: 1 },
      ],
      { enabled: false, fee: 15, minimumOrder: 0 },
    );
    expect(totals.subtotal).toBe(120);
    expect(totals.deliveryFee).toBe(0);
    expect(totals.total).toBe(120);
  });

  it("adds a delivery fee when delivery is enabled", () => {
    const totals = computeTotals([{ price: 20, quantity: 1 }], {
      enabled: true,
      fee: 15,
      minimumOrder: 0,
    });
    expect(totals.deliveryFee).toBe(15);
    expect(totals.total).toBe(35);
  });

  it("waives delivery above the free-delivery threshold", () => {
    const totals = computeTotals([{ price: 100, quantity: 2 }], {
      enabled: true,
      fee: 15,
      minimumOrder: 0,
      freeDeliveryAbove: 150,
    });
    expect(totals.subtotal).toBe(200);
    expect(totals.deliveryFee).toBe(0);
    expect(totals.total).toBe(200);
  });

  it("uses integer minor units so decimals do not drift", () => {
    const totals = computeTotals(
      [
        { price: 0.1, quantity: 3 },
        { price: 0.2, quantity: 1 },
      ],
      { enabled: false, fee: 0, minimumOrder: 0 },
    );
    // 0.1*3 + 0.2 would be 0.5 but naive float maths gives 0.5000000000000001.
    expect(totals.total).toBe(0.5);
  });

  it("ignores negative or fractional quantities safely", () => {
    const totals = computeTotals(
      [
        { price: 10, quantity: -2 },
        { price: 10, quantity: 2.9 },
      ],
      { enabled: false, fee: 0, minimumOrder: 0 },
    );
    expect(totals.subtotal).toBe(20);
  });
});

describe("formatMoney", () => {
  it("formats GHS with the cedi symbol and two decimals", () => {
    expect(formatMoney(45, "GHS")).toBe("GH₵45.00");
  });

  it("falls back to the currency code for unknown currencies", () => {
    expect(formatMoney(10, "XOF")).toBe("XOF 10.00");
  });
});

describe("isLiveConfigured / paymentUrlFor", () => {
  it("is test mode when the env vars are missing", () => {
    vi.stubEnv("VALMONT_PAY_API_URL", "");
    vi.stubEnv("VALMONT_PAY_API_KEY", "");
    expect(isLiveConfigured()).toBe(false);
    expect(paymentUrlFor("abc123")).toBe("/pay/abc123");
  });

  it("is live only when both env vars are set", () => {
    vi.stubEnv("VALMONT_PAY_API_URL", "https://pay.example.com");
    vi.stubEnv("VALMONT_PAY_API_KEY", "secret");
    expect(isLiveConfigured()).toBe(true);
    expect(paymentUrlFor("abc123")).toContain("access_code=abc123");
  });
});

describe("STATUS_LABELS", () => {
  it("has a plain-language label for every status", () => {
    expect(STATUS_LABELS.pending).toBe("Awaiting payment");
    expect(STATUS_LABELS.paid).toBe("Paid");
    expect(STATUS_LABELS.cod_pending).toBe("Cash on delivery");
  });
});
