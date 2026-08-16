import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { assertCsrf } from "@/lib/security";
const message = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
  createdAt: z.string().datetime(),
  model: z.string().max(200).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
const backup = z.object({
  version: z.literal(1),
  sessions: z
    .array(
      z.object({
        id: z.string().uuid(),
        userId: z.string().max(200),
        title: z.string().max(120),
        repository: z
          .object({
            id: z.string().max(120),
            owner: z.string().max(120),
            name: z.string().max(120),
            fullName: z.string().max(250),
            baseBranch: z.string().max(200),
          })
          .optional(),
        messages: z.array(message).max(100000),
        // Optional for v1 backups produced before archive metadata existed.
        archivedAt: z.string().datetime().optional(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(10000),
  memories: z
    .array(
      z.object({
        id: z.string().uuid(),
        scope: z.enum(["personal", "repository"]),
        repositoryId: z.string().max(120).optional(),
        category: z.enum(["preference", "fact", "decision", "project"]),
        content: z.string().max(1000),
        sourceSessionId: z.string().uuid().optional(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100000),
  memoryEnabled: z.boolean().optional(),
});
export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "memory-import", 5);
    const size = Number(request.headers.get("content-length") ?? 0);
    if (size > 25_000_000) throw new Error("Backup is too large");
    const user = await requireApiSessionUser();
    const input = backup.parse(await request.json());
    await getChatStore().importUser(user.id, input);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return safeApiError(error);
  }
}
