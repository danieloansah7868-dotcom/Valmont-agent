import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { assertCsrf } from "@/lib/security";
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "memory-write", 20);
    const user = await requireApiSessionUser();
    const { id } = await context.params;
    const { content } = z
      .object({ content: z.string().trim().min(1).max(1000) })
      .parse(await request.json());
    if (!(await getChatStore().updateMemory(id, user.id, content)))
      throw new Error("Memory not found");
    return new NextResponse(null, { status: 204 });
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
    assertApiRateLimit(request, "memory-write", 20);
    const user = await requireApiSessionUser();
    const { id } = await context.params;
    if (!(await getChatStore().forgetMemory(id, user.id)))
      throw new Error("Memory not found");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}
