/**
 * Stage B — Brand Kit: AI name and palette suggestions for clients who
 * arrive with no brand yet.
 *
 * Everything here is a suggestion, never a write: this module answers
 * "what could the brand be?" and the agency decides what (if anything) goes
 * into the brief — the only path into the brief is the apply route, which
 * uses the same optimistic-concurrency update the wizard uses.
 *
 * Cost discipline: one model call per suggest, two only when the protected
 * brands filter below removes so many names that fewer than three survive.
 * The route that calls this must therefore hold a tighter than usual budget
 * — {@link assertBrandKitSuggestRateLimit} — because every suggest spends
 * real money.
 */
import { z } from "zod";
import type { ModelMessage, ModelProvider } from "@/lib/models/types";
import { checkRateLimit } from "@/lib/security";
import { RateLimitError } from "@/lib/api-errors";
import { isCategoryId } from "./categories";
import { HEX_COLOR_RE, THEME_IDS, isThemeId, type ThemeId } from "./themes";

/** The four moods the agency can steer the suggestions with. */
export const BRAND_KIT_FEELINGS = [
  "trusted",
  "friendly",
  "premium",
  "young",
] as const;
export type BrandKitFeeling = (typeof BRAND_KIT_FEELINGS)[number];

export function normalizeHexColor(value: string, fallback = "#091534"): string {
  const trimmed = value.trim();
  if (HEX_COLOR_RE.test(trimmed)) return trimmed;
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    const r = trimmed[1],
      g = trimmed[2],
      b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^[0-9A-Fa-f]{6}$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  return fallback;
}

export function normalizeThemeId(value: string): ThemeId {
  const trimmed = value.trim().toLowerCase();
  if (isThemeId(trimmed)) return trimmed;
  for (const tid of THEME_IDS) {
    if (
      tid === trimmed ||
      tid.includes(trimmed) ||
      trimmed.includes(tid) ||
      trimmed.includes(tid.split("-")[0]!)
    ) {
      return tid;
    }
  }
  return "clean-corporate";
}

const hexColor = z
  .string()
  .trim()
  .transform((val) => normalizeHexColor(val, "#091534"))
  .refine((val) => HEX_COLOR_RE.test(val), "Colour must be #RRGGBB");

/**
 * The four questions the wizard asks before suggesting. These — and nothing
 * else — are what the model ever sees: no API keys, no orders, no other
 * drafts. The input is small enough that the prompt stays cheap and the
 * answers stay on-topic.
 */
export const brandKitInputSchema = z.object({
  /** What the business sells or does, in the agency's own words. */
  whatTheySell: z
    .string()
    .trim()
    .min(1, "Say what the business sells")
    .max(300),
  /** The Ghanaian town the business is based in. */
  town: z.string().trim().min(1, "Say which town the business is in").max(60),
  /** The mood the brand should have. */
  feeling: z.enum(BRAND_KIT_FEELINGS),
  /** Up to three short words the name must contain, when the client asks. */
  mustInclude: z.array(z.string().trim().min(1).max(20)).max(3).optional(),
  category: z.string().refine(isCategoryId, "Invalid category"),
  language: z.string().trim().min(2).max(20).default("en"),
});
export type BrandKitInput = z.infer<typeof brandKitInputSchema>;

/**
 * One AI name idea. The name must be letters/digits/spaces/&/' only so it is
 * easy to say on radio and easy to type as a domain — no punctuation tricks,
 * no fancy dashes.
 */
export const brandKitNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .transform((val) => val.replace(/["*]/g, "").trim())
    .refine(
      (val) => /^[A-Za-z0-9 &'. -]+$/.test(val),
      "Name may use letters, digits, spaces, &, ', -, and .",
    ),
  meaning: z
    .string()
    .trim()
    .transform((val) => val.slice(0, 120)),
  tagline: z
    .string()
    .trim()
    .transform((val) => val.slice(0, 80)),
});
export type BrandKitNameIdea = z.infer<typeof brandKitNameSchema>;

/** One AI palette. Every colour is strict #RRGGBB, like the brief itself. */
export const brandKitPaletteSchema = z.object({
  label: z
    .string()
    .trim()
    .transform((val) => val.slice(0, 40) || "Brand Palette"),
  primary: hexColor,
  accent: hexColor,
  surface: hexColor,
  text: hexColor,
  themeId: z.string().trim().transform(normalizeThemeId),
});
export type BrandKitPalette = z.infer<typeof brandKitPaletteSchema>;

/** Exactly what the model is asked for — and all it may answer. */
export const brandKitOutputSchema = z.object({
  names: z.array(brandKitNameSchema).min(1),
  palettes: z.array(brandKitPaletteSchema).min(1),
});
export type BrandKitOutput = z.infer<typeof brandKitOutputSchema>;

/** The JSON schema the model's structured output is constrained with. */
export const BRAND_KIT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["names", "palettes"],
  properties: {
    names: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "meaning", "tagline"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 30 },
          meaning: { type: "string", maxLength: 120 },
          tagline: { type: "string", maxLength: 80 },
        },
      },
    },
    palettes: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "primary", "accent", "surface", "text", "themeId"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 40 },
          primary: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          accent: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          surface: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          text: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          themeId: { type: "string", enum: [...THEME_IDS] },
        },
      },
    },
  },
};

/**
 * Protected brands a fresh Ghanaian business must never be nudged towards:
 * the mobile networks, the national ID card, the post office, and a small
 * list of other names a suggestion must not accidentally copy. The list
 * stays short and deliberate on purpose — it is a hand-maintained guard, not
 * a trademark database, and the README tells the agency to check a name
 * before using it.
 */
export const BLOCKED_BRAND_WORDS = [
  "mtn",
  "vodafone",
  "telecel",
  "airteltigo",
  "at",
  "ghana card",
  "ghanapost",
  "gcb",
  "ecobank",
  "calbank",
  "jumia",
  "melcom",
  "starlink",
] as const;

/**
 * Whether a suggested name copies a protected brand. Matching is word-based
 * so "AT" never blocks "Data" ("at" inside a word is fine, "AT" as a word is
 * not), while squashed forms like "MyMTNShop" still match: the whole name
 * with separators removed is scanned for any term of three letters or more.
 */
export function nameIsBlocked(name: string): boolean {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = tokens.join(" ");
  const squashed = tokens.join("");
  for (const term of BLOCKED_BRAND_WORDS) {
    if (term.includes(" ")) {
      // Multi-word terms ("ghana card") match the token stream as a phrase.
      if (joined.includes(term)) return true;
      continue;
    }
    if (tokens.includes(term)) return true;
    // One- and two-letter terms only match as whole words ("AT "): a
    // squashed substring scan would block innocent names like "Data Hub".
    if (term.length >= 3 && squashed.includes(term)) return true;
  }
  return false;
}

/** Lowercase letters and digits only — for domains, handles and file names. */
export function brandSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The two domains worth reserving, as plain text. Nothing is checked online
 * — the agency opens the check links below by hand and confirms availability
 * before promising anything to the client.
 */
export function domainCandidates(name: string): [string, string] {
  const slug = brandSlug(name);
  return [`${slug}.com`, `${slug}.com.gh`];
}

export interface BrandKitCheckLinks {
  instagram: string;
  tiktok: string;
  whois: string;
}

/**
 * Where the agency can check a name by hand. These are links to open in a
 * browser, never URLs the server fetches — availability checks stay a human
 * decision in Stage B.
 */
export function checkLinks(name: string): BrandKitCheckLinks {
  const slug = brandSlug(name);
  return {
    instagram: `https://www.instagram.com/${slug}/`,
    tiktok: `https://www.tiktok.com/@${slug}`,
    whois: `https://www.whois.com/whois/${slug}.com`,
  };
}

/* --- Readable colours (WCAG contrast) -------------------------------- */

/** WCAG minimum contrast for normal body text (AA). */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a #RRGGBB colour, per WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!match) throw new Error(`Not a #RRGGBB colour: ${hex}`);
  const value = parseInt(match[1]!, 16);
  const r = channelLuminance((value >> 16) & 0xff);
  const g = channelLuminance((value >> 8) & 0xff);
  const b = channelLuminance(value & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #RRGGBB colours (1 = unreadable). */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

const TEXT_FALLBACKS = ["#111827", "#FFFFFF"] as const;

/**
 * The text colour to write on `background`: keeps `preferred` when it reads
 * well, otherwise the first of #111827 / #FFFFFF that reaches WCAG AA, and
 * — for an awkward mid-tone background where neither passes — the better of
 * the two anyway, so a palette never ships its least readable pair.
 */
export function readableTextOn(background: string, preferred?: string): string {
  if (
    preferred &&
    contrastRatio(preferred, background) >= WCAG_AA_TEXT_CONTRAST
  ) {
    return preferred;
  }
  let best: string = TEXT_FALLBACKS[0];
  let bestRatio = -1;
  for (const candidate of TEXT_FALLBACKS) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
    if (ratio >= WCAG_AA_TEXT_CONTRAST) return candidate;
  }
  return best;
}

/**
 * Checks a palette the model suggested before it is offered to the agency:
 * the `text` colour must read on `surface` (body copy), and `readableTextOn`
 * exists for the primary header bar where white text is the usual default.
 * When text-on-surface is below AA the text is swapped for #111827 or
 * #FFFFFF — whichever passes — and never left unreadable.
 */
export function fixPaletteContrast(palette: BrandKitPalette): BrandKitPalette {
  return {
    ...palette,
    text: readableTextOn(palette.surface, palette.text),
  };
}

/** Contrast between white and the palette's primary — the header-bar check. */
export function whiteOnPrimaryContrast(palette: BrandKitPalette): number {
  return contrastRatio("#FFFFFF", palette.primary);
}

/* --- The model call ---------------------------------------------------- */

export const BRAND_KIT_SCHEMA_NAME = "brand_kit_suggestions";
export const BRAND_KIT_TEMPERATURE = 0.8;
export const BRAND_KIT_MAX_TOKENS = 1200;
export const BRAND_KIT_MODEL_TIMEOUT_MS = 20_000;

/**
 * Builds the exact conversation the model sees. Plain, Ghana-flavoured, no
 * emojis, and deliberately free of anything beyond the four answers: no API
 * keys, no orders, no other drafts.
 */
export function brandKitMessages(input: BrandKitInput): ModelMessage[] {
  const mustInclude =
    input.mustInclude && input.mustInclude.length > 0
      ? ` Every name must include one of these words exactly: ${input.mustInclude.join(", ")}.`
      : "";
  const system = [
    "You help small businesses in Ghana invent a brand for the first time.",
    "Invent original names only. Never use the name of a real company, mobile network, bank, government service or public institution — the client could be sued for copying one.",
    "A good answer is easy to say on Ghanaian radio and easy to type as an internet domain: short, spelled the way it sounds, letters and spaces and at most an ampersand.",
    "Write plain English with no emojis.",
  ].join(" ");
  const user = [
    `A business in ${input.town}, Ghana sells: ${input.whatTheySell}.`,
    `Website type: ${input.category}. The brand should feel ${input.feeling}.${mustInclude}`,
    `Use this language for meanings and taglines: ${input.language}.`,
    "Return 5 name ideas. Each needs a name, a one-line meaning, and a short tagline.",
    `Also return 3 colour palettes for the website. For each give a short label, the primary colour, an accent colour, a light surface colour, and a text colour that stays readable on the surface, plus the theme id it suits best from this exact list: ${THEME_IDS.join(", ")}.`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** A name idea enriched with the hand-check links the UI shows beside it. */
export interface BrandKitNameSuggestion extends BrandKitNameIdea {
  slug: string;
  domainCandidates: [string, string];
  checkLinks: BrandKitCheckLinks;
}

/** What a suggest call answers: surviving names and contrast-safe palettes. */
export interface BrandKitSuggestion {
  names: BrandKitNameSuggestion[];
  palettes: BrandKitPalette[];
}

async function askOnce(
  input: BrandKitInput,
  provider: ModelProvider,
): Promise<BrandKitOutput> {
  try {
    const response = await provider.structured({
      schemaName: BRAND_KIT_SCHEMA_NAME,
      jsonSchema: BRAND_KIT_JSON_SCHEMA,
      validate: (value: unknown) => brandKitOutputSchema.parse(value),
      messages: brandKitMessages(input),
      temperature: BRAND_KIT_TEMPERATURE,
      maxTokens: BRAND_KIT_MAX_TOKENS,
      signal: AbortSignal.timeout(BRAND_KIT_MODEL_TIMEOUT_MS),
    });
    return response.data;
  } catch (error) {
    // A model answer that fails validation is a server-side glitch, not a
    // bad request from the agency — reclassify so routes answer 500, while
    // the caller's own invalid input keeps surfacing as the Zod error that
    // becomes a 400.
    if (error instanceof z.ZodError) {
      console.error(
        `[brand-kit] Model output failed schema validation: ${JSON.stringify(error.issues)}`,
      );
      throw new Error(
        "The model returned a brand suggestion we could not use.",
      );
    }
    throw error;
  }
}

/**
 * Answers one Brand Kit suggest request.
 *
 * The model's names pass through two guards before the agency sees them:
 * anything copying a protected brand is dropped, then duplicates collapse.
 * If fewer than three names survive, the model is asked exactly once more
 * and whatever survives in total is returned — the UI can always show fewer
 * cards, but an agency paying for calls should not pay for a third.
 */
export async function suggestBrandKit(
  rawInput: unknown,
  provider: ModelProvider,
): Promise<BrandKitSuggestion> {
  const input = brandKitInputSchema.parse(rawInput);

  const names: BrandKitNameIdea[] = [];
  const seenSlugs = new Set<string>();
  let palettes: BrandKitPalette[] = [];

  const absorb = (batch: BrandKitOutput): void => {
    for (const idea of batch.names) {
      if (nameIsBlocked(idea.name)) continue;
      const key = brandSlug(idea.name) || idea.name.trim().toLowerCase();
      if (seenSlugs.has(key)) continue;
      seenSlugs.add(key);
      names.push(idea);
    }
    if (palettes.length === 0) palettes = batch.palettes;
  };

  absorb(await askOnce(input, provider));
  if (names.length < 3) {
    absorb(await askOnce(input, provider));
  }

  return {
    names: names.slice(0, 5).map((idea) => ({
      ...idea,
      slug: brandSlug(idea.name),
      domainCandidates: domainCandidates(idea.name),
      checkLinks: checkLinks(idea.name),
    })),
    palettes: palettes.map(fixPaletteContrast),
  };
}

/* --- The hourly suggest budget ----------------------------------------- */

/** Suggests one Studio owner may make per hour — model calls cost money. */
export const BRAND_KIT_SUGGESTS_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The suggest-route budget: the same `:owner:` bucket shape as
 * `assertOwnerRateLimit` in @/lib/api, but with an hourly window because a
 * suggest is a paid model call, not a cheap form save. Kept as a wrapper
 * here so the shared API helper stays untouched.
 */
export function assertBrandKitSuggestRateLimit(ownerId: string): void {
  if (!ownerId) throw new RateLimitError();
  if (
    !checkRateLimit(
      `brand-kit:owner:${ownerId}`,
      BRAND_KIT_SUGGESTS_PER_HOUR,
      ONE_HOUR_MS,
    )
  ) {
    throw new RateLimitError();
  }
}
