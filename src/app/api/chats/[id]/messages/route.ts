import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { chatTitleFromMessage, generateChatReply } from "@/lib/chat";
import { getChatStore } from "@/lib/chat-store";
import { retrieveGitHubContext } from "@/lib/github-retrieval";
import { createModelProvider } from "@/lib/models";
import { assertCsrf } from "@/lib/security";

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
    if (!session) throw new Error("Chat not found");

    let repositoryContext;
    if (session.repository) {
      const github = await getGitHubProvider();
      const repositories = await github.listRepositories();
      const authorized = repositories.find(
        (repository) => repository.id === session.repository?.id,
      );
      if (
        !authorized ||
        authorized.owner !== session.repository.owner ||
        authorized.name !== session.repository.name
      ) {
        throw new Error("The chat repository is no longer authorized");
      }
      const branches = await github.listBranches(
        authorized.owner,
        authorized.name,
      );
      if (!branches.includes(session.repository.baseBranch)) {
        throw new Error("The chat branch is no longer available");
      }
      const retrieved = await retrieveGitHubContext(
        github,
        authorized.owner,
        authorized.name,
        session.repository.baseBranch,
        input.content,
        8,
      );
      repositoryContext = {
        repository: session.repository,
        files: retrieved.files,
      };
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
