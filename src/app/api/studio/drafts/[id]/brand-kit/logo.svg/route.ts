import { NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { HEX_COLOR_RE } from "@/lib/studio/themes";
import { isBrandLogoLayout, renderBrandLogo } from "@/lib/studio/brand-logo";
import { requireBrandKitDraftAccess } from "@/lib/studio/brand-kit-routes";

/**
 * GET /api/studio/drafts/[id]/brand-kit/logo.svg?layout=&name=&primary=&accent=&surface=
 *
 * The wizard's live logo preview: the same deterministic renderer the save
 * route uses, served as SVG. Owner-only and never cached, because the query
 * carries a draft's business name.
 */
const querySchema = z.object({
  layout: z.string().refine(isBrandLogoLayout, "Unknown logo layout"),
  name: z.string().trim().min(2).max(60),
  primary: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
  accent: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
  surface: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireBrandKitDraftAccess(request, id, { mutating: false });

    const query = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = querySchema.parse(query);

    const svg = renderBrandLogo({
      name: parsed.name,
      primary: parsed.primary,
      accent: parsed.accent,
      surface: parsed.surface,
      layout: parsed.layout,
    });
    return new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return safeApiError(error);
  }
}
