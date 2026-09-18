/**
 * Stage B — a simple text logo for a brand that has nothing yet.
 *
 * Renders an SVG string deterministically: no network, no fonts fetched, no
 * randomness — the same input always returns the same markup, so the wizard
 * preview (GET logo.svg) and the saved PNG (next/og rasterising this exact
 * string) show the same design. The font stack is the one every computer
 * already carries, now with a choice of 5 safe stacks and a curated icon set
 * for common Ghana business types. All rendering stays inline SVG only.
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

/** Font style choices — safe cross-platform stacks, no web-font fetch. */
export const BRAND_LOGO_FONTS = [
  {
    id: "modern",
    label: "Modern sans",
    stack: "Inter, ui-sans-serif, system-ui, -apple-system, Arial, sans-serif",
    weight: "700",
  },
  {
    id: "classic",
    label: "Classic serif",
    stack: "Georgia, 'Times New Roman', Times, serif",
    weight: "700",
  },
  {
    id: "display",
    label: "Bold display",
    stack: "'Arial Black', Arial, sans-serif",
    weight: "900",
  },
  {
    id: "rounded",
    label: "Friendly rounded",
    stack:
      "'Segoe UI Rounded', 'Nunito', 'Helvetica Rounded', Arial, sans-serif",
    weight: "700",
  },
  {
    id: "mono",
    label: "Clean mono",
    stack: "ui-monospace, 'Cascadia Code', Menlo, monospace",
    weight: "700",
  },
] as const;

export type BrandLogoFontId = (typeof BRAND_LOGO_FONTS)[number]["id"];

export function isBrandLogoFontId(value: unknown): value is BrandLogoFontId {
  return (
    typeof value === "string" &&
    (BRAND_LOGO_FONTS as readonly { id: string }[]).some((f) => f.id === value)
  );
}

export function brandLogoFontById(id: string): (typeof BRAND_LOGO_FONTS)[number] {
  return (
    BRAND_LOGO_FONTS.find((f) => f.id === id) ?? BRAND_LOGO_FONTS[0]!
  );
}

/** Curated icons for common Ghana business types — simple inline SVG glyphs. */
export const BRAND_LOGO_ICONS = [
  "none",
  "fish",
  "chicken",
  "bolt",
  "scissors",
  "house",
  "bag",
  "book",
  "car",
  "leaf",
  "mortar",
] as const;

export type BrandLogoIcon = (typeof BRAND_LOGO_ICONS)[number];

export function isBrandLogoIcon(value: unknown): value is BrandLogoIcon {
  return (
    typeof value === "string" &&
    (BRAND_LOGO_ICONS as readonly string[]).includes(value)
  );
}

/**
 * Simple 24x24 viewBox path data for each icon. Paths are deliberately short
 * and use only M, L, Q, C, A, H, V, Z so they stay valid XML and render at
 * any size via a transform. Fill is set by the caller.
 */
export const BRAND_LOGO_ICON_PATHS: Record<BrandLogoIcon, string> = {
  none: "",
  // Fish — body + tail + eye
  fish: "M3 12 Q8 6 14 12 Q8 18 3 12 Z M14 12 L21 9 L21 15 Z M7.5 10.5 A1 1 0 1 1 7.5 10.6 Z",
  // Chicken / food — simple bird / drumstick silhouette
  chicken:
    "M12 4 C14.5 4 16.5 6 16.5 9 C16.5 11.5 14.8 13 13 13.8 L13 20 H11 V13.8 C9.2 13 7.5 11.5 7.5 9 C7.5 6 9.5 4 12 4 Z M10 9 A1 1 0 1 1 10.1 9 Z",
  // Bolt / electrical — lightning
  bolt: "M13 2 L3 14 H11 L9 22 L21 10 H13 L13 2 Z",
  // Scissors / salon — two loops + cross
  scissors:
    "M6 6 A3 3 0 1 0 6 12 A3 3 0 0 0 6 6 Z M18 6 A3 3 0 1 0 18 12 A3 3 0 0 0 18 6 Z M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5",
  // House
  house: "M12 3 L3 12 H6 V21 H10 V14 H14 V21 H18 V12 H21 L12 3 Z",
  // Shopping bag
  bag: "M6 8 H18 L17 20 H7 L6 8 Z M9 8 V6 A3 3 0 0 1 15 6 V8",
  // Book / school
  book: "M4 4 H14 V20 H4 A1 1 0 0 1 3 19 V5 A1 1 0 0 1 4 4 Z M14 4 H18 A1 1 0 0 1 19 5 V19 A1 1 0 0 1 18 20 H14 Z",
  // Car
  car: "M3 13 L5 8 H19 L21 13 V19 H3 V13 Z M7 17 A1.5 1.5 0 1 0 7.1 17 Z M17 17 A1.5 1.5 0 1 0 17.1 17 Z M5 13 H19",
  // Leaf
  leaf: "M12 2 C7 6 4 10 12 22 C20 10 17 6 12 2 Z M12 22 V12",
  // Mortar / pharmacy — bowl + pestle
  mortar:
    "M5 13 Q5 19 12 19 Q19 19 19 13 H5 Z M9 17 L7 21 H17 L15 17 Z M12 5 L16 9 L14 11 L10 7 L12 5 Z",
};

export interface BrandLogoInput {
  name: string;
  /** 1–3 letters for the badge; derived from the name when not given. */
  initials?: string;
  primary: string;
  accent: string;
  surface: string;
  layout: BrandLogoLayout;
  icon?: BrandLogoIcon;
  font?: BrandLogoFontId;
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

/** Render an icon glyph centered at (cx,cy) with given size and fill. */
function iconGlyph(
  icon: BrandLogoIcon,
  cx: number,
  cy: number,
  size: number,
  fill: string,
): string {
  if (icon === "none") return "";
  const path = BRAND_LOGO_ICON_PATHS[icon];
  if (!path) return "";
  const scale = size / 24;
  // Use <g> transform to center 24x24 viewBox at cx,cy
  return `<g transform="translate(${cx} ${cy}) scale(${scale}) translate(-12 -12)"><path d="${path}" fill="${fill}" stroke="${fill}" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

function badgeBlocks(
  initials: string,
  icon: BrandLogoIcon,
  cx: number,
  cy: number,
  side: number,
  radius: number,
  fill: string,
  initialsColor: string,
  fontFamily: string,
  fontWeight: string,
): string {
  const hasIcon = icon !== "none";
  const rect = `<rect x="${cx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" rx="${radius}" fill="${fill}"/>`;
  if (!hasIcon) {
    const fontSize = Math.round(side * (initials.length >= 3 ? 0.34 : 0.4));
    return [
      rect,
      `<text x="${cx}" y="${cy + fontSize * 0.34}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${initialsColor}">${initials}</text>`,
    ].join("");
  }
  // With icon: icon on top, initials below inside same badge
  const iconSize = Math.round(side * 0.42);
  const iconCy = cy - Math.round(side * 0.18);
  const initialsFontSize = Math.round(side * 0.26);
  const initialsCy = cy + Math.round(side * 0.32);
  return [
    rect,
    iconGlyph(icon, cx, iconCy, iconSize, initialsColor),
    `<text x="${cx}" y="${initialsCy + initialsFontSize * 0.34}" text-anchor="middle" font-family="${fontFamily}" font-size="${initialsFontSize}" font-weight="${fontWeight}" fill="${initialsColor}">${initials}</text>`,
  ].join("");
}

/**
 * Renders the logo. All text is escaped; all colours are validated, so the
 * output is always well-formed SVG. The three layouts:
 *
 * - `wordmark` — the name with an accent dot after it.
 * - `badge` — the initials (and optional icon) in a rounded square on `primary`, name beside it.
 * - `stacked` — the same badge above the centered name.
 *
 * Icons only appear in badge layouts, per brief.
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
  const icon = input.icon && isBrandLogoIcon(input.icon) ? input.icon : "none";
  const fontMeta = brandLogoFontById(input.font ?? "modern");
  const fontFamily = fontMeta.stack;
  const fontWeight = fontMeta.weight;

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
      `<text x="${width / 2}" y="${textY}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${nameColor}">${escapedName}</text>`,
      `<circle cx="${dotX}" cy="${textY - fontSize}" r="7" fill="${accent}"/>`,
    ].join("");
  } else if (layout === "badge") {
    const fontSize = nameFontSize(name, 40);
    body = [
      badgeBlocks(
        initials,
        icon,
        84,
        80,
        120,
        26,
        primary,
        initialsColor,
        fontFamily,
        fontWeight,
      ),
      `<text x="172" y="${80 + fontSize * 0.34}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${nameColor}">${escapedName}</text>`,
    ].join("");
  } else {
    const fontSize = nameFontSize(name, 34);
    body = [
      badgeBlocks(
        initials,
        icon,
        240,
        128,
        160,
        32,
        primary,
        initialsColor,
        fontFamily,
        fontWeight,
      ),
      `<text x="240" y="${332 + fontSize * 0.34}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${nameColor}">${escapedName}</text>`,
    ].join("");
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapedName} logo">` +
    background +
    body +
    `</svg>`
  );
}
