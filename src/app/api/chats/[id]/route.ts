import { NextResponse, type NextRequest } from "next/server";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { assertCsrf } from "@/lib/security";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const user = await requireApiSessionUser();
    const session = await getChatStore().get(id, user.id);
    if (!session) throw new Error("Chat not found");
    return NextResponse.json({ session });
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
    assertApiRateLimit(request, "delete-chat", 20);
    const { id } = await context.params;
    const user = await requireApiSessionUser();
    const deleted = await getChatStore().delete(id, user.id);
    if (!deleted) throw new Error("Chat not found");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "archive-chat", 20);
    const { action } = (await request.json()) as { action?: string };
    if (action !== "archive") throw new Error("Unsupported chat action");
    const { id } = await context.params;
    const user = await requireApiSessionUser();
    if (!(await getChatStore().archive(id, user.id)))
      throw new Error("Chat not found");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}
