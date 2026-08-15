import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { getTaskStore } from "@/lib/task-store";
import { TaskWorkflowService } from "@/lib/workflow";

const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve_plan") }),
  z.object({ action: z.literal("reject_plan") }),
  z.object({ action: z.literal("approve_final") }),
  z.object({ action: z.literal("reject_final") }),
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "task-action", 20);
    const { id } = await context.params;
    const input = actionInput.parse(await request.json());
    const user = await requireApiSessionUser();
    const store = getTaskStore(user);
    const existing = await store.get(id);
    if (!existing) throw new Error("Task not found");
    const github = await getGitHubProvider();
    const workflow = new TaskWorkflowService(store, github);
    const task =
      input.action === "approve_plan"
        ? await workflow.approvePlan(id, user.id)
        : input.action === "reject_plan"
          ? await workflow.reject(id, "plan", user.id)
          : input.action === "approve_final"
            ? await workflow.approveFinal(id, user.id)
            : await workflow.reject(id, "final", user.id);
    return NextResponse.json({ task });
  } catch (error) {
    return safeApiError(error);
  }
}
