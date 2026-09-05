/**
 * Stage 6a — the commercial package model.
 *
 * Everything the package gate relies on is under test here: the id list, the
 * agency price-sheet labels, the feature matrix `planAllows` encodes, the
 * defensive `planOf` reader for briefs saved before packages existed, and the
 * exact wording of a packaged refusal. The Brief schema's `plan` field is
 * tested too: absent ⇒ `auto_dispatch` (the default that keeps every existing
 * website on its exact current behaviour), unknown values rejected.
 */
import { describe, expect, it } from "vitest";
import {
  PACKAGE_NOT_INCLUDED_MESSAGE,
  PLAN_FEATURES,
  PLAN_IDS,
  PLAN_LABELS,
  PLAN_PRICE_LABELS,
  isPlanId,
  planAllows,
  planOf,
  type PlanFeature,
} from "./plans";
import { createDefaultBrief } from "./site-brief/defaults";
import { siteBriefSchemaV1 } from "./site-brief/schema";
import { starterBundleCatalogue } from "./bundles";

describe("plan registry", () => {
  it("lists the three sellable packages, cheapest first", () => {
    expect([...PLAN_IDS]).toEqual([
      "starter",
      "auto_dispatch",
      "command_center",
    ]);
  });

  it("labels every package exactly as the agency price sheet does", () => {
    expect(PLAN_LABELS.starter).toBe("Starter Shop");
    expect(PLAN_LABELS.auto_dispatch).toBe("Auto-Dispatch Pro");
    expect(PLAN_LABELS.command_center).toBe("Command Center");
    expect(PLAN_PRICE_LABELS.starter).toBe("GH₵ 3,500 one-time");
    expect(PLAN_PRICE_LABELS.auto_dispatch).toBe("GH₵ 6,500 one-time");
    expect(PLAN_PRICE_LABELS.command_center).toBe("GH₵ 10,000 one-time");
  });

  it("recognises its own ids and nothing else", () => {
    for (const id of PLAN_IDS) expect(isPlanId(id)).toBe(true);
    expect(isPlanId("pro")).toBe(false);
    expect(isPlanId("")).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isPlanId(7)).toBe(false);
  });
});

describe("planAllows — the feature matrix", () => {
  const expected: Record<
    (typeof PLAN_IDS)[number],
    Record<PlanFeature, boolean>
  > = {
    starter: {
      auto_dispatch: false,
      bundle_pause: false,
      supplier_page: false,
      second_supplier: false,
      reports: false,
      wallets: false,
    },
    auto_dispatch: {
      auto_dispatch: true,
      bundle_pause: true,
      supplier_page: true,
      second_supplier: false,
      reports: false,
      wallets: false,
    },
    command_center: {
      auto_dispatch: true,
      bundle_pause: true,
      supplier_page: true,
      second_supplier: true,
      reports: true,
      wallets: true,
    },
  };

  it("answers every plan × feature pair exactly as the price sheet says", () => {
    for (const plan of PLAN_IDS) {
      for (const feature of PLAN_FEATURES) {
        expect(planAllows(plan, feature)).toBe(expected[plan][feature]);
      }
    }
  });

  it("keeps the refusal wording exact — routes answer 403 with it", () => {
    expect(PACKAGE_NOT_INCLUDED_MESSAGE).toBe("Not included in your package.");
  });
});

describe("planOf — reading the plan defensively", () => {
  it("returns a stored plan", () => {
    expect(planOf({ plan: "starter" })).toBe("starter");
    expect(planOf({ plan: "command_center" })).toBe("command_center");
  });

  it("treats a missing plan as Auto-Dispatch Pro (the pre-package default)", () => {
    expect(planOf({})).toBe("auto_dispatch");
    expect(planOf(null)).toBe("auto_dispatch");
    expect(planOf(undefined)).toBe("auto_dispatch");
  });

  it("treats an unknown value as Auto-Dispatch Pro rather than throwing", () => {
    expect(planOf({ plan: "deluxe" })).toBe("auto_dispatch");
    expect(planOf({ plan: "" })).toBe("auto_dispatch");
  });
});

describe("site brief schema — the plan field", () => {
  it("defaults to auto_dispatch when the brief carries no plan", () => {
    const parsed = siteBriefSchemaV1.parse(createDefaultBrief());
    expect(parsed.plan).toBe("auto_dispatch");
  });

  it("keeps an explicit plan", () => {
    const parsed = siteBriefSchemaV1.parse(
      createDefaultBrief({ plan: "starter" }),
    );
    expect(parsed.plan).toBe("starter");
  });

  it("rejects a value outside the three packages", () => {
    const result = siteBriefSchemaV1.safeParse(
      createDefaultBrief({ plan: "enterprise" as never }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a plan on a non-bundle brief too — the plan is simply ignored by every behaviour", () => {
    const parsed = siteBriefSchemaV1.parse(
      createDefaultBrief({ category: "restaurant", plan: "command_center" }),
    );
    expect(parsed.plan).toBe("command_center");
    expect(parsed.category).toBe("restaurant");
  });

  it("keeps a complete bundle brief valid (regression: the field is additive)", () => {
    const parsed = siteBriefSchemaV1.parse(
      createDefaultBrief({
        businessName: "Adom Data Hub",
        category: "data-bundles",
        items: starterBundleCatalogue(),
      }),
    );
    expect(parsed.category).toBe("data-bundles");
    expect(parsed.plan).toBe("auto_dispatch");
  });
});
