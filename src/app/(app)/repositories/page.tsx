import Link from "next/link";
import {
  ExternalLink,
  FolderGit2,
  Github,
  Lock,
  Search,
  Unlock,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { getGitHubProvider, getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  const [provider, user] = await Promise.all([
    getGitHubProvider(),
    getSessionUser(),
  ]);
  const repositories = await provider.listRepositories();
  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-7 sm:py-9">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[12px] font-bold tracking-[0.08em] text-[#6c7b74] uppercase">
              GitHub access
            </p>
            {provider.demo && <DemoBadge compact />}
          </div>
          <h1 className="mt-1.5 text-[29px] font-bold tracking-[-0.035em]">
            Connected repositories
          </h1>
          <p className="mt-2 text-sm text-[#6b7872]">
            Only repositories authorized through your GitHub account are
            available to the agent.
          </p>
        </div>
        <Link href="/api/auth/github" className="btn-secondary">
          <Github className="size-4" />{" "}
          {user.demo ? "Connect GitHub" : "Refresh authorization"}
        </Link>
      </div>

      {provider.demo && (
        <div className="mt-7 rounded-xl border border-[#ecd8aa] bg-[#fff9e9] p-4 text-[12px] leading-5 text-[#765a34]">
          <strong>Sample data:</strong> these repositories are fictional.
          Connect a GitHub OAuth App from Settings to list repositories your
          account can access.
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search repositories</span>
          <Search className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[#87948d]" />
          <input
            className="input pl-10"
            placeholder="Search authorized repositories…"
          />
        </label>
        <select
          className="select w-full sm:w-44"
          aria-label="Filter repositories"
        >
          <option>All repositories</option>
          <option>Private</option>
          <option>Public</option>
        </select>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {repositories.map((repository) => (
          <article
            key={repository.id}
            className="card card-hover flex min-h-[230px] flex-col p-5"
          >
            <div className="flex items-start justify-between">
              <span className="flex size-10 items-center justify-center rounded-xl bg-[#edf3ef] text-[#35654f]">
                <FolderGit2 className="size-5" />
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-[#7e8984]">
                {repository.private ? (
                  <Lock className="size-3" />
                ) : (
                  <Unlock className="size-3" />
                )}
                {repository.private ? "Private" : "Public"}
              </span>
            </div>
            <h2 className="mt-4 text-[14px] font-bold tracking-[-0.01em]">
              {repository.fullName}
            </h2>
            <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-[#6d7973]">
              {repository.description}
            </p>
            <div className="mt-auto flex items-end justify-between pt-5">
              <div>
                <span className="flex items-center gap-1.5 text-[10px] text-[#7d8983]">
                  <span
                    className={`size-2 rounded-full ${repository.language === "TypeScript" ? "bg-[#3178c6]" : repository.language === "Go" ? "bg-[#00add8]" : "bg-[#8d9a94]"}`}
                  />
                  {repository.language}
                </span>
                <p className="mt-1.5 text-[10px] text-[#929c97]">
                  Default: {repository.defaultBranch}
                </p>
              </div>
              <Link
                href={`/tasks/new?repository=${repository.id}`}
                className="btn-secondary min-h-8 px-3 text-[11px]"
              >
                New task <ExternalLink className="size-3" />
              </Link>
            </div>
          </article>
        ))}
      </div>
      <div className="mt-7 rounded-xl border border-[#dfe6e1] bg-white p-4">
        <div className="flex gap-3">
          <Lock className="mt-0.5 size-4 shrink-0 text-[#46705e]" />
          <p className="text-[11px] leading-5 text-[#6f7c75]">
            <strong className="text-[#3a4942]">Permission boundary.</strong>{" "}
            Valmont reads authorized repositories and creates only{" "}
            <code className="rounded bg-[#edf1ee] px-1 py-0.5">valmont/*</code>{" "}
            branches after final approval. It cannot change repository settings,
            merge pull requests, or deploy.
          </p>
        </div>
      </div>
    </div>
  );
}
