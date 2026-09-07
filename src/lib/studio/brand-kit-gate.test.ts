/**
 * Stage B — the Brand Kit package gate.
 *
 * The plans.test.ts feature-matrix table gained its one `brand_kit` row (the
 * single allowed edit to an existing test); every other Stage B assertion
 * lives here instead: the feature id, the matrix cells, the agency price
 * label, the add-on field on the brief schema, and the pure `brandKitAllowed`
 * decision — "is this brief allowed the Brand Kit at all?" The HTTP side of
 * the gate (403 / 404 / 429 / 503) is covered by the route suite beside the
 * routes themselves.
 */
import { describe, expect, it } from "vitest";
import {
  BRAND_KIT_ADDON_PRICE_LABEL,
  PACKAGE_NOT_INCLUDED_MESSAGE,
  PLAN_FEATURES,
  planAllows,
  brandKitAllowed,
} from "./plans";
import { createDefaultBrief } from "./site-brief/defaults";
import { siteBriefSchemaV1 } from "./site-brief/schema";

describe("Brand Kit — the package feature", () => {
  it("registers brand_kit exactly once, keeping the Stage 6 features intact", () => {
    expect(PLAN_FEATURES.filter((f) => f === "brand_kit")).toHaveLength(1);
    for (const existing of [
      "auto_dispatch",
      "bundle_pause",
      "supplier_page",
      "second_supplier",
      "reports",
      "wallets",
    ]) {
      expect(PLAN_FEATURES).toContain(existing);
    }
  });

  it("is included only in Command Center", () => {
    expect(planAllows("starter", "brand_kit")).toBe(false);
    expect(planAllows("auto_dispatch", "brand_kit")).toBe(false);
    expect(planAllows("command_center", "brand_kit")).toBe(true);
  });

  it("labels the add-on exactly as the agency price sheet does", () => {
    expect(BRAND_KIT_ADDON_PRICE_LABEL).toBe("GH₵ 600 one-time add-on");
  });

  it("keeps the shared refusal wording for a packaged refusal", () => {
    expect(PACKAGE_NOT_INCLUDED_MESSAGE).toBe("Not included in your package.");
  });
});

describe("Brand Kit — the brandKitAddon brief field", () => {
  it("defaults to false so pre-Stage-B briefs stay gated", () => {
    const parsed = siteBriefSchemaV1.parse(createDefaultBrief());
    expect(parsed.brandKitAddon).toBe(false);
  });

  it("keeps an explicit add-on tick", () => {
    const parsed = siteBriefSchemaV1.parse(
      createDefaultBrief({ brandKitAddon: true }),
    );
    expect(parsed.brandKitAddon).toBe(true);
  });
});

describe("brandKitAllowed — the pure decision", () => {
  it("allows every website type except data-bundles, always", () => {
    expect(brandKitAllowed({ category: "restaurant", plan: "starter" })).toBe(
      true,
    );
    expect(
      brandKitAllowed({ category: "business-profile", plan: "starter" }),
    ).toBe(true);
    expect(brandKitAllowed({ category: "church" })).toBe(true);
    // Even a nonsense plan never gates a non-bundles website.
    expect(brandKitAllowed({ category: "restaurant", plan: "deluxe" })).toBe(
      true,
    );
  });

  it("allows nothing and everything gracefully for a missing brief", () => {
    expect(brandKitAllowed(null)).toBe(true);
    expect(brandKitAllowed(undefined)).toBe(true);
  });

  it("refuses a Starter bundle shop without the add-on", () => {
    expect(brandKitAllowed({ category: "data-bundles", plan: "starter" })).toBe(
      false,
    );
  });

  it("refuses an Auto-Dispatch Pro bundle shop without the add-on", () => {
    expect(
      brandKitAllowed({ category: "data-bundles", plan: "auto_dispatch" }),
    ).toBe(false);
  });

  it("allows a bundle shop of any cheaper package once the add-on is ticked", () => {
    expect(
      brandKitAllowed({
        category: "data-bundles",
        plan: "starter",
        brandKitAddon: true,
      }),
    ).toBe(true);
    expect(
      brandKitAllowed({
        category: "data-bundles",
        plan: "auto_dispatch",
        brandKitAddon: true,
      }),
    ).toBe(true);
  });

  it("allows a Command Center bundle shop with no add-on at all", () => {
    expect(
      brandKitAllowed({ category: "data-bundles", plan: "command_center" }),
    ).toBe(true);
  });

  it("reads a missing plan defensively: Auto-Dispatch Pro, add-on still wins", () => {
    expect(brandKitAllowed({ category: "data-bundles" })).toBe(false);
    expect(
      brandKitAllowed({ category: "data-bundles", brandKitAddon: true }),
    ).toBe(true);
  });
});
