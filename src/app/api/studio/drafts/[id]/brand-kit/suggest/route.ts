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
 * The model call hit its own abort deadline (BRAND_KIT_MODEL_TIMEOUT_MS): the
 * provider is busy or slow, not broken, so 504 Gateway Timeout is the honest
 * status. The copy says exactly that in plain English — wait a minute, try
 * again. The card appends the "the logo tools below still work" reassurance
 * itself, so this message does not repeat it.
 */
export const BRAND_KIT_TIMEOUT_MESSAGE =
  "The AI is taking too long right now — the model provider is busy or slow. Wait a minute and try again.";

/**
 * An error this route could not classify. It must never leak internals —
 * safeApiError still screens it — but it must not read as a naked shrug
 * either: name that it was unexpected, and that it is safe to retry. A
 * suggest is a read, so a retry can never double-charge or half-write.
 */
export const BRAND_KIT_UNKNOWN_ERROR_MESSAGE =
  "Something unexpected happened on our side. It is safe to try again.";

/**
 * A fetch aborted by its signal rejects with a DOMException named
 * TimeoutError (AbortSignal.timeout, "The operation was aborted due to
 * timeout") or AbortError (AbortController) — either way we stopped waiting,
 * and the agency hears it as a slow provider, not a cryptic abort.
 */
function isModelCallAborted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

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

    // The suggest's own abort deadline: a slow or busy provider, not a broken
    // one — 504 with plain-English retry guidance, never the bare 500 shrug.
    if (isModelCallAborted(error)) {
      return safeApiError(new ApiError(BRAND_KIT_TIMEOUT_MESSAGE, 504));
    }

    // Typed errors (401/403/404/409/429 …), Zod 400s and bad-JSON 400s keep
    // their own status and copy; anything that still slips through gets the
    // route's honest, retry-safe copy — screened for internal detail, never
    // the old "Something went wrong handling that request".
    return safeApiError(error, {
      message: BRAND_KIT_UNKNOWN_ERROR_MESSAGE,
      status: 500,
    });
  }
}
