/**
 * Stage B — the printable brand sheet as next/og markup.
 *
 * A single 1200×1600 portrait canvas: the logo, the name and tagline, the
 * three brand colours with their hex codes, the font stack and the Made
 * with Valmont footer. Rendered on demand by the sheet route and never
 * stored — it always reflects the draft as it is right now.
 */
import type { ReactElement } from "react";
import type { SiteBriefV1 } from "./site-brief/schema";
import { getTheme } from "./themes";
import { readableTextOn } from "./brand-kit";
import { BRAND_LOGO_FONT_STACK } from "./brand-logo";

export const BRAND_SHEET_SIZE = { width: 1200, height: 1600 } as const;

export interface BrandSheetData {
  name: string;
  tagline: string;
  logoDataUrl: string | null;
  colors: { primary: string; accent: string; surface: string };
  fontName: string;
}

/**
 * What the sheet shows for one brief. The agency's chosen palette wins
 * (preferredColours is what the apply route writes); a draft that never
 * picked one falls back to its theme's colours, which are exactly what the
 * preview was already using.
 */
export function brandSheetDataForBrief(brief: SiteBriefV1): BrandSheetData {
  const theme = getTheme(brief.selectedTheme);
  const [primary, accent, surface] = brief.preferredColours ?? [
    theme?.tokens.colors.primary ?? "#0A1F44",
    theme?.tokens.colors.accent ?? "#E8822B",
    theme?.tokens.colors.surface ?? "#F8F6F0",
  ];
  return {
    name: brief.businessName,
    tagline: brief.tagline ?? "",
    logoDataUrl: brief.assets?.logo?.dataUrl ?? null,
    colors: { primary, accent, surface },
    fontName: BRAND_LOGO_FONT_STACK,
  };
}

/** One swatch: a block in the colour and its hex code underneath. */
function Swatch({
  label,
  hex,
  textColor,
}: {
  label: string;
  hex: string;
  textColor: string;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 320 }}>
      <div
        style={{
          display: "flex",
          height: 220,
          borderRadius: 24,
          background: hex,
          border: "2px solid rgba(0,0,0,0.12)",
        }}
      />
      <div
        style={{
          display: "flex",
          marginTop: 24,
          fontSize: 34,
          fontWeight: 700,
          color: textColor,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", fontSize: 30, color: textColor }}>
        {hex.toUpperCase()}
      </div>
    </div>
  );
}

/** The full sheet as a React element for `new ImageResponse(...)`. */
export function BrandSheetArt(data: BrandSheetData): ReactElement {
  const { primary, accent, surface } = data.colors;
  const text = readableTextOn(surface);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: surface,
        fontFamily: BRAND_LOGO_FONT_STACK,
        padding: 80,
      }}
    >
      <div
        style={{
          display: "flex",
          height: 420,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 32,
          border: `2px solid ${accent}`,
          background: surface,
        }}
      >
        {data.logoDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.logoDataUrl}
            alt={data.name}
            style={{ maxWidth: "80%", maxHeight: "75%" }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              fontSize: 96,
              fontWeight: 700,
              color: primary,
            }}
          >
            {data.name}
            <div
              style={{
                display: "flex",
                width: 28,
                height: 28,
                borderRadius: 14,
                background: accent,
                marginLeft: 10,
                marginTop: 12,
              }}
            />
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 64,
          fontSize: 76,
          fontWeight: 800,
          color: primary,
        }}
      >
        {data.name}
      </div>
      {data.tagline ? (
        <div
          style={{ display: "flex", marginTop: 24, fontSize: 40, color: text }}
        >
          {data.tagline}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          marginTop: 72,
          justifyContent: "space-between",
        }}
      >
        <Swatch label="Primary" hex={primary} textColor={text} />
        <Swatch label="Accent" hex={accent} textColor={text} />
        <Swatch label="Surface" hex={surface} textColor={text} />
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 72,
          fontSize: 40,
          fontWeight: 700,
          color: text,
        }}
      >
        Font
      </div>
      <div style={{ display: "flex", fontSize: 34, color: text }}>
        {data.fontName}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: "auto",
          fontSize: 30,
          color: text,
        }}
      >
        Made with Valmont - valmontweb.com
      </div>
    </div>
  );
}
