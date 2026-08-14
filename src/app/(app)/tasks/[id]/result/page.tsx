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
import { DemoBadge } from "@/components/demo-badge";
import { getSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";

export default async function TaskResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  const task = await getTaskStore(user).get(id);
  if (!task) notFound();
  if (!task.pullRequest)
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 text-center">
        <h1 className="text-xl font-bold">No pull request yet</h1>
        <p className="mt-2 text-sm text-[#6f7c76]">
          Complete both approval boundaries before a pull request can be
          created.
        </p>
        <Link href={`/tasks/${task.id}`} className="btn-primary mt-5">
          Return to task
        </Link>
      </div>
    );
  const pr = task.pullRequest;
  return (
    <div className="mx-auto max-w-[900px] px-4 py-7 sm:px-7 sm:py-10">
      <Link
        href={`/tasks/${task.id}`}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#6e7b75] hover:text-[#24644c]"
      >
        <ArrowLeft className="size-3.5" /> Back to task
      </Link>
      <div className="mt-7 overflow-hidden rounded-2xl border border-[#bdd9ca] bg-white shadow-[0_12px_35px_rgba(30,80,58,0.08)]">
        <div className="bg-[#eff8f3] px-6 py-7 text-center sm:px-10 sm:py-9">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#d8eee2] text-[#22704f]">
            <GitPullRequest className="size-6" />
          </span>
          <div className="mt-4 flex items-center justify-center gap-2">
            <p className="text-[11px] font-bold tracking-[0.08em] text-[#317158] uppercase">
              Pull request ready for review
            </p>
            {pr.demo && <DemoBadge compact />}
          </div>
          <h1 className="mx-auto mt-3 max-w-xl text-[24px] font-bold tracking-[-0.03em] sm:text-[28px]">
            {pr.title}
          </h1>
          <p className="mt-2 text-[12px] text-[#698076]">
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
          {pr.demo && (
            <div className="mb-6 rounded-lg border border-[#ecd8aa] bg-[#fff9e9] p-3.5 text-[11px] leading-5 text-[#795d36]">
              <strong>Demo result:</strong> this pull request URL and branch are
              sample data. No GitHub branch, commit, or pull request was
              created.
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-[#e0e7e2] p-4">
              <p className="text-[9px] font-bold tracking-[0.08em] text-[#86928c] uppercase">
                Repository
              </p>
              <p className="mt-2 flex items-center gap-2 text-[12px] font-bold">
                <Github className="size-4 text-[#627169]" />
                {task.repositoryName}
              </p>
            </div>
            <div className="rounded-xl border border-[#e0e7e2] p-4">
              <p className="text-[9px] font-bold tracking-[0.08em] text-[#86928c] uppercase">
                Branch
              </p>
              <p className="mt-2 flex items-center gap-2 text-[11px] font-bold">
                <GitBranch className="size-4 text-[#627169]" />
                <code className="truncate">{pr.branch}</code>
                <span className="text-[#98a19d]">→</span>
                <code>{pr.baseBranch}</code>
              </p>
            </div>
          </div>
          <div className="mt-6 rounded-xl border border-[#d9e5de] bg-[#f7faf8] p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-[#2f7257]" />
              <h2 className="text-[12px] font-bold">Valmont stopped here</h2>
            </div>
            <ul className="mt-3 grid gap-2 text-[10px] text-[#65766d] sm:grid-cols-3">
              {[
                "PR remains open",
                "No merge was attempted",
                "No deployment was triggered",
              ].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-[#347657]" />
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
              <Github className="size-4" /> Open on GitHub{" "}
              <ExternalLink className="size-3.5" />
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
