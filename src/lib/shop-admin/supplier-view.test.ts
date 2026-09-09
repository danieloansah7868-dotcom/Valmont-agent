/**
 * Stage 6d — the Supplier page's projection is the security boundary.
 *
 * The shop admin side must never receive more about the TechChief connection
 * than {@link ShopSupplierView} names: no webhook URL, no indication that a
 * webhook secret is stored, no unmatched-items bookkeeping, no agency owner
 * id, no integration id — and no slice of the API key beyond the stored
 * 9-character prefix. This file pins that contract down.
 */
import { describe, expect, it } from "vitest";
import type { StudioIntegration } from "@/lib/studio/integrations";
import { shopSupplierView, type ShopSupplierView } from "./supplier";

const FULL_KEY = "TCHX-Ab12Cd34Ef56Gh78";

/** A realistic integration row, including every field that must NOT leak. */
function integration(
  overrides: Partial<StudioIntegration> = {},
): StudioIntegration {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    draftId: "aaaaaaaa-1111-4222-8333-444444444444",
    ownerId: "agency-owner-9001",
    provider: "techchief",
    keyPrefix: FULL_KEY.slice(0, 9),
    webhookSecretSet: true,
    status: "verified",
    lastCheckedAt: "2026-09-09T10:30:00.000Z",
    walletBalance: 123.45,
    lowBalance: false,
    accountStatus: "active",
    lastError: undefined,
    bundles: [
      {
        id: 11,
        network: "MTN",
        sizeGb: 1,
        validityDays: 7,
        price: 8.5,
        currency: "GHS",
      },
    ],
    bundlesSyncedAt: "2026-09-09T09:00:00.000Z",
    pollWindowStart: "2026-09-09T10:00:00.000Z",
    pollCount: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-09T10:30:00.000Z",
    ...overrides,
  };
}

const EXPECTED_KEYS: Array<keyof ShopSupplierView> = [
  "connected",
  "status",
  "keyPrefix",
  "walletBalance",
  "lowBalance",
  "accountStatus",
  "lastCheckedAt",
  "lastError",
  "bundleCount",
  "bundlesSyncedAt",
  "requestsThisHour",
  "requestsPerHour",
];

describe("shopSupplierView", () => {
  it("returns exactly the documented key set — nothing more, nothing less", () => {
    const view = shopSupplierView(integration());
    expect(Object.keys(view).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it("projects the values the page renders", () => {
    const view = shopSupplierView(integration());
    expect(view.connected).toBe(true);
    expect(view.status).toBe("verified");
    expect(view.keyPrefix).toBe("TCHX-Ab12");
    expect(view.walletBalance).toBe(123.45);
    expect(view.lowBalance).toBe(false);
    expect(view.accountStatus).toBe("active");
    expect(view.lastCheckedAt).toBe("2026-09-09T10:30:00.000Z");
    expect(view.bundleCount).toBe(1);
    expect(view.bundlesSyncedAt).toBe("2026-09-09T09:00:00.000Z");
    expect(view.requestsThisHour).toBe(3);
    expect(view.requestsPerHour).toBe(60);
  });

  it("null input means connected:false with all-empty fields", () => {
    const view = shopSupplierView(null);
    expect(view).toEqual({
      connected: false,
      status: null,
      keyPrefix: null,
      walletBalance: null,
      lowBalance: false,
      accountStatus: null,
      lastCheckedAt: null,
      lastError: null,
      bundleCount: 0,
      bundlesSyncedAt: null,
      requestsThisHour: 0,
      requestsPerHour: 60,
    });
  });

  it("serialises to JSON that never leaks a secret or an agency identifier", () => {
    const view = shopSupplierView(integration());
    const text = JSON.stringify(view);

    for (const forbidden of [
      "webhookUrl",
      "webhookSecret",
      "webhook_secret",
      "unmatchedItems",
      "ownerId",
      "owner_id",
      "draftId",
      '"id"',
      "apiKey",
      "api_key",
      // The full key and any slice beyond the 9-character prefix.
      FULL_KEY,
      FULL_KEY.slice(0, 10),
      FULL_KEY.slice(0, 12),
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // The stored prefix itself IS shown — that is the whole point.
    expect(text).toContain("TCHX-Ab12");
    // Long strings are fine when they are not key material: timestamps and
    // error sentences are part of the view. What must never appear is any
    // TCHX-shaped string longer than the stored 9-character prefix.
    const longStrings = Object.values(view).filter(
      (value): value is string =>
        typeof value === "string" &&
        value.length > 9 &&
        value.startsWith("TCHX-"),
    );
    expect(longStrings).toEqual([]);
  });

  it("shows only the stored prefix of key material even when other text is long", () => {
    const view = shopSupplierView(
      integration({ lastError: "something went wrong, ask your agency" }),
    );
    const text = JSON.stringify(view);
    expect(text).toContain("something went wrong, ask your agency");
    // The source integration never holds more than the stored 9 characters
    // (the store writes `techChiefKeyPrefix`); the projection cannot invent
    // the rest of the key out of thin air, so no longer TCHX material exists.
    expect(text).toContain("TCHX-Ab12");
    expect(text).not.toContain(FULL_KEY.slice(9));
    expect(text).not.toContain("Cd34Ef56Gh78");
  });

  it("carries the low-balance and error flags through for the banners", () => {
    const low = shopSupplierView(
      integration({
        lowBalance: true,
        status: "error",
        lastError: "TechChief rejected this key.",
      }),
    );
    expect(low.lowBalance).toBe(true);
    expect(low.status).toBe("error");
    expect(low.lastError).toBe("TechChief rejected this key.");
  });
});
