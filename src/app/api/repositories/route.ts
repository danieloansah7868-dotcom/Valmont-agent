import { NextResponse } from "next/server";
import { safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";

export async function GET() {
  try {
    await requireApiSessionUser();
    const provider = await getGitHubProvider();
    return NextResponse.json({
      repositories: await provider.listRepositories(),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
