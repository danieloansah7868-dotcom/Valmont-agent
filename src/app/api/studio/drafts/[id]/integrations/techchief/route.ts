import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedJson, DRAFT_BODY_LIMIT_BYTES } from "@/lib/bounded-json";
import {
  connectTechChief,
  getTechChiefIntegration,
  isTechChiefKeyFormat,
  removeTechChiefIntegration,
  TECHCHIEF_KEY_FORMAT_MESSAGE,
} from "@/lib/studio/integrations";
import {
  requireTechChiefDraftAccess,
  techChiefViewFor,
} from "@/lib/studio/techchief-routes";

/**
 * The shop's own TechChief connection (Stage 5).
 *
 * GET answers with everything the owner may see — status, key prefix, wallet
 * balance, cached bundle count, the items TechChief cannot deliver and the
 * webhook URL to paste into their dashboard — and with **no part of the key**
 * beyond the nine-character prefix. PUT probes TechChief before it stores
 * anything, so a rejected key leaves no row behind and an unreachable API
 * leaves the previous connection untouched. DELETE removes the key.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { draft } = await requireTechChiefDraftAccess(request, id, {
      mutating: false,
    });
    const integration = await getTechChiefIntegration(id);
    return NextResponse.json(techChiefViewFor(draft, integration));
  } catch (error) {
    return safeApiError(error);
  }
}

const putSchema = z.object({
  apiKey: z.string().max(400),
  webhookSecret: z.string().max(400).nullish(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { ownerId, draft } = await requireTechChiefDraftAccess(request, id, {
      mutating: true,
    });

    const body = await readBoundedJson(request, DRAFT_BODY_LIMIT_BYTES);
    const parsed = putSchema.parse(body);

    const apiKey = parsed.apiKey.trim();
    // Format first, so a typo gets the owner's own wording rather than a
    // generic 400 — and never a call to TechChief with a malformed key.
    if (!isTechChiefKeyFormat(apiKey)) {
      return NextResponse.json(
        { error: TECHCHIEF_KEY_FORMAT_MESSAGE },
        { status: 400 },
      );
    }

    const result = await connectTechChief({
      draftId: id,
      ownerId,
      apiKey,
      webhookSecret: parsed.webhookSecret ?? null,
    });

    if (!result.ok) {
      // "unreachable" is our upstream's problem (502); everything else is a
      // key the owner can fix (400). Nothing was stored in either case.
      const status = result.reason === "unreachable" ? 502 : 400;
      return NextResponse.json({ error: result.message }, { status });
    }

    return NextResponse.json(techChiefViewFor(draft, result.integration), {
      status: 200,
    });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireTechChiefDraftAccess(request, id, { mutating: true });
    await removeTechChiefIntegration(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}
