import Link from "next/link";
import {
  ExternalLink,
  FolderGit2,
  Github,
  Lock,
  Search,
  Unlock,
} from "lucide-react";
import { CreateRepositoryForm } from "@/components/create-repository-form";
import {
  ConnectPrompt,
  EmptyState,
  ErrorState,
  PageHeading,
} from "@/components/states";
import { requireSessionUser, tryGetGitHubProvider } from "@/lib/auth";
import { missingLiveRequirements } from "@/lib/config";
import type { RepositorySummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  await requireSessionUser();
  const provider = await tryGetGitHubProvider();

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
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-7 sm:py-9">
      <PageHeading
        eyebrow="Source control"
        title="Connected repositories"
        description="Create a repository or choose one already authorized through your GitHub account."
        actions={
          <Link href="/api/auth/github" className="btn-secondary">
            <Github className="size-4" aria-hidden="true" /> Refresh
            authorization
          </Link>
        }
      />

      {!provider ? (
        <div className="mt-7">
          <ConnectPrompt
            title="Connect GitHub to list your repositories"
            description="Valmont reads only the repositories your GitHub account authorizes. Nothing is listed until you connect."
            missing={missingLiveRequirements()}
          />
        </div>
      ) : loadError ? (
        <div className="mt-7">
          <ErrorState
            title="GitHub request failed"
            description={loadError}
            action={
              <Link href="/api/auth/github" className="btn-secondary text-xs">
                Reconnect GitHub
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <CreateRepositoryForm />

          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">Search repositories</span>
              <Search
                className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                className="input pl-10"
                placeholder="Search authorized repositories…"
              />
            </label>
            <select
              className="select w-full sm:w-44"
              aria-label="Filter repositories"
              defaultValue="all"
            >
              <option value="all">All repositories</option>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>

          {repositories.length === 0 ? (
            <div className="card mt-5">
              <EmptyState
                icon={FolderGit2}
                title="No authorized repositories"
                description="Your GitHub account has not granted Valmont access to any repository yet. Adjust the authorization and refresh."
                action={
                  <Link href="/api/auth/github" className="btn-primary text-xs">
                    <Github className="size-3.5" aria-hidden="true" /> Refresh
                    authorization
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {repositories.map((repository) => (
                <article
                  key={repository.id}
                  className="card card-hover flex min-h-[230px] flex-col p-5"
                >
                  <div className="flex items-start justify-between">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-brandblue-50 text-brandblue">
                      <FolderGit2 className="size-5" aria-hidden="true" />
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-slate">
                      {repository.private ? (
                        <Lock className="size-3" aria-hidden="true" />
                      ) : (
                        <Unlock className="size-3" aria-hidden="true" />
                      )}
                      {repository.private ? "Private" : "Public"}
                    </span>
                  </div>
                  <h2 className="mt-4 text-[14px] font-bold tracking-[-0.01em] text-navy">
                    {repository.fullName}
                  </h2>
                  <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-slate">
                    {repository.description || "No description provided."}
                  </p>
                  <div className="mt-auto flex items-end justify-between pt-5">
                    <div>
                      <span className="flex items-center gap-1.5 text-[10px] text-slate">
                        <span
                          className="size-2 rounded-full bg-copper"
                          aria-hidden="true"
                        />
                        {repository.language || "Unknown"}
                      </span>
                      <p className="mt-1.5 text-[10px] text-slate-400">
                        Default: {repository.defaultBranch}
                      </p>
                    </div>
                    <Link
                      href={`/tasks/new?repository=${repository.id}`}
                      className="btn-secondary min-h-8 px-3 text-[11px]"
                    >
                      New task{" "}
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      <div className="mt-7 rounded-xl border border-line bg-white p-4">
        <div className="flex gap-3">
          <Lock
            className="mt-0.5 size-4 shrink-0 text-copper"
            aria-hidden="true"
          />
          <p className="text-[11px] leading-5 text-slate">
            <strong className="text-navy">Permission boundary.</strong> Valmont
            creates a repository only when you submit the form above. Within
            authorized repositories, it creates only{" "}
            <code className="rounded bg-ivory-100 px-1 py-0.5 text-navy">
              valmont/*
            </code>{" "}
            branches after final approval. It cannot delete repositories, change
            repository settings, merge pull requests, or deploy.
          </p>
        </div>
      </div>
    </div>
  );
}
