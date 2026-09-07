import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { ConfigurationError } from "@/lib/api-errors";
import {
  MODEL_NOT_CONFIGURED_MESSAGE,
  tryCreateModelProvider,
} from "@/lib/models";
import {
  assertBrandKitSuggestRateLimit,
  suggestBrandKit,
} from "@/lib/studio/brand-kit";
import {
  BRAND_KIT_BODY_LIMIT_BYTES,
  requireBrandKitDraftAccess,
} from "@/lib/studio/brand-kit-routes";

/**
 * POST /api/studio/drafts/[id]/brand-kit/suggest
 *
 * Answers { names[], palettes[] } for the wizard's "No brand yet? Create
 * one" card. Suggestions only — nothing here is written to the brief.
 *
 * Every suggest is one paid model call (two only when protected-brand
 * filtering leaves fewer than three names), so the hourly budget runs before
 * the provider is even looked at, and a website without the package/add-on
 * is refused before a pesewa is spent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await requireBrandKitDraftAccess(request, id, {
      mutating: true,
    });
    assertBrandKitSuggestRateLimit(access.ownerId);

    const body = await readBoundedJson(request, BRAND_KIT_BODY_LIMIT_BYTES);

    const provider = tryCreateModelProvider();
    if (!provider) {
      // Valmont is live-only: without credentials there is no fabricated
      // sample brand, only an honest "not configured".
      throw new ConfigurationError(MODEL_NOT_CONFIGURED_MESSAGE);
    }

    const suggestion = await suggestBrandKit(body, provider);
    return NextResponse.json({
      names: suggestion.names,
      palettes: suggestion.palettes,
    });
  } catch (error) {
    return safeApiError(error);
  }
}
