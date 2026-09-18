import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { ApiError, ConfigurationError } from "@/lib/api-errors";
import { tryCreateModelProvider } from "@/lib/models";
import { ModelProviderError } from "@/lib/models/openai-compatible";
import { redactSecrets } from "@/lib/security";
import {
  assertBrandKitSuggestRateLimit,
  suggestBrandKit,
} from "@/lib/studio/brand-kit";
import {
  BRAND_KIT_BODY_LIMIT_BYTES,
  requireBrandKitDraftAccess,
} from "@/lib/studio/brand-kit-routes";

export const BRAND_KIT_MODEL_NOT_CONFIGURED_MESSAGE =
  "MODEL_API_KEY is not configured. Visit Settings (/settings) to configure your model provider.";

/**
 * POST /api/studio/drafts/[id]/brand-kit/suggest
 *
 * Answers { names[], palettes[] } for the wizard's "Brand kit" sidebar
 * card. Suggestions only — nothing here is written to the brief.
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
      // sample brand, only an honest "not configured" with actionable location.
      throw new ConfigurationError(BRAND_KIT_MODEL_NOT_CONFIGURED_MESSAGE);
    }

    const suggestion = await suggestBrandKit(body, provider);
    return NextResponse.json({
      names: suggestion.names,
      palettes: suggestion.palettes,
    });
  } catch (error) {
    const errorClass =
      error instanceof Error ? error.constructor.name : typeof error;
    const rawMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[brand-kit/suggest] ${errorClass}: ${redactSecrets(rawMessage)}`,
    );

    if (error instanceof ModelProviderError) {
      return safeApiError(
        new ApiError(
          "The model provider failed to generate brand suggestions. Check your model settings in Settings (/settings) or try again.",
          502,
        ),
      );
    }

    if (
      error instanceof Error &&
      error.message ===
        "The model returned a brand suggestion we could not use."
    ) {
      return safeApiError(new ApiError(error.message, 502));
    }

    return safeApiError(error);
  }
}
