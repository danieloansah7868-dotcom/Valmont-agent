import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  GitBranch,
  Github,
  GitPullRequest,
  ShieldCheck,
} from "lucide-react";
import { EmptyState } from "@/components/states";
import { requireSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";

export default async function TaskResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSessionUser();
  const task = await getTaskStore(user).get(id);
  if (!task) notFound();

  if (!task.pullRequest) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <div className="card">
          <EmptyState
            icon={GitPullRequest}
            title="No pull request yet"
            description="Complete both approval boundaries before a pull request can be created."
            action={
              <Link href={`/tasks/${task.id}`} className="btn-primary text-xs">
                Return to task
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const pr = task.pullRequest;
  return (
    <div className="mx-auto max-w-[900px] px-4 py-7 sm:px-7 sm:py-10">
      <Link
        href={`/tasks/${task.id}`}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate transition-colors hover:text-copper-700"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Back to task
      </Link>

      <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-white shadow-[0_16px_44px_rgba(9,21,52,0.10)]">
        <div className="bg-navy px-6 py-8 text-center sm:px-10 sm:py-10">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-copper-600 text-white">
            <GitPullRequest className="size-6" aria-hidden="true" />
          </span>
          <p className="mt-4 text-[11px] font-bold tracking-[0.1em] text-copper-300 uppercase">
            Pull request ready for review
          </p>
          <h1 className="mx-auto mt-3 max-w-xl text-[24px] font-bold tracking-[-0.03em] text-ivory sm:text-[28px]">
            {pr.title}
          </h1>
          <p className="mt-2 text-[12px] text-ivory/65">
            Pull request #{pr.number} · Open · Created{" "}
            {new Date(pr.createdAt).toLocaleString("en", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        </div>

        <div className="p-6 sm:p-8">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-line p-4">
              <p className="text-[9px] font-bold tracking-[0.09em] text-slate uppercase">
                Repository
              </p>
              <p className="mt-2 flex items-center gap-2 text-[12px] font-bold text-navy">
                <Github className="size-4 text-brandblue" aria-hidden="true" />
                {task.repositoryName}
              </p>
            </div>
            <div className="rounded-xl border border-line p-4">
              <p className="text-[9px] font-bold tracking-[0.09em] text-slate uppercase">
                Branch
              </p>
              <p className="mt-2 flex items-center gap-2 text-[11px] font-bold text-navy">
                <GitBranch
                  className="size-4 shrink-0 text-brandblue"
                  aria-hidden="true"
                />
                <code className="truncate">{pr.branch}</code>
                <span className="text-slate-400" aria-hidden="true">
                  →
                </span>
                <code>{pr.baseBranch}</code>
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-line bg-ivory-50 p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-copper" aria-hidden="true" />
              <h2 className="text-[12px] font-bold text-navy">
                Valmont stopped here
              </h2>
            </div>
            <ul className="mt-3 grid gap-2 text-[10px] text-slate sm:grid-cols-3">
              {[
                "PR remains open",
                "No merge was attempted",
                "No deployment was triggered",
              ].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check
                    className="size-3.5 shrink-0 text-copper"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="btn-primary"
            >
              <Github className="size-4" aria-hidden="true" /> Open on GitHub{" "}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            <Link href="/dashboard" className="btn-secondary">
              Return to dashboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
