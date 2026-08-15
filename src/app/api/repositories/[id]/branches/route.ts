import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await requireApiSessionUser();
    const provider = await getGitHubProvider();
    const repositories = await provider.listRepositories();
    const repository = repositories.find((item) => item.id === id);
    if (!repository) throw new Error("Select an authorized repository");

    const branches = await provider.listBranches(
      repository.owner,
      repository.name,
    );
    return NextResponse.json({
      branches,
      defaultBranch: repository.defaultBranch,
    });
  } catch (error) {
    return safeApiError(error);
  }
}
