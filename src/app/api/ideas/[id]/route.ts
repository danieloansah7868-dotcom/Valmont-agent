import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf, redactSecrets } from "@/lib/security";
import { BadRequestError, NotFoundError } from "@/lib/api-errors";
import { getIdeaStore, IDEA_PRIORITIES, IDEA_STATUSES } from "@/lib/idea-store";

const ideaPatch = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    details: z.string().trim().max(4000).optional(),
    status: z.enum(IDEA_STATUSES).optional(),
    priority: z.coerce.number().int().min(1).max(3).optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.details !== undefined ||
      value.status !== undefined ||
      value.priority !== undefined,
    { message: "Nothing to update" },
  );

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "idea-write", 30);
    const user = await requireApiSessionUser();
    const { id } = await context.params;
    const input = ideaPatch.parse(await readBoundedJson(request, 16_000));
    const title =
      input.title === undefined ? undefined : redactSecrets(input.title);
    const details =
      input.details === undefined ? undefined : redactSecrets(input.details);
    if (
      (title !== undefined && /\[REDACTED/.test(title)) ||
      (details !== undefined && /\[REDACTED/.test(details))
    ) {
      throw new BadRequestError("Ideas cannot contain secrets");
    }
    const idea = await getIdeaStore().update(user.id, id, {
      title,
      details,
      status: input.status,
      priority:
        input.priority === undefined
          ? undefined
          : (input.priority as (typeof IDEA_PRIORITIES)[number]),
    });
    if (!idea) throw new NotFoundError("Idea not found");
    return NextResponse.json({ idea }, { status: 200 });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "idea-write", 30);
    const user = await requireApiSessionUser();
    const { id } = await context.params;
    const removed = await getIdeaStore().remove(user.id, id);
    if (!removed) throw new NotFoundError("Idea not found");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}
