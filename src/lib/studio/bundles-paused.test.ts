/**
 * Stage 6c — `paused` on a catalogue item.
 *
 * Two rules under test:
 *
 *  - the schema keeps an OMITTED `paused` key distinguishable from `false`
 *    (no default), which is what lets the wizard save path tell "the agency
 *    said nothing" apart from "the agency said resume";
 *  - the public bundle list builder never lists a paused item, so the
 *    storefront plus button cannot add it (checkout refuses it server-side
 *    with 400 — proved in the checkout route suite).
 */
import { describe, expect, it } from "vitest";
import { catalogItemSchema } from "./site-brief/schema";
import { groupBundlesByNetwork } from "./bundles";
import type { CatalogItem } from "./site-brief/schema";

function bundleItem(
  id: string,
  overrides: Partial<CatalogItem> = {},
): CatalogItem {
  return {
    id,
    name: `MTN ${id}`,
    price: 10,
    bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
    ...overrides,
  };
}

describe("catalogItemSchema — paused (Stage 6c)", () => {
  it("accepts paused true and false, and keeps an omitted key undefined", () => {
    expect(
      catalogItemSchema.parse(bundleItem("a", { paused: true })).paused,
    ).toBe(true);
    expect(
      catalogItemSchema.parse(bundleItem("a", { paused: false })).paused,
    ).toBe(false);
    // No default: an omitted key is undefined, NOT false.
    expect(catalogItemSchema.parse(bundleItem("a")).paused).toBeUndefined();
  });

  it("rejects a non-boolean paused value", () => {
    expect(() =>
      catalogItemSchema.parse(
        bundleItem("a", { paused: "yes" as unknown as boolean }),
      ),
    ).toThrow();
  });

  it("a paused item round-trips through the schema untouched", () => {
    const parsed = catalogItemSchema.parse(
      bundleItem("a", { paused: true, price: 12.5 }),
    );
    expect(parsed).toMatchObject({
      id: "a",
      price: 12.5,
      paused: true,
    });
  });
});

describe("groupBundlesByNetwork — a paused bundle is never listed (Stage 6c)", () => {
  it("excludes paused items and keeps the rest in place", () => {
    const grouped = groupBundlesByNetwork([
      bundleItem("live-1"),
      bundleItem("paused-1", { paused: true }),
      bundleItem("live-2", {
        price: 15,
        bundle: { network: "mtn", dataMb: 2048, validity: "30 days" },
      }),
      bundleItem("telecel-1", {
        price: 9,
        bundle: { network: "telecel", dataMb: 1024, validity: "7 days" },
      }),
    ]);

    expect(grouped.mtn.map((item) => item.id)).toEqual(["live-1", "live-2"]);
    expect(grouped.telecel.map((item) => item.id)).toEqual(["telecel-1"]);
    expect(grouped.airteltigo).toEqual([]);
  });

  it("paused false means not paused — the item is listed", () => {
    const grouped = groupBundlesByNetwork([
      bundleItem("resumed", { paused: false }),
    ]);
    expect(grouped.mtn.map((item) => item.id)).toEqual(["resumed"]);
  });

  it("a catalogue with every bundle paused produces empty lists everywhere", () => {
    const grouped = groupBundlesByNetwork([
      bundleItem("a", { paused: true }),
      bundleItem("b", {
        paused: true,
        bundle: { network: "telecel", dataMb: 1024, validity: "7 days" },
      }),
    ]);
    expect(grouped.mtn).toEqual([]);
    expect(grouped.telecel).toEqual([]);
    expect(grouped.airteltigo).toEqual([]);
  });
});
