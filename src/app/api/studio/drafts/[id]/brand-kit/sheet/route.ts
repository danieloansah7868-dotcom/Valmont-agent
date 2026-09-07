import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { safeApiError } from "@/lib/api";
import { brandSlug } from "@/lib/studio/brand-kit";
import {
  BRAND_SHEET_SIZE,
  BrandSheetArt,
  brandSheetDataForBrief,
} from "@/lib/studio/brand-sheet";
import { requireBrandKitDraftAccess } from "@/lib/studio/brand-kit-routes";

/**
 * GET /api/studio/drafts/[id]/brand-kit/sheet
 *
 * The one-page brand sheet as a 1200×1600 PNG: logo, name, tagline, the
 * three colours with hex codes, the font name and "Made with Valmont -
 * valmontweb.com". Owner-only, rendered on the spot with next/og, never
 * stored — so it always matches the draft as it is right now.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await requireBrandKitDraftAccess(request, id, {
      mutating: false,
    });

    const data = brandSheetDataForBrief(access.draft.brief);
    const response = new ImageResponse(BrandSheetArt(data), {
      width: BRAND_SHEET_SIZE.width,
      height: BRAND_SHEET_SIZE.height,
    });
    const png = Buffer.from(await response.arrayBuffer());
    const slug = brandSlug(data.name) || "brand";
    return new Response(png, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${slug}-brand-sheet.png"`,
      },
    });
  } catch (error) {
    return safeApiError(error);
  }
}
