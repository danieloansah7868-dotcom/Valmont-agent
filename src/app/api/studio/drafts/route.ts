import { NextResponse, type NextRequest } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { z } from "zod";
import { assertCsrf } from "@/lib/security";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    const drafts = await getStudioDraftStore().list(user);
    return NextResponse.json({ drafts });
  } catch (e) {
    return safeApiError(e);
  }
}

const createSchema = siteBriefSchemaV1;

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "studio-mutation", 30);
    const size = Number(request.headers.get("content-length") ?? 0);
    if (size > 1_000_000) throw new Error("Request body too large");
    const user = await requireApiSessionUser();
    const body = await request.json();
    const brief = createSchema.parse(body);
    const draft = await getStudioDraftStore().create(user, brief);
    return NextResponse.json(draft, { status: 201 });
  } catch (e) {
    return safeApiError(e);
  }
}
