/**
 * Stage 4b — the bundle basket caps.
 *
 * One function counts, in one place, so the storefront and the checkout route
 * cannot drift apart about what "too many" means. These are the arithmetic
 * cases; the route-level 400 and the storefront's disabled button are covered
 * beside the code that renders them.
 */
import { describe, expect, it } from "vitest";
import {
  BUNDLE_ORDER_CAP_MESSAGE,
  bundleOrderCapError,
  MAX_BUNDLE_UNITS_PER_LINE,
  MAX_BUNDLE_UNITS_PER_ORDER,
} from "./bundles";

function basket(...quantities: number[]) {
  return quantities.map((quantity) => ({ quantity }));
}

describe("bundle order caps", () => {
  it("publishes the two limits the owner was promised", () => {
    expect(MAX_BUNDLE_UNITS_PER_LINE).toBe(10);
    expect(MAX_BUNDLE_UNITS_PER_ORDER).toBe(20);
  });

  it("quotes the real numbers in the sentence the customer is shown", () => {
    // Built from the constants on purpose: if either limit ever changes, the
    // wording changes with it instead of lying.
    expect(BUNDLE_ORDER_CAP_MESSAGE).toBe(
      "You can order up to 10 of one bundle and 20 bundles per order.",
    );
    expect(BUNDLE_ORDER_CAP_MESSAGE).toContain(
      String(MAX_BUNDLE_UNITS_PER_LINE),
    );
    expect(BUNDLE_ORDER_CAP_MESSAGE).toContain(
      String(MAX_BUNDLE_UNITS_PER_ORDER),
    );
  });

  it("accepts an empty basket and a single unit", () => {
    expect(bundleOrderCapError([])).toBeNull();
    expect(bundleOrderCapError(basket(1))).toBeNull();
  });

  it("accepts exactly the per-line cap", () => {
    expect(bundleOrderCapError(basket(MAX_BUNDLE_UNITS_PER_LINE))).toBeNull();
  });

  it("refuses one unit above the per-line cap", () => {
    expect(bundleOrderCapError(basket(MAX_BUNDLE_UNITS_PER_LINE + 1))).toBe(
      BUNDLE_ORDER_CAP_MESSAGE,
    );
  });

  it("refuses a huge single line rather than counting it out", () => {
    expect(bundleOrderCapError(basket(999))).toBe(BUNDLE_ORDER_CAP_MESSAGE);
  });

  it("accepts exactly the per-order cap spread over several lines", () => {
    expect(bundleOrderCapError(basket(10, 10))).toBeNull();
    expect(bundleOrderCapError(basket(7, 7, 6))).toBeNull();
    expect(bundleOrderCapError(basket(4, 4, 4, 4, 4))).toBeNull();
  });

  it("refuses one unit above the per-order cap even when every line is small", () => {
    // No single line is over its own limit — only the total is.
    expect(bundleOrderCapError(basket(7, 7, 7))).toBe(BUNDLE_ORDER_CAP_MESSAGE);
    expect(bundleOrderCapError(basket(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 11))).toBe(
      BUNDLE_ORDER_CAP_MESSAGE,
    );
  });

  it("reports the per-line breach first, whatever the order of the lines", () => {
    expect(bundleOrderCapError(basket(3, 4, 11, 5))).toBe(
      BUNDLE_ORDER_CAP_MESSAGE,
    );
  });

  it("ignores lines that are not in the basket", () => {
    // A quantity of 0 is a line the customer removed; the checkout schema
    // rejects anything below 1 before this is ever reached.
    expect(bundleOrderCapError(basket(0, 10, 10))).toBeNull();
    expect(bundleOrderCapError(basket(0, 0, 0))).toBeNull();
  });

  it("survives a quantity that is not a number", () => {
    // The zod schema already refuses these; the counter must not throw on the
    // way past, because a throw here would become an opaque 500.
    expect(
      bundleOrderCapError([
        { quantity: Number.NaN },
        { quantity: 10 },
        { quantity: 10 },
      ]),
    ).toBeNull();
    expect(bundleOrderCapError([{ quantity: Number.NaN }])).toBeNull();
  });
});
