import { z } from "zod";
import { redactPaymentData, redactSecrets } from "@/lib/redact";
import { isCategoryId, isEcomSubcategoryId } from "../categories";
import { isPackageId } from "../packages";
import { isTemplateId, isTemplateCompatible } from "../templates";
import { isThemeId, HEX_COLOR_RE } from "../themes";
import { isGhanaRegion } from "./defaults";
import { ACCEPTED_MIME_TYPES } from "../assets";

export const SITE_BRIEF_VERSION = 1 as const;

/**
 * A stored image (logo or photo). Images are kept as data URLs inside the
 * brief so backup/import carries them automatically and no filesystem or
 * binary column is required. Size/shape checks live in ../assets.ts.
 */
const storedImageSchema = z.object({
  dataUrl: z
    .string()
    .max(1_600_000, "Image is too large")
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/, "Image must be a data URL"),
  fileName: z.string().max(200),
  mime: z
    .string()
    .refine((v) => ACCEPTED_MIME_TYPES.has(v), "Unsupported image type"),
  width: z.number().int().min(1).max(4000),
  height: z.number().int().min(1).max(4000),
  size: z.number().int().min(1).max(1_500_000),
});

const assetsSchema = z
  .object({
    logo: storedImageSchema.nullable().default(null),
    photos: z.array(storedImageSchema).max(8).default([]),
  })
  .default({ logo: null, photos: [] });

/**
 * Every IPv4 block that is not ordinary public unicast, as a
 * `[firstAddress, prefixLength]` pair. Classifying by prefix rather than by
 * hand-written octet comparisons is what stops ranges being missed one at a
 * time: adding a block here is a single line and cannot be half-applied.
 *
 * Source: IANA IPv4 Special-Purpose Address Registry.
 */
const IPV4_RESERVED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this host on this network"
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2 documentation
  ["203.0.113.0", 24], // TEST-NET-3 documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255 broadcast
];

/** Parse strict dotted-quad IPv4 into a 32-bit number, or null if it is not one. */
function parseIpv4(value: string): number | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    // Reject empty, non-numeric, over-long and leading-zero forms outright.
    // WHATWG `URL` has already normalised decimal/octal/hex notations before
    // this point, so anything still irregular here is not a valid address.
    if (!/^\d{1,3}$/.test(octet)) return null;
    const n = Number(octet);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

function isReservedIpv4(address: number): boolean {
  for (const [base, bits] of IPV4_RESERVED) {
    const baseAddress = parseIpv4(base);
    if (baseAddress === null) continue;
    // A /0 mask would shift by 32, which is undefined for `<<` in JS.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((address & mask) >>> 0 === (baseAddress & mask) >>> 0) return true;
  }
  return false;
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null if malformed. */
function parseIpv6(value: string): number[] | null {
  let text = value.toLowerCase().replace(/%.*$/, ""); // drop any zone id

  // A trailing dotted-quad (::ffff:1.2.3.4, ::1.2.3.4) becomes two groups.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const embedded = parseIpv4(dotted[1]);
    if (embedded === null) return null;
    const hi = (embedded >>> 16).toString(16);
    const lo = (embedded & 0xffff).toString(16);
    text = `${text.slice(0, dotted.index)}:${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));

  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0]);
    const tail = toGroups(halves[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...tail];
  } else {
    groups = toGroups(halves[0]);
  }

  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0))
    return null;
  return groups;
}

/**
 * Every IPv4 address an IPv6 literal might be carrying.
 *
 * The transition mechanisms all park an IPv4 address somewhere inside a v6
 * address, and each has its own prefix:
 *
 * - `::ffff:a.b.c.d`   IPv4-mapped (RFC 4291)
 * - `::a.b.c.d`        IPv4-compatible, deprecated but still parsed
 * - `::ffff:0:a.b.c.d` SIIT translated form (RFC 2765), an extra zero word
 * - `64:ff9b::a.b.c.d` well-known NAT64 prefix (RFC 6052)
 * - `64:ff9b:1::/48`   local-use NAT64 (RFC 8215)
 * - `2002:a.b.c.d::`   6to4, where the address sits in groups 1-2 instead
 *
 * A gateway that understands any of these will happily carry the packet to the
 * embedded destination, so the embedded address is what actually matters. This
 * returns candidates, not certainties: the caller tests each against the
 * reserved-IPv4 list, and a public embedded address simply fails that test.
 */
function embeddedIpv4Candidates(groups: number[]): number[] {
  const join = (hi: number, lo: number) => (((hi << 16) | lo) >>> 0) >>> 0;
  const zeros = (upto: number) => groups.slice(0, upto).every((g) => g === 0);
  const candidates: number[] = [];

  // Anything whose leading words are all zero is a mapped/compatible/SIIT
  // form; the address is always in the final two words.
  if (zeros(5) && (groups[5] === 0xffff || groups[5] === 0)) {
    candidates.push(join(groups[6], groups[7]));
  }
  // SIIT `::ffff:0:a.b.c.d` — zero, then ffff, then a zero filler word.
  if (zeros(4) && groups[4] === 0xffff && groups[5] === 0) {
    candidates.push(join(groups[6], groups[7]));
  }
  // NAT64. RFC 6052 does not put the IPv4 address in a fixed place: its
  // position depends on the prefix length, and bits 64-71 are a reserved
  // suffix byte the address skips over. The well-known 64:ff9b::/96 keeps it
  // in the final two words, but local-use 64:ff9b:1::/48 splits it across
  // bits 48-63 and 72-95 — words 3 and 4 with a byte-straddle. An earlier fix
  // only read the last two words, so a /48-embedded loopback slipped through
  // while a public address sat in the tail. Judge every documented position.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    // /96 form: 64:ff9b::a.b.c.d — words 2-5 are zero. Reading the tail
    // unconditionally also mis-flagged a /48 address whose padding tail is
    // 0.0.0.0 (a reserved value) even when the real payload was public.
    if (
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0
    ) {
      candidates.push(join(groups[6], groups[7]));
    }
    // /48 form: 64:ff9b:1:AABB:CC:DD00:: — bits 48-63 then 72-95.
    if (groups[2] === 0x0001) {
      const high = groups[3]; // bits 48-63  -> a.b
      const mid = groups[4]; // bits 64-79  -> reserved byte, then c
      const low = groups[5]; // bits 80-95  -> d, then padding
      candidates.push(
        (((high << 16) | ((mid & 0x00ff) << 8) | ((low >> 8) & 0xff)) >>>
          0) as number,
      );
    }
  }
  // 6to4 puts the IPv4 address immediately after the 2002 prefix.
  if (groups[0] === 0x2002) {
    candidates.push(join(groups[1], groups[2]));
  }
  // Teredo (RFC 4380) 2001:0::/32 carries the client's IPv4 in the final two
  // words, obfuscated by XOR with all-ones. The server's IPv4 sits in words
  // 2-3 unobfuscated. Both are real destinations, so both are judged.
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    candidates.push(join(groups[2], groups[3]));
    candidates.push((join(groups[6], groups[7]) ^ 0xffffffff) >>> 0);
  }
  return candidates;
}

function isReservedIpv6(groups: number[]): boolean {
  const [g0] = groups;
  const isZeroPrefix = groups.slice(0, 7).every((g) => g === 0);

  if (isZeroPrefix && groups[7] === 1) return true; // ::1 loopback
  if (groups.every((g) => g === 0)) return true; // :: unspecified

  // Several IPv6 forms carry an IPv4 address inside them. Judging only the
  // outer literal lets `[::ffff:0:7f00:1]` or `[64:ff9b::7f00:1]` smuggle
  // 127.0.0.1 past a check that is looking for loopback. Rather than listing
  // the encodings one at a time and missing the next one, extract every
  // candidate IPv4 address any of these forms could be expressing and refuse
  // the host if *any* of them is reserved.
  for (const address of embeddedIpv4Candidates(groups)) {
    if (isReservedIpv4(address)) return true;
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && (groups[1] & 0xfff0) === 0x0db0) return true; // 2001:db8::/32 docs
  return false;
}

/**
 * True when `host` must not be linked to: a loopback, private, link-local,
 * multicast, or otherwise non-public destination.
 *
 * Phase 1 never server-fetches a user-supplied URL — these values are only ever
 * rendered as `<a href>` — so this is a link-safety check, not a complete SSRF
 * defence. It judges only literal addresses and known-local names. A public
 * hostname that *resolves* to a private address still gets through, so anything
 * that later fetches one of these URLs must re-check at connect time, after DNS
 * resolution and on every redirect hop. Do not treat this function as
 * sufficient on its own.
 */
function isPrivateHost(host: string): boolean {
  // IPv6 arrives from URL.hostname wrapped in brackets.
  let bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // A trailing dot is the DNS root label: "localhost." resolves exactly like
  // "localhost". Strip it so the name checks below cannot be stepped around.
  bare = bare.replace(/\.+$/, "").toLowerCase();

  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  // Reserved for loopback by RFC 6761 and commonly mapped to 127.0.0.1.
  if (bare === "localhost.localdomain") return true;

  if (bare.includes(":")) {
    const groups = parseIpv6(bare);
    // An unparseable IPv6 literal is refused rather than allowed through.
    return groups === null ? true : isReservedIpv6(groups);
  }

  const address = parseIpv4(bare);
  if (address !== null) return isReservedIpv4(address);

  // Not a literal address — an ordinary hostname.
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

/**
 * Free text the owner types, cleaned on the way in.
 *
 * Anything a person can type freely is passed through the same secret
 * redaction used for chat, plus a payment-detail pass. This keeps the promise
 * in `docs/SECURITY.md` honest at the point of storage rather than relying on
 * people never pasting the wrong thing. It is a safety net with real limits:
 * see the note beside the claim in that document.
 */
const freeText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => redactPaymentData(redactSecrets(value)));

const baseSiteBriefV1 = z.object({
  schemaVersion: z.literal(1),
  businessName: z.string().trim().min(2).max(120),
  category: z.string().refine(isCategoryId, "Invalid category"),
  ecomSubcategory: z
    .string()
    .optional()
    .refine((v) => !v || isEcomSubcategoryId(v), "Invalid subcategory"),
  description: freeText(2000).optional(),
  tagline: freeText(120).optional(),
  preferredColours: z.tuple([hexColor, hexColor, hexColor]).optional(),
  phone: e164.optional(),
  whatsapp: e164.optional(),
  email: z.string().email().max(254).optional(),
  address: freeText(500).optional(),
  mapsLink: httpsUrl.optional(),
  hours: freeText(500).optional(),
  socialLinks: z.array(socialLink).max(12).default([]),
  serviceAreas: z.array(freeText(80)).max(20).default([]),
  deliveryAreas: z.array(freeText(80)).max(20).default([]),
  primaryCallToAction: freeText(40).optional(),
  services: z.array(freeText(80)).max(30).default([]),
  requiredPages: z.array(freeText(40)).max(20).default([]),
  specialInstructions: freeText(2000).optional(),
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
  assets: assetsSchema,
  products: z
    .array(
      z.object({
        name: freeText(80),
        category: freeText(40).optional(),
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
  paymentNotes: freeText(500).optional(),
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
