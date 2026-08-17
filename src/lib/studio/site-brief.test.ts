/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { siteBriefSchemaV1 } from "./site-brief/schema";
import { computeBriefCompleteness } from "./site-brief/readiness";

const valid = {
  schemaVersion: 1 as const,
  businessName: "Acme",
  category: "business-profile",
  selectedPackage: "starter",
  selectedTheme: "clean-corporate",
  adminEmail: "owner@example.com",
  socialLinks: [],
  serviceAreas: [],
  deliveryAreas: [],
  services: [],
  requiredPages: [],
  assetStatus: "not_provided" as const,
};

describe("site brief", () => {
  it("validates required", () => {
    expect(siteBriefSchemaV1.safeParse(valid).success).toBe(true);
  });
  it("rejects invalid category", () => {
    expect(
      siteBriefSchemaV1.safeParse({ ...valid, category: "bad" }).success,
    ).toBe(false);
  });
  it("rejects javascript url", () => {
    expect(
      siteBriefSchemaV1.safeParse({ ...valid, mapsLink: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });
  it("rejects bad color", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...valid,
        preferredColours: ["red", "#ffffff", "#000000"] as unknown as any,
      }).success,
    ).toBe(false);
  });
  it("rejects bad phone", () => {
    expect(
      siteBriefSchemaV1.safeParse({ ...valid, phone: "123" }).success,
    ).toBe(false);
  });
  it("brief completeness", () => {
    const c = computeBriefCompleteness(valid as any);
    expect(c.score).toBeGreaterThan(0);
    expect(c.missingRequired).toEqual([]);
  });
  it("missing required", () => {
    const c = computeBriefCompleteness({});
    expect(c.missingRequired.length).toBeGreaterThan(0);
  });
});
