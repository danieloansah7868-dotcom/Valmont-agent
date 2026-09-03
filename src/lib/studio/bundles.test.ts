/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { siteBriefSchemaV1 } from "./site-brief/schema";
import { computeBriefCompleteness } from "./site-brief/readiness";
import {
  starterBundleCatalogue,
  groupBundlesByNetwork,
  isValidGhanaMobile,
  normalizeGhanaMobile,
  maskGhanaMobile,
  checkRecipientNetworkMatch,
  formatDataMb,
  parseDataSizeToMb,
} from "./bundles";
import { templatesForCategory } from "./templates";

function baseBrief(overrides: any = {}) {
  return {
    schemaVersion: 1,
    businessName: "Test Bundles Shop",
    category: "data-bundles",
    selectedPackage: "starter",
    selectedTheme: "clean-corporate",
    selectedTemplate:
      templatesForCategory("data-bundles")[0]?.id ?? "bundle-shop",
    adminEmail: "ama@adomfabrics.com",
    phone: "+233201234567",
    items: [],
    ...overrides,
  };
}

describe("bundle schema", () => {
  it("accepts a data-bundles brief with priced bundles carrying bundle field", () => {
    const brief = baseBrief({
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024, validity: "30 days" },
        },
      ],
    });
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(true);
  });

  it("rejects a data-bundles brief where priced item lacks bundle field", () => {
    const brief = baseBrief({
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 10,
        },
      ],
    });
    const result = siteBriefSchemaV1.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("bundle"))).toBe(true);
    }
  });

  it("rejects non-bundle site that carries bundle metadata", () => {
    const brief = {
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      phone: "+233201234567",
      items: [
        {
          id: "item-1",
          name: "Shirt",
          price: 50,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
    };
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(false);
  });

  it("accepts non-bundle site without bundle field", () => {
    const brief = {
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      phone: "+233201234567",
      items: [
        {
          id: "item-1",
          name: "Shirt",
          price: 50,
        },
      ],
    };
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(true);
  });

  it("allows unpriced items without bundle in bundle site", () => {
    const brief = baseBrief({
      items: [
        {
          id: "info-1",
          name: "How it works",
        },
      ],
    });
    // unpriced items don't need bundle
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(true);
  });
});

describe("starter catalogue", () => {
  it("has 18 bundles with structured fields", () => {
    const starter = starterBundleCatalogue();
    expect(starter).toHaveLength(18);
    for (const item of starter) {
      expect(item.price).toBeDefined();
      expect(item.bundle).toBeDefined();
      expect(item.bundle?.network).toMatch(/mtn|telecel|airteltigo/);
      expect(item.bundle?.dataMb).toBeGreaterThan(0);
      expect(item.bundle?.validity).toBeDefined();
      expect(item.id).toMatch(/^bundle-/);
    }
  });

  it("has 6 per network", () => {
    const starter = starterBundleCatalogue();
    const grouped = groupBundlesByNetwork(starter);
    expect(grouped.mtn).toHaveLength(6);
    expect(grouped.telecel).toHaveLength(6);
    expect(grouped.airteltigo).toHaveLength(6);
  });

  it("parses and formats data sizes (1 GB = 1024 MB)", () => {
    expect(parseDataSizeToMb("5GB")).toBe(5120);
    expect(parseDataSizeToMb("500MB")).toBe(500);
    expect(parseDataSizeToMb("0.5GB")).toBe(512);
    expect(formatDataMb(1024)).toBe("1GB");
    expect(formatDataMb(500)).toBe("500MB");
    expect(formatDataMb(512)).toBe("512MB");
    expect(formatDataMb(2048)).toBe("2GB");
  });

  it("500MB round-trips", () => {
    const mb = parseDataSizeToMb("500MB")!;
    expect(formatDataMb(mb)).toBe("500MB");
    const mb2 = parseDataSizeToMb("0.5GB")!;
    expect(mb2).toBe(512);
  });
});

describe("groupBundlesByNetwork field-first fallback", () => {
  it("uses structured field first", () => {
    const items: any[] = [
      {
        id: "1",
        name: "Random name",
        price: 10,
        category: "mtn",
        bundle: { network: "telecel", dataMb: 1024 },
      },
    ];
    const grouped = groupBundlesByNetwork(items);
    expect(grouped.telecel).toHaveLength(1);
    expect(grouped.mtn).toHaveLength(0);
  });

  it("falls back to guessing from category/name when no bundle field", () => {
    const items: any[] = [
      {
        id: "1",
        name: "MTN 5GB",
        price: 30,
        category: "mtn",
      },
      {
        id: "2",
        name: "Telecel 2GB",
        price: 15,
        category: "telecel",
      },
      {
        id: "3",
        name: "AirtelTigo 1GB",
        price: 10,
        category: "airteltigo",
      },
    ];
    const grouped = groupBundlesByNetwork(items);
    expect(grouped.mtn).toHaveLength(1);
    expect(grouped.telecel).toHaveLength(1);
    expect(grouped.airteltigo).toHaveLength(1);
  });

  it("ignores unpriced items", () => {
    const items: any[] = [
      {
        id: "1",
        name: "MTN 5GB",
        category: "mtn",
      },
    ];
    const grouped = groupBundlesByNetwork(items);
    expect(grouped.mtn).toHaveLength(0);
  });
});

describe("readiness for bundle shop", () => {
  it("requires at least one priced bundle with bundle meta", () => {
    const emptyBundleBrief = baseBrief({ items: [] });
    const c1 = computeBriefCompleteness(emptyBundleBrief);
    expect(c1.missingRequired.map((g) => g.field)).toContain("bundleCatalogue");
    // bundleMetadata is vacuously true when empty, so only catalogue fires
    expect(c1.missingRequired.map((g) => g.field)).not.toContain(
      "bundleMetadata",
    );

    const withBundles = baseBrief({
      items: starterBundleCatalogue().slice(0, 2),
    });
    const c2 = computeBriefCompleteness(withBundles);
    expect(c2.missingRequired.map((g) => g.field)).not.toContain(
      "bundleCatalogue",
    );
    expect(c2.missingRequired.map((g) => g.field)).not.toContain(
      "bundleMetadata",
    );
  });

  it("requires bundle metadata on every priced item", () => {
    const briefMissingMeta = baseBrief({
      items: [
        {
          id: "1",
          name: "MTN 5GB",
          price: 30,
        },
      ],
    });
    const c = computeBriefCompleteness(briefMissingMeta);
    expect(c.missingRequired.some((g) => g.field.includes("bundle"))).toBe(
      true,
    );
  });

  it("non-bundle site does not require bundle rules", () => {
    const brief: any = {
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      adminEmail: "owner@example.com",
      phone: "+233201234567",
      items: [],
    };
    const c = computeBriefCompleteness(brief);
    expect(c.missingRequired.map((g) => g.field)).not.toContain(
      "bundleCatalogue",
    );
  });
});

describe("template defaults for data-bundles", () => {
  it("defaults to bundle-shop for data-bundles", async () => {
    const { defaultTemplateForCategory } = await import("./templates");
    expect(defaultTemplateForCategory("data-bundles")).toBe("bundle-shop");
  });

  it("other categories keep their old defaults", async () => {
    const { defaultTemplateForCategory } = await import("./templates");
    // Snapshot from main: ensure we didn't change other categories
    expect(defaultTemplateForCategory("business-profile")).toBe("classic-hero");
    expect(defaultTemplateForCategory("online-shop")).toBe("classic-hero");
    expect(defaultTemplateForCategory("restaurant")).toBe("classic-hero");
    expect(defaultTemplateForCategory("school")).toBe("classic-hero");
  });

  it("bundle-shop only compatible with data-bundles", async () => {
    const { isTemplateCompatible } = await import("./templates");
    expect(isTemplateCompatible("bundle-shop", "data-bundles")).toBe(true);
    expect(isTemplateCompatible("bundle-shop", "online-shop")).toBe(false);
    expect(isTemplateCompatible("bundle-shop", "business-profile")).toBe(false);
  });
});

describe("readiness for bundle shop - edge cases", () => {
  it("empty bundle brief is NOT ready", () => {
    const brief = baseBrief({ items: [] });
    const c = computeBriefCompleteness(brief);
    expect(c.readyForHandoff).toBe(false);
    expect(c.missingRequired.map((g) => g.field)).toContain("bundleCatalogue");
  });

  it("MTN-only shop with 3 priced bundles IS ready", () => {
    const items = [
      {
        id: "b1",
        name: "MTN 1GB",
        price: 10,
        bundle: { network: "mtn", dataMb: 1024 },
      },
      {
        id: "b2",
        name: "MTN 2GB",
        price: 15,
        bundle: { network: "mtn", dataMb: 2048 },
      },
      {
        id: "b3",
        name: "MTN 5GB",
        price: 30,
        bundle: { network: "mtn", dataMb: 5120 },
      },
    ];
    const brief = baseBrief({ items });
    const c = computeBriefCompleteness(brief);
    expect(c.missingRequired.length).toBe(0);
    expect(c.readyForHandoff).toBe(true);
  });
});

describe("Ghana mobile validation", () => {
  it("accepts valid Ghana mobiles 02x/05x", () => {
    expect(isValidGhanaMobile("0240000001")).toBe(true);
    expect(isValidGhanaMobile("0541234567")).toBe(true);
    expect(isValidGhanaMobile("0201234567")).toBe(true);
    expect(isValidGhanaMobile("+233240000001")).toBe(true);
    expect(isValidGhanaMobile("233240000001")).toBe(true);
    expect(isValidGhanaMobile(" 024 000 0001 ")).toBe(true);
  });

  it("rejects landline 030", () => {
    expect(isValidGhanaMobile("0300000000")).toBe(false);
    expect(isValidGhanaMobile("0301234567")).toBe(false);
    expect(isValidGhanaMobile("+233300000000")).toBe(false);
  });

  it("normalizes to 0240000001 format", () => {
    expect(normalizeGhanaMobile("+233240000001")).toBe("0240000001");
    expect(normalizeGhanaMobile("233240000001")).toBe("0240000001");
    expect(normalizeGhanaMobile("0240000001")).toBe("0240000001");
  });

  it("warns on wrong network but does not block", () => {
    const warn = checkRecipientNetworkMatch("0240000001", "telecel");
    expect(warn.matches).toBe(false);
    expect(warn.warning).toBeDefined();

    const ok = checkRecipientNetworkMatch("0240000001", "mtn");
    expect(ok.matches).toBe(true);
  });

  it("validateGhanaMobile single source of truth", async () => {
    const { validateGhanaMobile } = await import("./bundles");
    expect(validateGhanaMobile("")).toBe("Phone number is required");
    expect(validateGhanaMobile("030 123 4567")).toMatch(/Landline/);
    expect(validateGhanaMobile("0240000001")).toBeNull();
    expect(validateGhanaMobile("+44 7700 900123")).toMatch(/Ghana mobile/);
  });
});

describe("maskGhanaMobile for pages anyone can open", () => {
  it("masks the middle digits and keeps prefix and last four", () => {
    expect(maskGhanaMobile("0240000001")).toBe("024 ••• 0001");
  });

  it("never reveals the full number", () => {
    const masked = maskGhanaMobile("0541234567");
    expect(masked).not.toContain("0541234567");
    expect(masked).toBe("054 ••• 4567");
  });

  it("masks whatever shape it is given, so an unexpected value cannot leak", () => {
    expect(maskGhanaMobile("+233240000001")).toBe("+23 ••• 0001");
    expect(maskGhanaMobile("024 000 0001")).toBe("024 ••• 0001");
    expect(maskGhanaMobile("+447700900123")).toBe("+44 ••• 0123");
  });

  it("masks short or empty input entirely instead of echoing it", () => {
    expect(maskGhanaMobile("")).toBe("••• ••• ••••");
    expect(maskGhanaMobile("12345")).toBe("••• ••• ••••");
    expect(maskGhanaMobile(null)).toBe("••• ••• ••••");
    expect(maskGhanaMobile(undefined)).toBe("••• ••• ••••");
  });
});

describe("bundle shop payment rules (stage 3)", () => {
  it("rejects cod for data-bundles", () => {
    const brief = baseBrief({
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
      payments: {
        enabled: true,
        methods: ["cod"],
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        valmontPay: { provisioned: false },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
    });
    const result = siteBriefSchemaV1.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("payments"))).toBe(true);
    }
  });

  it("rejects delivery enabled for data-bundles", () => {
    const brief = baseBrief({
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        delivery: { enabled: true, fee: 5, minimumOrder: 0 },
        valmontPay: { provisioned: false },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
    });
    const result = siteBriefSchemaV1.safeParse(brief);
    expect(result.success).toBe(false);
  });

  it("accepts valmont_pay only with no delivery for data-bundles", () => {
    const brief = baseBrief({
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        valmontPay: { provisioned: false },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
    });
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(true);
  });

  it("accepts cod and delivery for online-shop", () => {
    const brief = {
      schemaVersion: 1,
      businessName: "Test Shop",
      category: "online-shop",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "owner@example.com",
      phone: "+233201234567",
      items: [{ id: "item-1", name: "Shirt", price: 50 }],
      payments: {
        enabled: true,
        methods: ["cod", "momo"],
        delivery: { enabled: true, fee: 5, minimumOrder: 0 },
        valmontPay: { provisioned: false },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
    };
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(true);
  });

  it("switch into data-bundles with cod/momo sanitizes to valmont_pay only and no delivery", async () => {
    const { guessNetworkFromItem, guessDataMbFromItem } =
      await import("./bundles");
    const businessBrief = {
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      phone: "+233201234567",
      items: [{ id: "item-1", name: "MTN 5GB", price: 30 }],
      payments: {
        enabled: true,
        methods: ["cod", "momo"],
        delivery: { enabled: true, fee: 5, minimumOrder: 0 },
        valmontPay: { provisioned: false },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
    };
    const enrichedItems = businessBrief.items.map((item: any) => ({
      ...item,
      bundle: {
        network: guessNetworkFromItem(item) ?? "mtn",
        dataMb: guessDataMbFromItem(item) ?? 1024,
      },
    }));
    const sanitized = {
      ...businessBrief,
      category: "data-bundles",
      selectedTemplate: "bundle-shop",
      items: enrichedItems,
      payments: {
        ...businessBrief.payments,
        methods: ["valmont_pay"],
        delivery: { ...businessBrief.payments.delivery, enabled: false },
      },
    };
    expect(siteBriefSchemaV1.safeParse(sanitized).success).toBe(true);
  });
});

describe("category switch trap", () => {
  it("leaving data-bundles strips bundle and stays valid", () => {
    const bundleBrief = baseBrief({
      category: "data-bundles",
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
    });
    expect(siteBriefSchemaV1.safeParse(bundleBrief).success).toBe(true);
    const stripped = {
      ...bundleBrief,
      category: "business-profile",
      selectedTemplate: "classic-hero",
      items: bundleBrief.items.map((i: any) => {
        const { bundle: _b, ...rest } = i;
        void _b;
        return rest;
      }),
    };
    expect(siteBriefSchemaV1.safeParse(stripped).success).toBe(true);
  });

  it("entering data-bundles enriches priced items and stays valid", async () => {
    const { guessNetworkFromItem, guessDataMbFromItem } =
      await import("./bundles");
    const businessBrief = {
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      phone: "+233201234567",
      items: [
        { id: "item-1", name: "MTN 5GB", price: 30 },
        { id: "item-2", name: "Shirt", price: 50 },
      ],
    };
    const enriched = {
      ...businessBrief,
      category: "data-bundles",
      selectedTemplate: "bundle-shop",
      items: businessBrief.items.map((item: any) => ({
        ...item,
        bundle: {
          network: guessNetworkFromItem(item) ?? "mtn",
          dataMb: guessDataMbFromItem(item) ?? 1024,
        },
      })),
    };
    expect(siteBriefSchemaV1.safeParse(enriched).success).toBe(true);
  });

  it("entering data-bundles drops price <=0 to unpriced and stays valid", () => {
    const businessBrief = {
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      phone: "+233201234567",
      items: [
        { id: "item-1", name: "MTN 5GB", price: 0 },
        { id: "item-2", name: "Free sample", price: -5 },
        { id: "item-3", name: "Valid", price: 10 },
      ],
    };
    // Simulate enrich that drops price <=0
    const enrichedItems = businessBrief.items.map((item: any) => {
      if (item.price !== undefined && item.price <= 0) {
        const { price: _p, ...rest } = item;
        void _p;
        return rest;
      }
      return item;
    });
    const brief = {
      ...businessBrief,
      category: "data-bundles",
      selectedTemplate: "bundle-shop",
      items: enrichedItems.map((item: any) => {
        if (item.price === undefined) return item;
        return {
          ...item,
          bundle: { network: "mtn", dataMb: 1024 },
        };
      }),
    };
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(true);
  });

  it("price 0 is invalid for bundle", () => {
    const brief = baseBrief({
      items: [
        {
          id: "bundle-01",
          name: "MTN 1GB",
          price: 0,
          bundle: { network: "mtn", dataMb: 1024 },
        },
      ],
    });
    expect(siteBriefSchemaV1.safeParse(brief).success).toBe(false);
  });
});
