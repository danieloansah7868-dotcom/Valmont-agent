import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { readBoundedJson } from "@/lib/bounded-json";
// Phase 2: briefs can include embedded image data URLs, so allow a
// larger payload on the update endpoint.
const BRIEF_BODY_LIMIT_BYTES = 2_500_000; // ~2.5 MB

/**
 * Stage 6c — keeps the shop's pause ticks across an agency save.
 *
 * The wizard has no notion of `paused` (it is the shop owner's flag, set from
 * the shop admin), so its autosaves arrive without the key. Without this
 * carry-over every wizard save would silently unpause every paused bundle;
 * with it, an incoming item with NO `paused` key inherits the stored item's
 * value (matched by id), while an item that explicitly carries the key — or
 * no longer exists — is left exactly as sent.
 */
function carryOverPausedFlags(
  incoming: Record<string, unknown>,
  stored:
    { items?: Array<{ id: string; paused?: boolean }> } | null | undefined,
): Record<string, unknown> {
  if (!stored || !Array.isArray(incoming.items)) return incoming;
  const pausedIds = new Set(
    (stored.items ?? [])
      .filter((item) => item.paused === true)
      .map((item) => item.id),
  );
  if (pausedIds.size === 0) return incoming;
  return {
    ...incoming,
    items: incoming.items.map((item) =>
      item &&
      typeof item === "object" &&
      !("paused" in item) &&
      pausedIds.has((item as { id: unknown }).id as string)
        ? { ...item, paused: true }
        : item,
    ),
  };
}

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const user = await requireApiSessionUser();
    const draft = await getStudioDraftStore().get(user, id);
    if (!draft)
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    return NextResponse.json(draft);
  } catch (e) {
    return safeApiError(e);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("studio-mutation", canonicalUserId(user), 30);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BRIEF_BODY_LIMIT_BYTES,
    )) as Record<string, unknown>;
    const { expectedRevision, ...briefData } = z
      .object({ expectedRevision: z.number().int().min(1) })
      .passthrough()
      .parse(body);
    // Stage 6c: keep the shop's `paused` flags when the wizard autosave
    // omits them (see carryOverPausedFlags above), then validate as usual.
    const stored = await getStudioDraftStore().get(user, id);
    const brief = siteBriefSchemaV1.parse(
      carryOverPausedFlags(briefData, stored?.brief ?? null),
    );
    const draft = await getStudioDraftStore().update(
      user,
      id,
      brief,
      expectedRevision,
    );
    return NextResponse.json(draft);
  } catch (e) {
    // Statuses come from the error type, not from words in its message.
    return safeApiError(e);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("studio-mutation", canonicalUserId(user), 30);
    const ok = await getStudioDraftStore().delete(user, id);
    if (!ok)
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return safeApiError(e);
  }
}
