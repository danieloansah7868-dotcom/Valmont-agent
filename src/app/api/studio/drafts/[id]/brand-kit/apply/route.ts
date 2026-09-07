import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { HEX_COLOR_RE, isThemeId } from "@/lib/studio/themes";
import {
  BRAND_KIT_BODY_LIMIT_BYTES,
  requireBrandKitDraftAccess,
} from "@/lib/studio/brand-kit-routes";

/**
 * POST /api/studio/drafts/[id]/brand-kit/apply
 *
 * The agency clicked "Use this" on a suggestion. Writes exactly the fields
 * the suggestion owns — businessName, tagline, selectedTheme and
 * preferredColours — through the same optimistic-concurrency update path the
 * wizard PATCH uses, and nothing else in the brief changes.
 */
const applyBodySchema = z.object({
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(2).max(120).optional(),
  tagline: z.string().max(120).optional(),
  palette: z
    .object({
      themeId: z.string().refine(isThemeId, "Invalid theme"),
      primary: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
      accent: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
      surface: z.string().regex(HEX_COLOR_RE, "Color must be #RRGGBB"),
    })
    .optional(),
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
    // Draft writes share one modest bucket with the logo save — separate
    // from the wizard autosave budget and from the paid suggest budget.
    assertOwnerRateLimit("brand-kit-write", access.ownerId, 30);

    const body = await readBoundedJson(request, BRAND_KIT_BODY_LIMIT_BYTES);
    const parsed = applyBodySchema.parse(body);

    // Patch only the fields the suggestion owns; every other key of the
    // current brief is carried across verbatim, then the whole brief is
    // re-validated exactly like the wizard's PATCH does.
    const patch: Record<string, unknown> = {};
    if (parsed.name !== undefined) patch.businessName = parsed.name;
    if (parsed.tagline !== undefined) patch.tagline = parsed.tagline;
    if (parsed.palette !== undefined) {
      patch.selectedTheme = parsed.palette.themeId;
      patch.preferredColours = [
        parsed.palette.primary,
        parsed.palette.accent,
        parsed.palette.surface,
      ];
    }

    const nextBrief = siteBriefSchemaV1.parse({
      ...access.draft.brief,
      ...patch,
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
