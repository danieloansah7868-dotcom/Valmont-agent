import { createElement } from "react";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ImageResponse } from "next/og";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { HEX_COLOR_RE } from "@/lib/studio/themes";
import {
  validateUploadedImage,
  checkAssetBudget,
} from "@/lib/studio/asset-validation";
import {
  brandLogoSize,
  isBrandLogoLayout,
  renderBrandLogo,
} from "@/lib/studio/brand-logo";
import { brandSlug } from "@/lib/studio/brand-kit";
import {
  BRAND_KIT_BODY_LIMIT_BYTES,
  requireBrandKitDraftAccess,
} from "@/lib/studio/brand-kit-routes";

/**
 * POST /api/studio/drafts/[id]/brand-kit/logo
 *
 * Renders the chosen text-logo layout, rasterises it to PNG with next/og
 * (the same library the opengraph image uses, never larger than the 600px
 * logo limit), and saves it into brief.assets.logo exactly like a hand
 * upload through /assets does — the same validation helper, the same budget
 * check, the same optimistic-concurrency update.
 */
const logoBodySchema = z.object({
  expectedRevision: z.number().int().min(1),
  layout: z.string().refine(isBrandLogoLayout, "Unknown logo layout"),
  name: z.string().trim().min(2).max(60),
  initials: z.string().trim().max(3).optional(),
  palette: z.object({
    primary: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
    accent: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
    surface: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
  }),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await requireBrandKitDraftAccess(request, id, {
      mutating: true,
    });
    assertOwnerRateLimit("brand-kit-write", access.ownerId, 30);

    const body = await readBoundedJson(request, BRAND_KIT_BODY_LIMIT_BYTES);
    const parsed = logoBodySchema.parse(body);

    const svg = renderBrandLogo({
      name: parsed.name,
      initials: parsed.initials,
      primary: parsed.palette.primary,
      accent: parsed.palette.accent,
      surface: parsed.palette.surface,
      layout: parsed.layout,
    });
    const { width, height } = brandLogoSize(parsed.layout);

    // Rasterise the exact SVG string the live preview showed, so what the
    // agency saw is what gets stored.
    const response = new ImageResponse(
      createElement(
        "div",
        { style: { display: "flex", width: "100%", height: "100%" } },
        createElement("img", {
          src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
          width,
          height,
        }),
      ),
      { width, height },
    );
    const png = Buffer.from(await response.arrayBuffer());

    const slug = brandSlug(parsed.name) || "brand";
    const image = validateUploadedImage({
      kind: "logo",
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      fileName: `${slug}-logo.png`,
      mime: "image/png",
      width,
      height,
    });

    const currentAssets = access.draft.brief.assets ?? {
      logo: null,
      photos: [],
    };
    checkAssetBudget(currentAssets, { kind: "logo", size: image.size });

    const nextBrief = siteBriefSchemaV1.parse({
      ...access.draft.brief,
      assets: { ...currentAssets, logo: image },
    });
    const updated = await getStudioDraftStore().update(
      access.user,
      id,
      nextBrief,
      parsed.expectedRevision,
    );
    return NextResponse.json(updated);
  } catch (error) {
    return safeApiError(error);
  }
}
