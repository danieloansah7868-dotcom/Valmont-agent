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
  SUPPORTED_COUNTRIES,
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIMEZONES,
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
    expect(brief.assets).toEqual({ logo: null, photos: [] });
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

  it("exposes country, currency and timezone controls with Ghana defaults", () => {
    // The wizard offers these as accessible selects; Ghana/GHS/Africa/Accra
    // are the defaults and supported alternatives are available.
    expect(SUPPORTED_COUNTRIES[0]).toBe("Ghana");
    expect(SUPPORTED_COUNTRIES.length).toBeGreaterThan(1);
    expect(SUPPORTED_CURRENCIES.map((c) => c.code)).toContain("GHS");
    expect(SUPPORTED_CURRENCIES.some((c) => c.label.includes("GH₵"))).toBe(
      true,
    );
    expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(1);
    expect(SUPPORTED_TIMEZONES[0]).toBe("Africa/Accra");
    expect(SUPPORTED_TIMEZONES.length).toBeGreaterThan(1);
    // The defaults are part of the offered sets, so a fresh brief's values are
    // always selectable in the wizard.
    expect(SUPPORTED_COUNTRIES).toContain(GHANA_DEFAULTS.country);
    expect(SUPPORTED_CURRENCIES.map((c) => c.code)).toContain(
      GHANA_DEFAULTS.currency,
    );
    expect(SUPPORTED_TIMEZONES).toContain(GHANA_DEFAULTS.timezone);
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

describe("site brief: free text is cleaned before storage", () => {
  // Regression cover for an independent-review finding: SECURITY.md promised
  // payment details could not be stored, but free-text fields accepted them.

  it("redacts a card number, PIN and API key pasted into payment notes", () => {
    const parsed = siteBriefSchemaV1.parse({
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      paymentNotes:
        "Card 4111111111111111; MoMo PIN 1234; merchant secret sk-proj-abcdefghijklmnop",
    });
    expect(parsed.paymentNotes).not.toContain("4111111111111111");
    expect(parsed.paymentNotes).not.toContain("sk-proj-abcdefghijklmnop");
    expect(parsed.paymentNotes).not.toMatch(/PIN 1234/);
    expect(parsed.paymentNotes).toContain("[REDACTED_CARD_NUMBER]");
  });

  it("cleans every free-text field, not only payment notes", () => {
    const card = "4111111111111111";
    const parsed = siteBriefSchemaV1.parse({
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      description: `Pay to ${card}`,
      specialInstructions: `Use ${card}`,
      address: `Invoice ${card}`,
      hours: `Ring ${card}`,
      tagline: `Card ${card}`,
    });
    for (const value of [
      parsed.description,
      parsed.specialInstructions,
      parsed.address,
      parsed.hours,
      parsed.tagline,
    ]) {
      expect(value).not.toContain(card);
    }
  });

  it("cleans list entries too, not only single fields", () => {
    const card = "4111111111111111";
    const parsed = siteBriefSchemaV1.parse({
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      serviceAreas: [`Accra ${card}`],
      deliveryAreas: [`Tema ${card}`],
      services: [`Tailoring ${card}`],
      requiredPages: [`About ${card}`],
      products: [{ name: `Dress ${card}`, category: `Wear ${card}` }],
    });
    expect(JSON.stringify(parsed)).not.toContain(card);
  });

  it("leaves ordinary business text untouched", () => {
    const parsed = siteBriefSchemaV1.parse({
      schemaVersion: 1,
      businessName: "Adom Fabrics",
      category: "business-profile",
      selectedPackage: "starter",
      selectedTheme: "clean-corporate",
      selectedTemplate: "classic-hero",
      adminEmail: "ama@adomfabrics.com",
      description: "Order 12345678 ships in 3 to 5 days for GHS 3,500.",
      hours: "Mon-Fri 8:00 to 17:00",
    });
    expect(parsed.description).toBe(
      "Order 12345678 ships in 3 to 5 days for GHS 3,500.",
    );
    expect(parsed.hours).toBe("Mon-Fri 8:00 to 17:00");
  });
});

describe("site brief: assets field holds uploaded images", () => {
  it("defaults to empty logo and photos when not provided", () => {
    const parsed = siteBriefSchemaV1.parse(completeBrief());
    expect(parsed.assets).toEqual({ logo: null, photos: [] });
  });

  it("rejects an image that is not an accepted mime type", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        assets: {
          logo: {
            dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
            fileName: "logo.svg",
            mime: "image/svg+xml",
            width: 100,
            height: 100,
            size: 10,
          },
          photos: [],
        },
      }).success,
    ).toBe(false);
  });

  it("caps the photo list at 8", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
      fileName: `p${i}.png`,
      mime: "image/png",
      width: 1,
      height: 1,
      size: 68,
    }));
    expect(
      siteBriefSchemaV1.safeParse({
        ...completeBrief(),
        assets: { logo: null, photos: tooMany },
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

  // The checks below are regression cover for bypasses found in independent
  // review of this file's previous hand-written deny list.

  it("rejects a trailing dot, which DNS treats as the same name", () => {
    expect(isHttpsSafeUrl("https://localhost./")).toBe(false);
    expect(isHttpsSafeUrl("https://app.localhost./")).toBe(false);
    expect(isHttpsSafeUrl("https://localhost.localdomain/")).toBe(false);
  });

  it("rejects deprecated IPv4-compatible IPv6 hiding loopback", () => {
    // ::7f00:1 is 127.0.0.1 written the IPv4-compatible way.
    expect(isHttpsSafeUrl("https://[::7f00:1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[::127.0.0.1]/")).toBe(false);
  });

  it("rejects IPv6 multicast and documentation ranges", () => {
    expect(isHttpsSafeUrl("https://[ff00::1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[ff02::1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[2001:db8::1]/")).toBe(false);
  });

  // A second independent review demonstrated that the transition-mechanism
  // encodings below still reached `accepted: true`. Each one hides an IPv4
  // address inside an IPv6 literal that a gateway will happily deliver to.

  it("rejects SIIT-translated addresses hiding a private destination", () => {
    // ::ffff:0:a.b.c.d — the extra zero word defeated the mapped-address regex.
    expect(isHttpsSafeUrl("https://[::ffff:0:127.0.0.1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[::ffff:0:7f00:1]/")).toBe(false);
    expect(
      isHttpsSafeUrl("https://[::ffff:0:169.254.169.254]/latest/meta-data"),
    ).toBe(false);
  });

  it("rejects NAT64-prefixed addresses hiding a private destination", () => {
    // 64:ff9b::/96 is the well-known prefix; 64:ff9b:1::/48 is local-use.
    expect(isHttpsSafeUrl("https://[64:ff9b::127.0.0.1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[64:ff9b::7f00:1]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[64:ff9b::169.254.169.254]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[64:ff9b:1::7f00:1]/")).toBe(false);
  });

  // Raised by independent review of 158f601 and reproduced before fixing.
  // RFC 6052 does not keep the IPv4 address in a fixed place: under the
  // local-use /48 prefix it sits at bits 48-63 and 72-95, not in the final
  // two words. The previous extractor only read the tail, so an attacker
  // could park a loopback in the /48 slots and a public address in the tail.
  it("rejects a NAT64 /48 address whose payload is private but whose tail is public", () => {
    expect(isHttpsSafeUrl("https://[64:ff9b:1:7f00:1:0:808:808]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[64:ff9b:1:a9fe:a9fe:0:808:808]/")).toBe(
      false,
    );
  });

  // Teredo (RFC 4380) hides the client IPv4 in the last two words, XORed
  // with all-ones, and the server IPv4 unobfuscated in words 2-3.
  it("rejects Teredo addresses hiding a private destination", () => {
    expect(
      isHttpsSafeUrl("https://[2001:0:4136:e378:8000:63bf:80ff:fffe]/"),
    ).toBe(false);
  });

  it("rejects 6to4 addresses hiding a private destination", () => {
    // 2002:<ipv4>::/48 carries the address in the two words after the prefix.
    expect(isHttpsSafeUrl("https://[2002:7f00:1::]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[2002:a9fe:a9fe::]/")).toBe(false);
  });

  it("still allows public addresses in those same encodings", () => {
    // The rule is "the embedded address is private", not "the encoding is
    // unusual". A public destination stays reachable however it is written.
    expect(isHttpsSafeUrl("https://[::ffff:8.8.8.8]/")).toBe(true);
    expect(isHttpsSafeUrl("https://[64:ff9b::8.8.8.8]/")).toBe(true);
    expect(isHttpsSafeUrl("https://[2002:0808:0808::]/")).toBe(true);
    // A NAT64 /48 carrying a public payload. The zero padding in its tail is
    // not an address and must not be read as 0.0.0.0, which is reserved.
    expect(isHttpsSafeUrl("https://[64:ff9b:1:808:808::]/")).toBe(true);
    expect(isHttpsSafeUrl("https://[2606:4700:4700::1111]/")).toBe(true);
  });

  it("rejects special-purpose IPv4 ranges beyond the obvious private ones", () => {
    for (const host of [
      "192.0.0.1", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "198.18.0.1", // benchmarking
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "192.88.99.1", // deprecated 6to4 relay
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
    ]) {
      expect(isHttpsSafeUrl(`https://${host}/x`), host).toBe(false);
    }
  });

  it("rejects an IPv6 literal it cannot parse instead of allowing it", () => {
    expect(isHttpsSafeUrl("https://[1:2:3:4:5:6:7:8:9]/")).toBe(false);
    expect(isHttpsSafeUrl("https://[::ffff:1.2.3]/")).toBe(false);
  });

  it("still allows ordinary public addresses next to blocked ranges", () => {
    for (const host of [
      "valmontweb.com",
      "8.8.8.8",
      "192.169.1.1", // one above 192.168/16
      "100.128.0.1", // one above the CGNAT block
      "11.0.0.1", // one above 10/8
      "[2606:4700:4700::1111]",
      "shop.valmontweb.com.", // trailing dot on a public name is fine
    ]) {
      expect(isHttpsSafeUrl(`https://${host}/x`), host).toBe(true);
    }
  });
});
