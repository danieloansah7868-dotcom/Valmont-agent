import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { DRAFT_BODY_LIMIT_BYTES, readBoundedJson } from "@/lib/bounded-json";

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
      DRAFT_BODY_LIMIT_BYTES,
    )) as Record<string, unknown>;
    const { expectedRevision, ...briefData } = z
      .object({ expectedRevision: z.number().int().min(1) })
      .passthrough()
      .parse(body);
    const brief = siteBriefSchemaV1.parse(briefData);
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
