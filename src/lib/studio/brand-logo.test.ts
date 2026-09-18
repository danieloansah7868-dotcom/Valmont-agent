/**
 * Stage B — the deterministic text-logo renderer. Pure string assertions:
 * same input, same SVG, no network, all text escaped.
 * Now with icons and font choices — still instant + offline, inline SVG only.
 */
import { describe, expect, it } from "vitest";
import {
  BRAND_LOGO_FONTS,
  BRAND_LOGO_ICONS,
  BRAND_LOGO_LAYOUTS,
  brandInitials,
  brandLogoFontById,
  brandLogoSize,
  escapeSvgText,
  isBrandLogoFontId,
  isBrandLogoIcon,
  isBrandLogoLayout,
  renderBrandLogo,
} from "./brand-logo";

const INPUT = {
  name: "Akwaaba Ventures",
  primary: "#0A1F44",
  accent: "#E8822B",
  surface: "#F8F6F0",
} as const;

describe("renderBrandLogo — the three layouts", () => {
  it("renders a wordmark: name with an accent dot, no badge", () => {
    const svg = renderBrandLogo({ ...INPUT, layout: "wordmark" });
    expect(svg).toContain("Akwaaba Ventures");
    expect(svg).toContain("circle");
    expect(svg).toContain(INPUT.accent);
    expect(svg).toContain(INPUT.surface);
    // Font stack now comes from chosen font — default modern still contains Inter
    expect(svg).toContain(`font-family="`);
    expect(svg).toContain("Inter");
    expect(svg).not.toContain(">AV</text>");
  });

  it("renders a badge: derived initials in a rounded square beside the name", () => {
    const svg = renderBrandLogo({ ...INPUT, layout: "badge" });
    expect(svg).toContain(">AV</text>");
    expect(svg).toContain("Akwaaba Ventures");
    expect(svg).toContain('rx="26"');
    expect(svg).toContain(INPUT.primary);
  });

  it("renders a stacked logo: badge above the centered name", () => {
    const svg = renderBrandLogo({ ...INPUT, layout: "stacked" });
    expect(svg).toContain(">AV</text>");
    expect(svg).toContain("Akwaaba Ventures");
    expect(svg).toContain('width="480" height="480"');
  });

  it("uses explicit initials when given, cleaned and truncated to three", () => {
    const svg = renderBrandLogo({
      ...INPUT,
      initials: "nhy1!",
      layout: "badge",
    });
    expect(svg).toContain(">NHY</text>");
    expect(svg).not.toContain(">AV</text>");
  });

  it("is deterministic — identical input, byte-identical SVG", () => {
    const first = renderBrandLogo({ ...INPUT, layout: "badge" });
    const second = renderBrandLogo({ ...INPUT, layout: "badge" });
    expect(second).toBe(first);
  });

  it("stays within the 600px logo canvas on every layout", () => {
    for (const layout of BRAND_LOGO_LAYOUTS) {
      const { width, height } = brandLogoSize(layout);
      expect(width).toBeLessThanOrEqual(600);
      expect(height).toBeLessThanOrEqual(600);
    }
  });

  it("keeps white initials off a light badge — the on-primary contrast rule", () => {
    const svg = renderBrandLogo({
      ...INPUT,
      primary: "#C9A96A", // pale gold: white text would be unreadable
      layout: "stacked",
    });
    expect(svg).toContain('fill="#111827">AV</text>');
  });
});

describe("renderBrandLogo — icons and fonts", () => {
  it("renders all icon+font+layout combos as valid XML with escaped name", () => {
    for (const icon of BRAND_LOGO_ICONS) {
      for (const font of BRAND_LOGO_FONTS) {
        for (const layout of BRAND_LOGO_LAYOUTS) {
          const svg = renderBrandLogo({
            ...INPUT,
            layout,
            icon,
            font: font.id,
            name: `Adom & Sons <Test>`,
          });
          // Valid XML: starts with <svg and ends with </svg>
          expect(svg.startsWith("<svg")).toBe(true);
          expect(svg.endsWith("</svg>")).toBe(true);
          // Escaped name — no raw <script> or unescaped &
          expect(svg).not.toContain("<Test>");
          expect(svg).toContain("Adom &amp; Sons &lt;Test&gt;");
          // Font stack appears
          expect(svg).toContain(font.stack.split(",")[0]!.trim().replace(/'/g, "").slice(0, 6));
          // Icon path appears only in badge layouts when icon != none
          if (icon !== "none" && layout !== "wordmark") {
            expect(svg).toContain("<path");
          }
        }
      }
    }
  });

  it("icon appears in badge layouts next to/above name, not in wordmark", () => {
    const badge = renderBrandLogo({
      ...INPUT,
      layout: "badge",
      icon: "fish",
      font: "modern",
    });
    expect(badge).toContain("<path");
    // Fish path contains Q or M
    expect(badge).toContain("M3 12");

    const stacked = renderBrandLogo({
      ...INPUT,
      layout: "stacked",
      icon: "bolt",
      font: "classic",
    });
    expect(stacked).toContain("<path");
    expect(stacked).toContain("M13 2");

    const wordmark = renderBrandLogo({
      ...INPUT,
      layout: "wordmark",
      icon: "fish",
      font: "modern",
    });
    // Wordmark ignores icon — should not contain icon path, only circle dot
    expect(wordmark).not.toContain("M3 12");
    expect(wordmark).toContain("<circle");
  });

  it("font choices use safe cross-platform stacks", () => {
    for (const font of BRAND_LOGO_FONTS) {
      const svg = renderBrandLogo({
        ...INPUT,
        layout: "badge",
        font: font.id,
      });
      expect(svg).toContain(`font-family="${font.stack}"`);
      expect(svg).toContain(`font-weight="${font.weight}"`);
    }
    expect(BRAND_LOGO_FONTS.length).toBeGreaterThanOrEqual(3);
    expect(BRAND_LOGO_FONTS.length).toBeLessThanOrEqual(5);
  });

  it("recognises all icons and fonts", () => {
    for (const icon of BRAND_LOGO_ICONS) {
      expect(isBrandLogoIcon(icon)).toBe(true);
    }
    expect(isBrandLogoIcon("unicorn")).toBe(false);
    for (const font of BRAND_LOGO_FONTS) {
      expect(isBrandLogoFontId(font.id)).toBe(true);
    }
    expect(isBrandLogoFontId("comic")).toBe(false);
  });

  it("brandLogoFontById falls back to modern", () => {
    expect(brandLogoFontById("modern").id).toBe("modern");
    expect(brandLogoFontById("unknown").id).toBe("modern");
  });
});

describe("renderBrandLogo — escaping", () => {
  const NASTY = `<script>alert("x")</script>"'`;

  it("escapes a script tag and quotes into entities, never a raw tag", () => {
    for (const layout of BRAND_LOGO_LAYOUTS) {
      const svg = renderBrandLogo({ ...INPUT, name: NASTY, layout });
      expect(svg).not.toContain("<script>");
      expect(svg).not.toContain("</script>");
      expect(svg).toContain("&lt;script&gt;");
      expect(svg).toContain("&quot;");
      expect(svg).toContain("&#39;");
      // No raw double quote inside the escaped text can survive.
      expect(svg).not.toContain(`alert("x")`);
    }
  });

  it("escapes the ampersand first so entities are not double-escaped", () => {
    const svg = renderBrandLogo({
      ...INPUT,
      name: "A & B <C>",
      layout: "wordmark",
    });
    expect(svg).toContain("A &amp; B &lt;C&gt;");
    expect(svg).not.toContain("&amp;lt;");
    expect(svg).not.toContain("&amp;quot;");
  });

  it("produces a script-free aria-label too", () => {
    const svg = renderBrandLogo({ ...INPUT, name: NASTY, layout: "wordmark" });
    const label = svg.match(/aria-label="([^"]*)"/);
    expect(label).not.toBeNull();
    expect(label![1]).not.toContain("<script>");
    expect(label![1]).toContain("&lt;script&gt;");
  });
});

describe("small helpers", () => {
  it("derives initials from the first letters of up to three words", () => {
    expect(brandInitials("Akwaaba Gold Ventures")).toBe("AGV");
    expect(brandInitials("Akwaaba Ventures")).toBe("AV");
    expect(brandInitials("adom")).toBe("A");
    expect(brandInitials("A & B Trading")).toBe("ABT");
  });

  it("falls back to the name for a name with no usable words", () => {
    expect(brandInitials("123", "")).toBe("1");
  });

  it("escapes every SVG-significant character", () => {
    expect(escapeSvgText(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });

  it("recognises exactly the three layouts", () => {
    expect(isBrandLogoLayout("wordmark")).toBe(true);
    expect(isBrandLogoLayout("badge")).toBe(true);
    expect(isBrandLogoLayout("stacked")).toBe(true);
    expect(isBrandLogoLayout("banner")).toBe(false);
    expect(isBrandLogoLayout(null)).toBe(false);
  });
});
