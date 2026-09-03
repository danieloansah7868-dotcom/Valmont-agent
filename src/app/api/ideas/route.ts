import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf, redactSecrets } from "@/lib/security";
import { BadRequestError } from "@/lib/api-errors";
import { getIdeaStore, IDEA_PRIORITIES, IDEA_STATUSES } from "@/lib/idea-store";

const ideaInput = z.object({
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().max(4000).optional(),
  status: z.enum(IDEA_STATUSES).optional(),
  priority: z.coerce.number().int().min(1).max(3).optional(),
});

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    const ideas = await getIdeaStore().list(user.id);
    return NextResponse.json({ ideas });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "idea-write", 30);
    const user = await requireApiSessionUser();
    const input = ideaInput.parse(await readBoundedJson(request, 16_000));
    const title = redactSecrets(input.title);
    const details = redactSecrets(input.details ?? "");
    if (/\[REDACTED/.test(title) || /\[REDACTED/.test(details)) {
      throw new BadRequestError("Ideas cannot contain secrets");
    }
    const idea = await getIdeaStore().create(user.id, {
      title,
      details,
      status: input.status,
      priority: (input.priority as (typeof IDEA_PRIORITIES)[number]) ?? 2,
    });
    return NextResponse.json({ idea }, { status: 201 });
  } catch (error) {
    return safeApiError(error);
  }
}
