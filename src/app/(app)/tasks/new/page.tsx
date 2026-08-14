import { NewTaskForm } from "@/components/new-task-form";
import { ConnectPrompt, ErrorState } from "@/components/states";
import { requireSessionUser, tryGetGitHubProvider } from "@/lib/auth";
import { missingLiveRequirements } from "@/lib/config";
import type { RepositorySummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ repository?: string }>;
}) {
  await requireSessionUser();
  const [params, provider] = await Promise.all([
    searchParams,
    tryGetGitHubProvider(),
  ]);

  let repositories: RepositorySummary[] = [];
  let loadError = "";
  if (provider) {
    try {
      repositories = await provider.listRepositories();
    } catch (error) {
      loadError =
        error instanceof Error
          ? error.message
          : "Repositories could not be retrieved from GitHub.";
    }
  }

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-7 sm:px-7 sm:py-9">
      <p className="text-[12px] font-bold tracking-[0.1em] text-copper uppercase">
        New agent task
      </p>
      <h1 className="mt-1.5 text-[29px] font-bold tracking-[-0.035em] text-navy">
        What would you like to change?
      </h1>
      <p className="mt-2 mb-7 max-w-2xl text-sm leading-6 text-slate">
        Valmont will inspect the selected repository and return a plan for your
        approval. Nothing is modified before you approve.
      </p>

      {!provider ? (
        <ConnectPrompt
          title="Connect GitHub before creating a task"
          description="A task needs an authorized repository. Connect your GitHub account to continue."
          missing={missingLiveRequirements()}
        />
      ) : loadError ? (
        <ErrorState title="GitHub request failed" description={loadError} />
      ) : (
        <NewTaskForm
          repositories={repositories}
          initialRepositoryId={params.repository}
        />
      )}
    </div>
  );
}
