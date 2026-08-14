import { NextResponse } from "next/server";
import { getGitHubProvider } from "@/lib/auth";
import { safeApiError } from "@/lib/api";

export async function GET() {
  try {
    const provider = await getGitHubProvider();
    return NextResponse.json({
      repositories: await provider.listRepositories(),
      demo: provider.demo,
    });
  } catch (error) {
    return safeApiError(error);
  }
}
