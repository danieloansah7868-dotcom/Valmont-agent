import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";
import { TaskNotFoundError } from "@/lib/api-errors";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const user = await requireApiSessionUser();
    const task = await getTaskStore(user).get(id);
    if (!task) throw new TaskNotFoundError();
    return NextResponse.json({ task });
  } catch (error) {
    return safeApiError(error);
  }
}
