import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCsrf } from "@/lib/security";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { readBoundedJson } from "@/lib/bounded-json";

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
    assertApiRateLimit(request, "studio-mutation", 30);
    const { id } = await params;
    const user = await requireApiSessionUser();
    const body = (await readBoundedJson(
      request as unknown as Request,
      1_000_000,
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
    if (e instanceof Error && e.message === "Request body too large")
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("Conflict"))
      return NextResponse.json({ error: msg }, { status: 409 });
    if (msg.includes("Draft not found"))
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    return safeApiError(e);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "studio-mutation", 30);
    const { id } = await params;
    const user = await requireApiSessionUser();
    const ok = await getStudioDraftStore().delete(user, id);
    if (!ok)
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return safeApiError(e);
  }
}
