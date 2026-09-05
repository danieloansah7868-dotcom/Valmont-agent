/**
 * Stage 6a — readiness v2 meets the commercial packages.
 *
 * A Starter Shop is ready for live sales WITHOUT any TechChief connection,
 * because its delivery mechanism is the owner: the `bundleDelivery`
 * dependency reports satisfied with the manual-delivery hint. Every other
 * package — and every non-bundle website, where the plan is ignored — keeps
 * the Stage 5 behaviour. The seven Stage 5 tests in
 * `live-sales-readiness.test.ts` call the dependency without a plan and stay
 * green unedited beside this file.
 */
import { describe, expect, it } from "vitest";
import {
  bundleDeliveryDependency,
  computeLiveSalesReadiness,
} from "./site-brief/readiness";

function payments(satisfied: boolean) {
  return {
    id: "payments" as const,
    label: "Online payments",
    applies: true,
    satisfied,
    hint: satisfied ? "Valmont Pay is live." : "Switch on live payments.",
  };
}

describe("bundleDeliveryDependency — the Starter exception", () => {
  it("a Starter bundle shop is satisfied with NO connection and says so plainly", () => {
    const dependency = bundleDeliveryDependency(true, null, "starter");

    expect(dependency.applies).toBe(true);
    expect(dependency.satisfied).toBe(true);
    expect(dependency.hint).toBe(
      "Manual delivery (Starter Shop): you send bundles yourself.",
    );
    // Even a saved-but-unverified key changes nothing on Starter.
    expect(
      bundleDeliveryDependency(true, { status: "unverified" }, "starter")
        .satisfied,
    ).toBe(true);
  });

  it("the default (no plan argument) keeps the Stage 5 behaviour", () => {
    expect(bundleDeliveryDependency(true, null).satisfied).toBe(false);
    expect(
      bundleDeliveryDependency(true, { status: "verified" }).satisfied,
    ).toBe(true);
  });

  it("Auto-Dispatch Pro and Command Center still require a verified connection", () => {
    for (const plan of ["auto_dispatch", "command_center"] as const) {
      expect(bundleDeliveryDependency(true, null, plan).satisfied).toBe(false);
      expect(
        bundleDeliveryDependency(true, { status: "verified" }, plan).satisfied,
      ).toBe(true);
    }
  });

  it("a non-bundle website ignores the plan entirely — never applies, never blocks", () => {
    const dependency = bundleDeliveryDependency(false, null, "starter");
    expect(dependency.applies).toBe(false);
    expect(
      computeLiveSalesReadiness([payments(true), dependency]).readyForLiveSales,
    ).toBe(true);
  });
});

describe("computeLiveSalesReadiness — Starter shops", () => {
  it("a Starter shop with payments on is ready for live sales without TechChief", () => {
    const readiness = computeLiveSalesReadiness([
      payments(true),
      bundleDeliveryDependency(true, null, "starter"),
    ]);

    expect(readiness.readyForLiveSales).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  it("payments still block a Starter shop when they are off", () => {
    const readiness = computeLiveSalesReadiness([
      payments(false),
      bundleDeliveryDependency(true, null, "starter"),
    ]);

    expect(readiness.readyForLiveSales).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.id)).toEqual([
      "payments",
    ]);
  });
});
