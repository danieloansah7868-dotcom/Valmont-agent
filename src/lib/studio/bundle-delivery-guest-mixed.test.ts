/**
 * Stage 6c — the guest line for a MIXED manual order (3e).
 *
 * A Starter Shop's order that is partly delivered, with nothing failed and a
 * manual row still pending, gets its own aggregate: "1 of 2 top-ups
 * delivered to 024 ••• 0001; the shop will send the rest by hand." The
 * branch sits before the all-pending manual branch, so every sentence that
 * existed before Stage 6c stays byte-identical — asserted here against the
 * same inputs the 6a tests use.
 */
import { describe, expect, it } from "vitest";
import {
  guestBundleDeliverySummary,
  MANUAL_PROVIDER_ID,
} from "./bundle-delivery";

const RECIPIENT = "0240000001";

describe("guestBundleDeliverySummary — mixed manual order", () => {
  it("some delivered, none failed, a manual row pending: the rest-by-hand line", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 2048 },
      ],
      RECIPIENT,
    );

    expect(summary?.line).toBe(
      "1 of 2 top-ups delivered to 024 ••• 0001; the shop will send the rest by hand.",
    );
    // Guest privacy holds: no full number on the line.
    expect(summary?.line).not.toContain(RECIPIENT);
    expect(summary?.deliveredTopUps).toBe(1);
    expect(summary?.failedTopUps).toBe(0);
  });

  it("the numbers and the masked number are computed, not fixed", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 512 },
      ],
      "0201234567",
    );

    expect(summary?.line).toBe(
      "2 of 4 top-ups delivered to 020 ••• 4567; the shop will send the rest by hand.",
    );
  });

  it("a failed row keeps the pre-6c retry wording, not the rest-by-hand line", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "failed", dataMb: 1024 },
      ],
      RECIPIENT,
    );

    expect(summary?.line).toContain("hit a problem");
    expect(summary?.line).not.toContain("by hand");
  });

  it("an all-pending manual order keeps the exact 6a sentence", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "pending", dataMb: 2048 },
      ],
      RECIPIENT,
    );

    expect(summary?.line).toBe(
      "The shop will send your bundles to 024 ••• 0001 by hand. Contact the shop if it does not arrive.",
    );
  });

  it("an all-delivered manual order keeps the exact delivered sentence", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 1024 },
        { provider: MANUAL_PROVIDER_ID, status: "delivered", dataMb: 2048 },
      ],
      RECIPIENT,
    );

    expect(summary?.line).toBe("All 2 top-ups (3GB) delivered to 024 ••• 0001");
  });

  it("an automatic partly delivered order keeps the Sending line", () => {
    const summary = guestBundleDeliverySummary(
      [
        { provider: "simulator", status: "delivered", dataMb: 1024 },
        { provider: "simulator", status: "pending", dataMb: 2048 },
      ],
      RECIPIENT,
    );

    expect(summary?.line).toBe(
      "Sending 3GB of data to 024 ••• 0001 — 1 of 2 delivered so far.",
    );
    expect(summary?.line).not.toContain("by hand");
  });
});
