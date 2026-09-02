import { NextResponse, type NextRequest } from "next/server";
import { readBoundedJson } from "@/lib/bounded-json";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";

const repositoryInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[A-Za-z0-9_.-]+$/,
      "Repository names may contain letters, numbers, periods, hyphens, and underscores",
    )
    .refine((name) => name !== "." && name !== "..", "Invalid repository name"),
  description: z.string().trim().max(350).optional(),
  visibility: z.enum(["private", "public"]).default("private"),
});

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

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "create-repository", 5);
    const input = repositoryInput.parse(await readBoundedJson(request, 8_000));
    await requireApiSessionUser();
    const provider = await getGitHubProvider();
    const repository = await provider.createRepository({
      ...input,
      description: input.description || undefined,
    });
    return NextResponse.json({ repository }, { status: 201 });
  } catch (error) {
    return safeApiError(error);
  }
}
