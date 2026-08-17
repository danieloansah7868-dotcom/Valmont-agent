import { z } from "zod";
import { isCategoryId, isEcomSubcategoryId } from "../categories";
import { isPackageId } from "../packages";
import { isTemplateId, isTemplateCompatible } from "../templates";
import { isThemeId, HEX_COLOR_RE } from "../themes";
import { isGhanaRegion } from "./defaults";

export const SITE_BRIEF_VERSION = 1 as const;

/**
 * True for a plain https link to a public host. Blocks other protocols, links
 * carrying a username/password, and addresses that point back inside the
 * network (localhost, private ranges, the cloud metadata address). Exported so
 * the preview can apply exactly the same rule before rendering a link.
 */
export function isHttpsSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host === "169.254.169.254"
    )
      return false;
    return true;
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
