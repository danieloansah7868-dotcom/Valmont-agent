import { describe, it, expect } from "vitest";
import {
  isHttpsSafeUrl,
  siteBriefSchemaV1,
  type SiteBriefV1,
} from "./site-brief/schema";
import {
  computeBriefCompleteness,
  displayValue,
  PLACEHOLDER_TEXT,
} from "./site-brief/readiness";
import {
  createDefaultBrief,
  GHANA_DEFAULTS,
  GHANA_REGIONS,
  formatGhanaPhone,
  formatGhanaCurrency,
  PLANNED_PAYMENT_METHODS,
  PAYMENT_PLANNING_NOTICE,
  isStarterValue,
} from "./site-brief/defaults";
import {
  isTemplateCompatible,
  defaultTemplateForCategory,
  templatesForCategory,
  reconcileTemplate,
  everyCategoryHasATemplate,
  templates,
} from "./templates";
import { CATEGORY_IDS } from "./categories";

/** A brief with real (non-placeholder) answers in every required field. */
function completeBrief(): SiteBriefV1 {
  return siteBriefSchemaV1.parse({
    schemaVersion: 1,
    businessName: "Adom Fabrics",
    category: "business-profile",
    selectedPackage: "starter",
    selectedTheme: "clean-corporate",
    selectedTemplate: "classic-hero",
    adminEmail: "ama@adomfabrics.com",
    phone: "+233201234567",
  });
}

describe("site brief schema", () => {
  it("accepts a complete brief", () => {
    expect(siteBriefSchemaV1.safeParse(completeBrief()).success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const result = siteBriefSchemaV1.safeParse({
      ...completeBrief(),
      category: "bad",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a javascript: link", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        mapsLink: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("rejects a plain http link", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        existingWebsite: "http://example.com",
      }).success,
    ).toBe(false);
  });

  it("rejects a link to a private address", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        existingWebsite: "https://192.168.0.1/admin",
      }).success,
    ).toBe(false);
  });

  it("rejects a colour that is not a hex value", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        preferredColours: ["red", "#ffffff", "#000000"],
      }).success,
    ).toBe(false);
  });

  it("rejects a phone number that is not in +233 style form", () => {
    expect(
      siteBriefSchemaV1.safeParse({ ...completeBrief(), phone: "123" }).success,
    ).toBe(false);
  });

  it("rejects an unknown Ghana region", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        ghanaRegion: "Atlantis",
      }).success,
    ).toBe(false);
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        ghanaRegion: GHANA_REGIONS[0],
      }).success,
    ).toBe(true);
  });
});

describe("site brief: products as well as services", () => {
  it("accepts simple product names and categories", () => {
    const parsed = siteBriefSchemaV1.parse({
      ...completeBrief(),
      category: "online-shop",
      ecomSubcategory: "fashion",
      selectedTemplate: defaultTemplateForCategory("online-shop"),
      products: [
        { name: "Ankara shirt", category: "Clothing" },
        { name: "Kente scarf" },
      ],
      services: ["Tailoring"],
    });
    expect(parsed.products).toHaveLength(2);
    expect(parsed.services).toEqual(["Tailoring"]);
  });

  it("does not accept prices, stock or any catalogue fields", () => {
    const parsed = siteBriefSchemaV1.parse({
      ...completeBrief(),
      products: [
        { name: "Ankara shirt", category: "Clothing", price: 120, stock: 4 },
      ],
    });
    // Unknown keys are dropped, so no price or stock can ever be stored.
    expect(parsed.products[0]).toEqual({
      name: "Ankara shirt",
      category: "Clothing",
    });
  });

  it("caps the product list so it cannot become a catalogue", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      name: `Item ${i}`,
    }));
    expect(
      siteBriefSchemaV1.safeParse({ ...completeBrief(), products: tooMany })
        .success,
    ).toBe(false);
  });
});

describe("site brief: shop subtype rules", () => {
  it("allows a shop subtype only for the online shop type", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        category: "business-profile",
        ecomSubcategory: "fashion",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown shop subtype", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        category: "online-shop",
        selectedTemplate: defaultTemplateForCategory("online-shop"),
        ecomSubcategory: "not-a-subtype",
      }).success,
    ).toBe(false);
  });
});

describe("site brief: template registry is real", () => {
  it("every template the schema accepts exists in the registry", () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      const category =
        template.compatibleCategories === "*"
          ? "business-profile"
          : template.compatibleCategories[0]!;
      expect(
        siteBriefSchemaV1.safeParse({
          ...completeBrief(),
          category,
          selectedTemplate: template.id,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects a template id that is not in the registry", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        selectedTemplate: "no-such-template",
      }).success,
    ).toBe(false);
  });

  it("rejects a real template that does not suit the chosen website type", () => {
    const category = "school";
    const incompatible = templates.find(
      (t) => !isTemplateCompatible(t.id, category),
    );
    expect(incompatible).toBeDefined();
    const result = siteBriefSchemaV1.safeParse({
      ...completeBrief(),
      category,
      selectedTemplate: incompatible!.id,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["selectedTemplate"]);
    }
  });

  it("every category has at least one usable template", () => {
    expect(everyCategoryHasATemplate()).toBe(true);
    for (const category of CATEGORY_IDS) {
      expect(templatesForCategory(category).length).toBeGreaterThan(0);
      expect(
        isTemplateCompatible(defaultTemplateForCategory(category), category),
      ).toBe(true);
    }
  });

  it("swaps an unsuitable template for a suitable one when the type changes", () => {
    const category = "school";
    const incompatible = templates.find(
      (t) => !isTemplateCompatible(t.id, category),
    )!;
    const reconciled = reconcileTemplate(category, incompatible.id);
    expect(isTemplateCompatible(reconciled, category)).toBe(true);
  });

  it("keeps a template that already suits the chosen type", () => {
    const keep = defaultTemplateForCategory("business-profile");
    expect(reconcileTemplate("business-profile", keep)).toBe(keep);
  });
});

describe("site brief: Ghana-friendly defaults", () => {
  it("a new brief starts with Ghana settings", () => {
    const brief = createDefaultBrief();
    expect(brief.country).toBe("Ghana");
    expect(brief.currency).toBe("GHS");
    expect(brief.timezone).toBe("Africa/Accra");
    expect(brief.assetStatus).toBe("not_provided");
    expect(GHANA_DEFAULTS.country).toBe("Ghana");
  });

  it("a new brief passes its own schema", () => {
    expect(siteBriefSchemaV1.safeParse(createDefaultBrief()).success).toBe(
      true,
    );
  });

  it("formats Ghana phone numbers into +233 form", () => {
    expect(formatGhanaPhone("0201234567")).toBe("+233201234567");
    expect(formatGhanaPhone("233201234567")).toBe("+233201234567");
    expect(formatGhanaPhone("+233 20 123 4567")).toBe("+233201234567");
    expect(formatGhanaPhone("020 123 4567")).toBe("+233201234567");
  });

  it("leaves an unrecognised number alone rather than guessing", () => {
    expect(formatGhanaPhone("")).toBe("");
    // Not a Ghana number, so it is left exactly as the owner typed it.
    expect(formatGhanaPhone("+44 20 7946 0000")).toBe("+44 20 7946 0000");
  });

  it("a formatted Ghana phone number is accepted by the schema", () => {
    const phone = formatGhanaPhone("0201234567");
    expect(
      siteBriefSchemaV1.safeParse({ ...completeBrief(), phone }).success,
    ).toBe(true);
  });

  it("formats money in cedis", () => {
    expect(formatGhanaCurrency(3500)).toContain("3,500");
    expect(formatGhanaCurrency(3500)).toMatch(/GH₵|GHS/);
  });

  it("lists the sixteen Ghana regions", () => {
    expect(GHANA_REGIONS.length).toBe(16);
    expect(GHANA_REGIONS).toContain("Greater Accra");
  });
});

describe("site brief: payment preferences are planning only", () => {
  it("records preferences without switching anything on", () => {
    const parsed = siteBriefSchemaV1.parse({
      ...completeBrief(),
      plannedPaymentMethods: ["momo", "paystack"],
      paymentNotes: "Would like MoMo one day.",
    });
    expect(parsed.plannedPaymentMethods).toEqual(["momo", "paystack"]);
  });

  it("rejects a payment method that is not on the planning list", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        plannedPaymentMethods: ["crypto"],
      }).success,
    ).toBe(false);
  });

  it("labels every planning option as not working yet", () => {
    expect(PLANNED_PAYMENT_METHODS.length).toBeGreaterThan(0);
    expect(PAYMENT_PLANNING_NOTICE.toLowerCase()).toContain("planning");
    expect(PAYMENT_PLANNING_NOTICE.toLowerCase()).toContain("no payment");
    for (const method of PLANNED_PAYMENT_METHODS) {
      expect(method.label.length).toBeGreaterThan(0);
    }
  });

  it("has no field anywhere for card or MoMo credentials", () => {
    const parsed = siteBriefSchemaV1.parse({
      ...completeBrief(),
      cardNumber: "4111111111111111",
      momoPin: "1234",
      merchantSecret: "sk_live_x",
    });
    expect(Object.keys(parsed)).not.toContain("cardNumber");
    expect(Object.keys(parsed)).not.toContain("momoPin");
    expect(Object.keys(parsed)).not.toContain("merchantSecret");
  });
});

describe("site brief: asset status stays a marker", () => {
  it("only accepts the not_provided marker", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        assetStatus: "https://example.com/logo.png",
      }).success,
    ).toBe(false);
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        assetStatus: "uploaded",
      }).success,
    ).toBe(false);
  });
});

describe("brief completeness", () => {
  it("a fully answered brief is ready for handoff", () => {
    const c = computeBriefCompleteness(completeBrief());
    expect(c.missingRequired).toEqual([]);
    expect(c.readyForHandoff).toBe(true);
    expect(c.score).toBeGreaterThan(0);
  });

  it("an empty brief lists every required gap", () => {
    const c = computeBriefCompleteness({});
    expect(c.missingRequired.length).toBe(6);
    expect(c.readyForHandoff).toBe(false);
    expect(c.score).toBe(0);
  });

  it("does not count the starter placeholder values as real answers", () => {
    const c = computeBriefCompleteness(createDefaultBrief());
    const fields = c.missingRequired.map((gap) => gap.field);
    expect(fields).toContain("businessName");
    expect(fields).toContain("adminEmail");
    expect(isStarterValue("businessName", "My business")).toBe(true);
    expect(isStarterValue("businessName", "Adom Fabrics")).toBe(false);
  });

  it("the score rises as fields are filled in", () => {
    const before = computeBriefCompleteness(completeBrief());
    const after = computeBriefCompleteness({
      ...completeBrief(),
      description: "We sell fabric in Accra.",
      tagline: "Fabric you can trust",
    });
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.earnedPoints).toBeGreaterThan(before.earnedPoints);
  });

  it("counts products or services for the same recommendation", () => {
    const withServices = computeBriefCompleteness({
      ...completeBrief(),
      services: ["Tailoring"],
    });
    const withProducts = computeBriefCompleteness({
      ...completeBrief(),
      products: [{ name: "Ankara shirt" }],
    });
    expect(withServices.score).toBe(withProducts.score);
    expect(withServices.gaps.map((g) => g.field)).not.toContain("offerings");
    expect(withProducts.gaps.map((g) => g.field)).not.toContain("offerings");
  });

  it("accepts either a phone or a WhatsApp number as contact", () => {
    const base = { ...completeBrief(), phone: undefined };
    const viaWhatsapp = computeBriefCompleteness({
      ...base,
      whatsapp: "+233201234567",
    });
    expect(viaWhatsapp.missingRequired.map((g) => g.field)).not.toContain(
      "contact",
    );
    const noContact = computeBriefCompleteness(base);
    expect(noContact.missingRequired.map((g) => g.field)).toContain("contact");
  });

  it("required gaps are worth twice a recommended one", () => {
    const empty = computeBriefCompleteness({});
    expect(empty.totalPoints).toBe(6 * 2 + empty.recommended.length * 1);
  });

  it("every gap carries plain-language wording", () => {
    for (const gap of computeBriefCompleteness({}).gaps) {
      expect(gap.label.length).toBeGreaterThan(0);
      expect(gap.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("preview values", () => {
  it("shows the placeholder marker for empty values", () => {
    expect(displayValue("")).toEqual({
      text: PLACEHOLDER_TEXT,
      isPlaceholder: true,
    });
    expect(displayValue(undefined).isPlaceholder).toBe(true);
  });

  it("shows a real value untouched", () => {
    expect(displayValue("  Adom Fabrics  ")).toEqual({
      text: "Adom Fabrics",
      isPlaceholder: false,
    });
  });
});

describe("isHttpsSafeUrl private-address blocking", () => {
  it("accepts ordinary public https URLs", () => {
    for (const url of [
      "https://valmontweb.com",
      "https://maps.google.com/?q=Accra",
      "https://sub.domain.example.co.uk/path?a=1#b",
      "https://8.8.8.8/health",
      "https://[2001:4860:4860::8888]/",
    ]) {
      expect(isHttpsSafeUrl(url), url).toBe(true);
    }
  });

  it("rejects non-https schemes and embedded credentials", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://valmontweb.com",
      "file:///etc/passwd",
      "https://user:pass@valmontweb.com",
      "not a url",
    ]) {
      expect(isHttpsSafeUrl(url), url).toBe(false);
    }
  });

  it("rejects every private, loopback and link-local IPv4 range", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "169.254.1.1",
      "0.0.0.0",
      "172.16.0.1", // the range the old list missed
      "172.20.10.5",
      "172.31.255.254",
      "100.64.0.1", // CGNAT
      "239.1.1.1", // multicast
    ]) {
      expect(isHttpsSafeUrl(`https://${host}/x`), host).toBe(false);
    }
  });

  it("still allows 172.x addresses outside the private 172.16/12 block", () => {
    expect(isHttpsSafeUrl("https://172.15.0.1/")).toBe(true);
    expect(isHttpsSafeUrl("https://172.32.0.1/")).toBe(true);
  });

  it("rejects IPv6 loopback, unique-local and link-local", () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
    ]) {
      expect(isHttpsSafeUrl(`https://${host}/x`), host).toBe(false);
    }
  });

  it("rejects IPv4-mapped IPv6 that hides a private address", () => {
    expect(
      isHttpsSafeUrl("https://[::ffff:169.254.169.254]/latest/meta-data"),
    ).toBe(false);
    expect(isHttpsSafeUrl("https://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[::ffff:10.0.0.1]/")).toBe(false);
  });

  it("rejects malformed dotted quads rather than guessing", () => {
    expect(isHttpsSafeUrl("https://999.999.999.999/")).toBe(false);
  });
});
