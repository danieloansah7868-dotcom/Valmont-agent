import { z } from "zod";
import { isCategoryId, isEcomSubcategoryId } from "../categories";
import { isPackageId } from "../packages";
import { isTemplateId, isTemplateCompatible } from "../templates";
import { isThemeId, HEX_COLOR_RE } from "../themes";
import { isGhanaRegion } from "./defaults";

export const SITE_BRIEF_VERSION = 1 as const;

/**
 * True when `host` is a literal IP address (or IPv6 form) that belongs to a
 * private, loopback, link-local, or otherwise non-public range.
 *
 * Phase 1 never server-fetches a user-supplied URL — these values are only ever
 * rendered as `<a href>`. The check is written to a full SSRF standard anyway so
 * it is already correct on the day something does fetch one. Note it can only
 * judge literal addresses: a public hostname that *resolves* to a private
 * address still needs a connect-time check from whatever does the fetching.
 */
function isPrivateHost(host: string): boolean {
  // IPv6 arrives from URL.hostname wrapped in brackets.
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (bare === "localhost" || bare.endsWith(".localhost")) return true;

  // IPv4-mapped IPv6 — reduce to the embedded IPv4 and re-test so the mapping
  // cannot be used to slip a private address past the IPv4 rules. Both the
  // dotted form (::ffff:169.254.169.254) and the hex form WHATWG normalises it
  // to (::ffff:a9fe:a9fe) have to be handled.
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mappedDotted) return isPrivateHost(mappedDotted[1]);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateHost([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }

  if (bare.includes(":")) {
    const v6 = bare.toLowerCase().replace(/%.*$/, ""); // strip zone id
    if (v6 === "::" || v6 === "::1") return true;
    const head = v6.split(":")[0];
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true;
    if (/^fe[89ab][0-9a-f]?$/.test(head)) return true;
    return false;
  }

  const octets = bare.split(".");
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map(Number);
    if (octets.some((o) => Number(o) > 255)) return true; // malformed → refuse
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast + reserved
  }

  return false;
}

export function isHttpsSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return !isPrivateHost(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const httpsUrl = z
  .string()
  .max(500)
  .refine(
    isHttpsSafeUrl,
    "Must be a valid https URL without credentials or private host",
  );

const domainName = z
  .string()
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,}$/i,
    "Invalid domain",
  );

const hexColor = z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB");
const e164 = z
  .string()
  .regex(/^\+\d{8,15}$/, "Phone must be E.164 like +233...");

const socialLink = z.object({ platform: z.string().max(40), url: httpsUrl });

const baseSiteBriefV1 = z.object({
  schemaVersion: z.literal(1),
  businessName: z.string().trim().min(2).max(120),
  category: z.string().refine(isCategoryId, "Invalid category"),
  ecomSubcategory: z
    .string()
    .optional()
    .refine((v) => !v || isEcomSubcategoryId(v), "Invalid subcategory"),
  description: z.string().max(2000).optional(),
  tagline: z.string().max(120).optional(),
  preferredColours: z.tuple([hexColor, hexColor, hexColor]).optional(),
  phone: e164.optional(),
  whatsapp: e164.optional(),
  email: z.string().email().max(254).optional(),
  address: z.string().max(500).optional(),
  mapsLink: httpsUrl.optional(),
  hours: z.string().max(500).optional(),
  socialLinks: z.array(socialLink).max(12).default([]),
  serviceAreas: z.array(z.string().max(80)).max(20).default([]),
  deliveryAreas: z.array(z.string().max(80)).max(20).default([]),
  primaryCallToAction: z.string().max(40).optional(),
  services: z.array(z.string().max(80)).max(30).default([]),
  requiredPages: z.array(z.string().max(40)).max(20).default([]),
  specialInstructions: z.string().max(2000).optional(),
  selectedPackage: z.string().refine(isPackageId, "Invalid package"),
  selectedTheme: z.string().refine(isThemeId, "Invalid theme"),
  selectedTemplate: z
    .string()
    .optional()
    .refine((v) => !v || isTemplateId(v), "Invalid template"),
  adminEmail: z.string().email().max(254),
  domainName: domainName.optional(),
  preferredLanguage: z.string().max(20).optional(),
  existingWebsite: httpsUrl.optional(),
  assetStatus: z.literal("not_provided").default("not_provided"),
  products: z
    .array(
      z.object({
        name: z.string().max(80),
        category: z.string().max(40).optional(),
      }),
    )
    .max(50)
    .default([]),
  country: z.string().max(60).default("Ghana"),
  currency: z.string().max(10).default("GHS"),
  timezone: z.string().max(40).default("Africa/Accra"),
  ghanaRegion: z
    .string()
    .max(40)
    .optional()
    .refine((v) => !v || isGhanaRegion(v), "Unknown Ghana region"),
  paymentNotes: z.string().max(500).optional(),
  plannedPaymentMethods: z
    .array(z.enum(["momo", "paystack", "valmont_pay", "card", "bank", "cod"]))
    .max(6)
    .default([])
    .describe("Future planning only — not operational"),
});

/**
 * A layout must actually suit the chosen website type. Without this check the
 * schema would accept `selectedTemplate` values the template registry refuses
 * to render.
 */
export const siteBriefSchemaV1 = baseSiteBriefV1.superRefine((brief, ctx) => {
  if (
    brief.selectedTemplate &&
    !isTemplateCompatible(brief.selectedTemplate, brief.category)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["selectedTemplate"],
      message: "This layout is not available for the chosen website type",
    });
  }
  if (brief.ecomSubcategory && brief.category !== "online-shop") {
    ctx.addIssue({
      code: "custom",
      path: ["ecomSubcategory"],
      message: "A shop subtype only applies to the Online Shop website type",
    });
  }
});

export type SiteBriefV1 = z.infer<typeof baseSiteBriefV1>;

export interface StudioDraft {
  id: string;
  ownerId: string;
  schemaVersion: number;
  templateRegistryVersion: number;
  themeRegistryVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  brief: SiteBriefV1;
}
