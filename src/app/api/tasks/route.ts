import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { createModelProvider } from "@/lib/models";
import { assertCsrf } from "@/lib/security";
import { getTaskStore } from "@/lib/task-store";
import { TaskWorkflowService } from "@/lib/workflow";

const taskInput = z.object({
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(8_000),
  repositoryId: z.string().min(1).max(120),
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
});

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    return NextResponse.json({ tasks: await getTaskStore(user).list() });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "create-task", 10);
    const input = taskInput.parse(await request.json());
    const user = await requireApiSessionUser();
    const github = await getGitHubProvider();
    const repositories = await github.listRepositories();
    const repository = repositories.find(
      (item) => item.id === input.repositoryId,
    );
    if (!repository) throw new Error("Select an authorized repository");
    const branches = await github.listBranches(
      repository.owner,
      repository.name,
    );
    if (!branches.includes(input.baseBranch))
      throw new Error("Select a valid base branch");
    const model = createModelProvider();
    const workflow = new TaskWorkflowService(getTaskStore(user), github, model);
    const task = await workflow.create({
      ...input,
      userId: user.id,
      repositoryName: repository.fullName,
      demo: github.demo || model.demo || user.demo,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return safeApiError(error);
  }
}
