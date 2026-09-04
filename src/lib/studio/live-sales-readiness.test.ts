/**
 * Stage 5 — readiness v2's `bundleDelivery` dependency.
 *
 * The Brief's completeness score answers "is this website finished?". These
 * rules answer a different question the owner actually has to act on: "may
 * this website take real money?". For a data-bundles shop the answer is no
 * until its own TechChief connection is verified, because a paid top-up that
 * nothing can send is a customer who paid for nothing.
 */
import { describe, expect, it } from "vitest";
import {
  bundleDeliveryDependency,
  computeLiveSalesReadiness,
  READINESS_DEPENDENCY_IDS,
  type ReadinessDependency,
} from "./site-brief/readiness";

function payments(satisfied: boolean): ReadinessDependency {
  return {
    id: "payments",
    label: "Online payments",
    applies: true,
    satisfied,
    hint: satisfied
      ? "Valmont Pay is live."
      : "Switch on live payments in Studio → Settings → Payments.",
  };
}

describe("readiness v2 — the bundleDelivery dependency", () => {
  it("is satisfied only by a verified connection", () => {
    expect(
      bundleDeliveryDependency(true, { status: "verified" }).satisfied,
    ).toBe(true);
    for (const status of ["unverified", "error", null]) {
      expect(bundleDeliveryDependency(true, { status }).satisfied).toBe(false);
    }
    expect(bundleDeliveryDependency(true, null).satisfied).toBe(false);
  });

  it("only applies to a data-bundles website", () => {
    expect(bundleDeliveryDependency(false, null).applies).toBe(false);
    expect(bundleDeliveryDependency(true, null).applies).toBe(true);
  });

  it("tells the owner what to do, in everyday words", () => {
    const missing = bundleDeliveryDependency(true, null);
    expect(missing.hint).toContain("TechChief API key");
    expect(missing.label).toBe("Bundle delivery");
    expect(
      bundleDeliveryDependency(true, { status: "verified" }).hint,
    ).toContain("connected");
  });

  it("exposes a stable dependency id the UI and docs can rely on", () => {
    expect(READINESS_DEPENDENCY_IDS).toContain("bundleDelivery");
    expect(bundleDeliveryDependency(true, null).id).toBe("bundleDelivery");
  });
});

describe("readiness v2 — ready for live sales", () => {
  it("a bundle shop is not ready for live sales until delivery is verified", () => {
    const notReady = computeLiveSalesReadiness([
      payments(true),
      bundleDeliveryDependency(true, null),
    ]);
    expect(notReady.readyForLiveSales).toBe(false);
    expect(notReady.blockers.map((blocker) => blocker.id)).toEqual([
      "bundleDelivery",
    ]);

    const ready = computeLiveSalesReadiness([
      payments(true),
      bundleDeliveryDependency(true, { status: "verified" }),
    ]);
    expect(ready.readyForLiveSales).toBe(true);
    expect(ready.blockers).toEqual([]);
  });

  it("a dependency that does not apply never blocks", () => {
    // A food shop with no bundle delivery connection is still ready to sell.
    const foodShop = computeLiveSalesReadiness([
      payments(true),
      bundleDeliveryDependency(false, null),
    ]);
    expect(foodShop.readyForLiveSales).toBe(true);
    expect(foodShop.dependencies).toHaveLength(2);
  });

  it("payments and delivery are both required for a live bundle shop", () => {
    const readiness = computeLiveSalesReadiness([
      payments(false),
      bundleDeliveryDependency(true, { status: "verified" }),
    ]);
    expect(readiness.readyForLiveSales).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.id)).toEqual([
      "payments",
    ]);
  });
});
