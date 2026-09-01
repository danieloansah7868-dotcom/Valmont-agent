import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { chatTitleFromMessage, generateChatReply } from "@/lib/chat";
import { getChatStore } from "@/lib/chat-store";
import {
  retrieveChatRepositoryContext,
  retrievePinnedRepositoryFiles,
} from "@/lib/github-retrieval";
import { createModelProvider } from "@/lib/models";
import { assertCsrf } from "@/lib/security";
import { BadRequestError, ChatNotFoundError } from "@/lib/api-errors";

const messageInput = z.object({
  content: z.string().trim().min(1).max(8_000),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "chat-message", 30);
    const { id } = await context.params;
    const input = messageInput.parse(await request.json());
    const user = await requireApiSessionUser();
    const store = getChatStore();
    const session = await store.get(id, user.id);
    if (!session) throw new ChatNotFoundError();

    let repositoryContext;
    if (session.repository) {
      try {
        const github = await getGitHubProvider();
        try {
          const snapshot = await Promise.race([
            retrieveChatRepositoryContext(
              github,
              session.repository.owner,
              session.repository.name,
              session.repository.baseBranch,
              input.content,
            ),
            new Promise<never>((_, reject) => {
              setTimeout(
                () =>
                  reject(new BadRequestError("Repository context timed out")),
                15_000,
              );
            }),
          ]);
          repositoryContext = {
            repository: session.repository,
            files: snapshot.files,
            paths: snapshot.paths,
          };
        } catch {
          const files = await retrievePinnedRepositoryFiles(
            github,
            session.repository.owner,
            session.repository.name,
            session.repository.baseBranch,
          );
          repositoryContext = {
            repository: session.repository,
            files,
            paths: files.map((file) => file.path),
          };
        }
      } catch {
        repositoryContext = {
          repository: session.repository,
          files: [],
        };
      }
    }

    const memoryStore = store as typeof store & {
      summary?: typeof store.summary;
      search?: typeof store.search;
      memories?: typeof store.memories;
      memoryEnabled?: typeof store.memoryEnabled;
    };
    const [summary, olderMessages, memories, memoryEnabled] = await Promise.all(
      [
        memoryStore.summary?.(session.id, user.id) ?? "",
        memoryStore.search?.(user.id, input.content, session.repository?.id) ??
          [],
        memoryStore.memories?.(user.id, session.repository?.id) ?? [],
        memoryStore.memoryEnabled?.(user.id) ?? false,
      ],
    );
    const longTermContext = memoryEnabled
      ? [
          summary ? `Conversation summary (user-authored):\n${summary}` : "",
          memories.length
            ? `Saved memories:\n${memories.map((memory) => `- ${memory.category}: ${memory.content}`).join("\n")}`
            : "",
          olderMessages.length
            ? `Relevant older messages:\n${olderMessages.map((message) => `${message.role}: ${message.content}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : summary;

    const reply = await generateChatReply({
      model: createModelProvider(),
      session,
      userContent: input.content,
      repositoryContext,
      longTermContext,
    });
    const titleIfNew =
      session.title === "New conversation"
        ? chatTitleFromMessage(reply.userMessage.content)
        : undefined;
    const saved = await store.appendMessages(
      session.id,
      user.id,
      [reply.userMessage, reply.assistantMessage],
      titleIfNew,
    );

    return NextResponse.json({
      session: saved,
      userMessage: reply.userMessage,
      assistantMessage: reply.assistantMessage,
    });
  } catch (error) {
    return safeApiError(error);
  }
}
