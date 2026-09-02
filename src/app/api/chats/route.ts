import { NextResponse, type NextRequest } from "next/server";
import { readBoundedJson } from "@/lib/bounded-json";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { assertCsrf } from "@/lib/security";
import { BadRequestError } from "@/lib/api-errors";

const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const chatInput = z
  .object({
    title: z.string().trim().max(120).optional(),
    repositoryId: z.string().min(1).max(120).optional(),
    baseBranch: z.string().regex(branchPattern).optional(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.repositoryId) !== Boolean(value.baseBranch)) {
      context.addIssue({
        code: "custom",
        message: "Select both a repository and branch, or start a general chat",
      });
    }
  });

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    return NextResponse.json({ sessions: await getChatStore().list(user.id) });
  } catch (error) {
    return safeApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "create-chat", 15);
    const input = chatInput.parse(await readBoundedJson(request, 16_000));
    const user = await requireApiSessionUser();
    const store = getChatStore();
    let repository;

    if (input.repositoryId && input.baseBranch) {
      const github = await getGitHubProvider();
      const repositories = await github.listRepositories();
      const selected = repositories.find(
        (item) => item.id === input.repositoryId,
      );
      if (!selected)
        throw new BadRequestError("Select an authorized repository");
      const branches = await github.listBranches(selected.owner, selected.name);
      if (!branches.includes(input.baseBranch)) {
        throw new BadRequestError("Select a valid base branch");
      }
      repository = {
        id: selected.id,
        owner: selected.owner,
        name: selected.name,
        fullName: selected.fullName,
        baseBranch: input.baseBranch,
      };
    }

    const session = await store.create({
      userId: user.id,
      title: input.title,
      repository,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return safeApiError(error);
  }
}
