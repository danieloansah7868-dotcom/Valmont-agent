import { NextResponse, type NextRequest } from "next/server";
import { readBoundedJson } from "@/lib/bounded-json";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { assertCsrf, redactSecrets } from "@/lib/security";
import { BadRequestError } from "@/lib/api-errors";

const memoryInput = z.object({
  content: z.string().trim().min(1).max(1000),
  category: z.enum(["preference", "fact", "decision", "project"]),
  scope: z.enum(["personal", "repository"]),
  repositoryId: z.string().max(120).optional(),
});
export async function GET() {
  try {
    const user = await requireApiSessionUser();
    const store = getChatStore();
    return NextResponse.json({
      memories: await store.memories(user.id),
      enabled: await store.memoryEnabled(user.id),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "memory-write", 20);
    const user = await requireApiSessionUser();
    const input = memoryInput.parse(await readBoundedJson(request, 8_000));
    const content = redactSecrets(input.content);
    if (/\[REDACTED/.test(content))
      throw new BadRequestError("Memories cannot contain secrets");
    const now = new Date().toISOString();
    const memory = {
      id: crypto.randomUUID(),
      userId: user.id,
      scope: input.scope,
      repositoryId:
        input.scope === "repository" ? input.repositoryId : undefined,
      category: input.category,
      content,
      createdAt: now,
      updatedAt: now,
    };
    await getChatStore().addMemory(memory);
    return NextResponse.json({ memory }, { status: 201 });
  } catch (error) {
    return safeApiError(error);
  }
}
export async function PATCH(request: NextRequest) {
  try {
    assertCsrf(request);
    const user = await requireApiSessionUser();
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .parse(await readBoundedJson(request, 8_000));
    await getChatStore().setMemoryEnabled(user.id, enabled);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}
