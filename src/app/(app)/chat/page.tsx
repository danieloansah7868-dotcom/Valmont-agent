import { ChatWorkspace } from "@/components/chat-workspace";
import { requireSessionUser, tryGetGitHubProvider } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import type { RepositorySummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await requireSessionUser();
  const sessions = await getChatStore().list(user.id);
  const github = await tryGetGitHubProvider();
  let repositories: RepositorySummary[] = [];
  let repositoryLoadError = "";

  if (github) {
    try {
      repositories = await github.listRepositories();
    } catch (error) {
      repositoryLoadError =
        error instanceof Error
          ? error.message
          : "Repository options could not be loaded.";
    }
  }

  return (
    <ChatWorkspace
      repositories={repositories}
      repositoryLoadError={repositoryLoadError}
      sessions={sessions}
    />
  );
}
