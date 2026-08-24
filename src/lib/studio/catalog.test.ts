import { describe, expect, it } from "vitest";
import { formatPricedItems, parsePricedItems } from "./catalog";
import {
  customerFacingPaymentMethods,
  PAYMENT_METHODS,
} from "./site-brief/schema";

describe("parsePricedItems", () => {
  it("splits a comma-separated line into priced items", () => {
    const items = parsePricedItems(
      "Jollof Rice - 45, Banku - 30, Chicken - 25",
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ name: "Jollof Rice", price: 45 });
    expect(items[1]).toMatchObject({ name: "Banku", price: 30 });
    expect(items[2]).toMatchObject({ name: "Chicken", price: 25 });
  });

  it("splits on newlines so one item per line works", () => {
    const items = parsePricedItems(
      "Jollof Rice - 45\nBanku - 30\nChicken - 25",
    );
    expect(items.map((item) => item.name)).toEqual([
      "Jollof Rice",
      "Banku",
      "Chicken",
    ]);
    expect(items.map((item) => item.price)).toEqual([45, 30, 25]);
  });

  it("accepts a mix of commas and newlines", () => {
    const items = parsePricedItems(
      "Jollof Rice - 45, Banku - 30\nChicken - 25",
    );
    expect(items).toHaveLength(3);
  });

  it("keeps an unpriced item as info-only", () => {
    const items = parsePricedItems("Today's special");
    expect(items[0]?.name).toBe("Today's special");
    expect(items[0]?.price).toBeUndefined();
  });

  it("reuses ids and images when the name is unchanged", () => {
    const existing = [
      {
        id: "keep-me",
        name: "Jollof Rice",
        price: 40,
        image: "data:image/png;base64,abc",
      },
    ];
    const items = parsePricedItems("Jollof Rice - 45", existing);
    expect(items[0]?.id).toBe("keep-me");
    expect(items[0]?.price).toBe(45);
    expect(items[0]?.image).toBe("data:image/png;base64,abc");
  });
});

describe("customerFacingPaymentMethods", () => {
  it("hides manual rails when Valmont Pay is on", () => {
    expect(
      customerFacingPaymentMethods([
        "valmont_pay",
        "momo",
        "card",
        "bank",
        "cod",
      ]),
    ).toEqual(["valmont_pay", "cod"]);
  });

  it("labels the online checkout for Ghanaian customers", () => {
    expect(
      PAYMENT_METHODS.find((method) => method.id === "valmont_pay")?.label,
    ).toBe("Mobile Money, Card and Bank transfer");
  });
});

describe("formatPricedItems", () => {
  it("writes one item per line", () => {
    expect(
      formatPricedItems([
        { id: "a", name: "Jollof Rice", price: 45 },
        { id: "b", name: "Water" },
      ]),
    ).toBe("Jollof Rice - 45\nWater");
  });
});
