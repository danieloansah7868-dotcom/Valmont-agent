import { NextResponse, type NextRequest } from "next/server";
import { assertCsrf } from "@/lib/security";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { siteBriefSchemaV1 } from "@/lib/studio/site-brief/schema";
import { readBoundedJson } from "@/lib/bounded-json";

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
      1_000_000,
    )) as unknown;
    const brief = siteBriefSchemaV1.parse(body);
    const draft = await getStudioDraftStore().create(user, brief);
    return NextResponse.json(draft, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === "Request body too large")
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    return safeApiError(e);
  }
}
