import { NextResponse, type NextRequest } from "next/server";
import { assertCsrf } from "@/lib/security";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { DRAFT_BODY_LIMIT_BYTES, readBoundedJson } from "@/lib/bounded-json";

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    const drafts = await getStudioDraftStore().list(user);
    return NextResponse.json({ drafts });
  } catch (e) {
    return safeApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "studio-mutation", 30);
    const user = await requireApiSessionUser();
    const body = (await readBoundedJson(
      request as unknown as Request,
      DRAFT_BODY_LIMIT_BYTES,
    )) as unknown;
    const brief = siteBriefSchemaV1.parse(body);
    const draft = await getStudioDraftStore().create(user, brief);
    return NextResponse.json(draft, { status: 201 });
  } catch (e) {
    // safeApiError honours the status carried by PayloadTooLargeError (413),
    // DraftConflictError (409) and DraftNotFoundError (404).
    return safeApiError(e);
  }
}
