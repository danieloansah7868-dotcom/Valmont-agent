import { describe, expect, it } from "vitest";
import {
  ECOM_SUBCATEGORIES,
  ecomSubcategoryLabel,
  isEcomSubcategoryId,
} from "./categories";

describe("shop subcategories", () => {
  it("covers the owner's full category list for shop websites", () => {
    // Fashion, Gadgets, Beauty, General stores, Food, Furniture, Automotive
    // and Electrical are shop subtypes; Services businesses are covered by
    // the top-level categories (business-profile, consultant, booking).
    for (const id of [
      "fashion",
      "gadgets",
      "beauty",
      "general-store",
      "food",
      "furniture",
      "automotive",
      "electrical",
    ]) {
      expect(isEcomSubcategoryId(id)).toBe(true);
    }
  });

  it("labels the tricky subtypes in plain English", () => {
    expect(ecomSubcategoryLabel("general-store")).toBe("General store");
    expect(ecomSubcategoryLabel("single-brand")).toBe("Single brand");
    expect(ecomSubcategoryLabel("multi-category")).toBe("Multi category");
    expect(ecomSubcategoryLabel("bags-shoes")).toBe("Bags & shoes");
    expect(ecomSubcategoryLabel("automotive")).toBe("Automotive");
  });

  it("gives every subcategory a clean, capitalized label", () => {
    for (const id of ECOM_SUBCATEGORIES) {
      const label = ecomSubcategoryLabel(id);
      expect(label.length).toBeGreaterThan(0);
      expect(label[0]).toBe(label[0]!.toUpperCase());
      // No leftover "&" glitches such as "General & store".
      expect(label).not.toMatch(/& (store|brand|category)$/);
    }
  });
});
