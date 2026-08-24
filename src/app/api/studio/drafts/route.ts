import { NextResponse, type NextRequest } from "next/server";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { readBoundedJson } from "@/lib/bounded-json";
// Phase 2: briefs can include embedded image data URLs, so allow a
// larger payload on draft creation/updates.
const BRIEF_BODY_LIMIT_BYTES = 2_500_000; // ~2.5 MB

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
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("studio-mutation", canonicalUserId(user), 30);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BRIEF_BODY_LIMIT_BYTES,
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
