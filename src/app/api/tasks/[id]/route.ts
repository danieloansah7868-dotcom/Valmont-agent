import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const user = await getSessionUser();
    const task = await getTaskStore(user).get(id);
    if (!task) throw new Error("Task not found");
    return NextResponse.json({ task });
  } catch (error) {
    return safeApiError(error);
  }
}
