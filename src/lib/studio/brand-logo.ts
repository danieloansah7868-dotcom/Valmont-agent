/**
 * Stage B — a simple text logo for a brand that has nothing yet.
 *
 * Renders an SVG string deterministically: no network, no fonts fetched, no
 * randomness — the same input always returns the same markup, so the wizard
 * preview (GET logo.svg) and the saved PNG (next/og rasterising this exact
 * string) show the same design. The font stack is the one every computer
 * already carries.
 */
import { HEX_COLOR_RE } from "./themes";
import { readableTextOn } from "./brand-kit";

export const BRAND_LOGO_LAYOUTS = ["wordmark", "badge", "stacked"] as const;
export type BrandLogoLayout = (typeof BRAND_LOGO_LAYOUTS)[number];

export function isBrandLogoLayout(value: unknown): value is BrandLogoLayout {
  return (
    typeof value === "string" &&
    (BRAND_LOGO_LAYOUTS as readonly string[]).includes(value)
  );
}

export const BRAND_LOGO_FONT_STACK = "Inter, Arial, sans-serif";

export interface BrandLogoInput {
  name: string;
  /** 1–3 letters for the badge; derived from the name when not given. */
  initials?: string;
  primary: string;
  accent: string;
  surface: string;
  layout: BrandLogoLayout;
}

/*
 * Canvas sizes. Every rasterised side stays at or below the assets
 * LOGO_MAX_SIDE (600), so a saved logo never exceeds the upload limits a
 * hand-uploaded one must respect. The stack is square; the two banners share
 * one 600×160 canvas.
 */
const SIZES: Record<BrandLogoLayout, { width: number; height: number }> = {
  wordmark: { width: 600, height: 160 },
  badge: { width: 600, height: 160 },
  stacked: { width: 480, height: 480 },
};

/** Pixel size of one layout's canvas (≤ 600 on both axes). */
export function brandLogoSize(layout: BrandLogoLayout): {
  width: number;
  height: number;
} {
  return SIZES[layout];
}

/**
 * Escapes text for SVG element content and attribute values. Every logo is
 * text the agency typed, so anything that would parse as markup becomes
 * entities — a `<script>` in a business name lands as visible text, never as
 * a tag.
 */
export function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A sane colour or the fallback — markup can never be smuggled in a fill. */
function safeColor(value: string, fallback: string): string {
  return HEX_COLOR_RE.test(value) ? value : fallback;
}

/**
 * The badge letters. Given initials win (cleaned to 1–3 letters/digits);
 * otherwise the first letters of the first three words, so "Akwaaba Gold
 * Ventures" becomes "AGV". Uppercase throughout.
 */
export function brandInitials(name: string, initials?: string): string {
  if (initials) {
    const cleaned = initials
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 3)
      .toUpperCase();
    if (cleaned.length > 0) return cleaned;
  }
  const letters = name
    .split(/\s+/)
    .map((word) => word.match(/[A-Za-z0-9]/)?.[0] ?? "")
    .filter(Boolean)
    .slice(0, 3)
    .join("")
    .toUpperCase();
  if (letters.length > 0) return letters;
  return name.slice(0, 1).toUpperCase() || "?";
}

/** Long names shrink instead of overflowing their canvas. */
function nameFontSize(name: string, base: number): number {
  if (name.length <= 16) return base;
  if (name.length <= 24) return Math.round(base * 0.75);
  return Math.round(base * 0.6);
}

/**
 * Roughly how wide the name renders at a given size — for placing the accent
 * dot after the wordmark. Deterministic by design; it is a placement hint,
 * not a measurement.
 */
function estimatedTextWidth(name: string, fontSize: number): number {
  return Math.round(name.length * fontSize * 0.58);
}

function badgeBlocks(
  initials: string,
  cx: number,
  cy: number,
  side: number,
  radius: number,
  fill: string,
  initialsColor: string,
): string {
  const fontSize = Math.round(side * (initials.length >= 3 ? 0.34 : 0.4));
  return [
    `<rect x="${cx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" rx="${radius}" fill="${fill}"/>`,
    `<text x="${cx}" y="${cy + fontSize * 0.34}" text-anchor="middle" font-family="${BRAND_LOGO_FONT_STACK}" font-size="${fontSize}" font-weight="700" fill="${initialsColor}">${initials}</text>`,
  ].join("");
}

/**
 * Renders the logo. All text is escaped; all colours are validated, so the
 * output is always well-formed SVG. The three layouts:
 *
 * - `wordmark` — the name with an accent dot after it.
 * - `badge` — the initials in a rounded square on `primary`, name beside it.
 * - `stacked` — the same badge above the centered name.
 */
export function renderBrandLogo(input: BrandLogoInput): string {
  const { layout } = input;
  const { width, height } = brandLogoSize(layout);
  const primary = safeColor(input.primary, "#0A1F44");
  const accent = safeColor(input.accent, "#E8822B");
  const surface = safeColor(input.surface, "#F8F6F0");
  const name = input.name.trim();
  const escapedName = escapeSvgText(name);
  const initials = escapeSvgText(brandInitials(name, input.initials));
  const nameColor = readableTextOn(surface, primary);
  const initialsColor = readableTextOn(primary);

  const background = `<rect width="${width}" height="${height}" fill="${surface}"/>`;
  let body = "";

  if (layout === "wordmark") {
    const fontSize = nameFontSize(name, 44);
    const textY = height / 2 + fontSize * 0.34;
    const dotX = Math.min(
      width - 20,
      width / 2 + Math.round(estimatedTextWidth(name, fontSize) / 2) + 20,
    );
    body = [
      `<text x="${width / 2}" y="${textY}" text-anchor="middle" font-family="${BRAND_LOGO_FONT_STACK}" font-size="${fontSize}" font-weight="700" fill="${nameColor}">${escapedName}</text>`,
      `<circle cx="${dotX}" cy="${textY - fontSize}" r="7" fill="${accent}"/>`,
    ].join("");
  } else if (layout === "badge") {
    const fontSize = nameFontSize(name, 40);
    body = [
      badgeBlocks(initials, 84, 80, 120, 26, primary, initialsColor),
      `<text x="172" y="${80 + fontSize * 0.34}" font-family="${BRAND_LOGO_FONT_STACK}" font-size="${fontSize}" font-weight="700" fill="${nameColor}">${escapedName}</text>`,
    ].join("");
  } else {
    const fontSize = nameFontSize(name, 34);
    body = [
      badgeBlocks(initials, 240, 128, 160, 32, primary, initialsColor),
      `<text x="240" y="${332 + fontSize * 0.34}" text-anchor="middle" font-family="${BRAND_LOGO_FONT_STACK}" font-size="${fontSize}" font-weight="700" fill="${nameColor}">${escapedName}</text>`,
    ].join("");
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapedName} logo">` +
    background +
    body +
    `</svg>`
  );
}
