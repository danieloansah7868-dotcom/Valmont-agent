import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FolderGit2,
  GitPullRequest,
  ListChecks,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { EmptyState, ErrorState, PageHeading } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { requireSessionUser, tryGetGitHubProvider } from "@/lib/auth";
import { missingLiveRequirements } from "@/lib/config";
import { getTaskStore } from "@/lib/task-store";
import type { CodingTask } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireSessionUser();

  let tasks: CodingTask[] = [];
  let loadError = "";
  try {
    tasks = await getTaskStore(user).list();
  } catch (error) {
    loadError =
      error instanceof Error ? error.message : "Tasks could not be loaded.";
  }

  let repositoryCount: number | "—" = "—";
  const provider = await tryGetGitHubProvider();
  if (provider) {
    try {
      repositoryCount = (await provider.listRepositories()).length;
    } catch {
      repositoryCount = "—";
    }
  }

  const approvals = tasks.filter((task) =>
    task.state.includes("approval"),
  ).length;
  const completed = tasks.filter((task) => task.state === "completed").length;
  const missing = missingLiveRequirements();
  const firstApproval = tasks.find((task) => task.state.includes("approval"));

  return (
    <div className="mx-auto max-w-[1180px] px-4 py-7 sm:px-7 sm:py-9">
      {missing.length > 0 && (
        <div className="mb-7 rounded-xl border border-copper-300 bg-copper-50 px-4 py-3.5">
          <p className="text-[12px] leading-5 font-semibold text-copper-700">
            Live mode is missing configuration: {missing.join(", ")}. Tasks
            cannot run until these server variables are set.
          </p>
        </div>
      )}

      <PageHeading
        eyebrow="Workspace overview"
        title={`Welcome back, ${user.name.split(" ")[0] ?? user.login}`}
        description="Review agent work and decide what moves forward."
        actions={
          <Link href="/tasks/new" className="btn-primary">
            <Plus className="size-4" aria-hidden="true" /> New coding task
          </Link>
        }
      />

      <section
        className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Workspace statistics"
      >
        {[
          {
            label: "Connected repositories",
            value: repositoryCount,
            note: "Authorized access",
            icon: FolderGit2,
            tone: "text-brandblue bg-brandblue-50",
          },
          {
            label: "Active tasks",
            value: tasks.filter(
              (task) =>
                !["completed", "cancelled", "failed"].includes(task.state),
            ).length,
            note: "Across all repos",
            icon: Clock3,
            tone: "text-brandblue bg-brandblue-50",
          },
          {
            label: "Awaiting your approval",
            value: approvals,
            note: approvals ? "Action required" : "Nothing blocked",
            icon: ShieldCheck,
            tone: "text-copper-700 bg-copper-50",
          },
          {
            label: "Pull requests created",
            value: completed,
            note: "Never auto-merged",
            icon: GitPullRequest,
            tone: "text-navy bg-ivory-100",
          },
        ].map(({ label, value, note, icon: Icon, tone }) => (
          <div key={label} className="card p-4.5 sm:p-5">
            <div className="flex items-start justify-between">
              <span
                className={`flex size-9 items-center justify-center rounded-lg ${tone}`}
              >
                <Icon className="size-[17px]" aria-hidden="true" />
              </span>
              <span className="text-[25px] font-bold tracking-[-0.03em] text-navy">
                {value}
              </span>
            </div>
            <p className="mt-4 text-[12px] font-bold text-navy">{label}</p>
            <p className="mt-1 text-[11px] text-slate">{note}</p>
          </div>
        ))}
      </section>

      <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_310px]">
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-bold text-navy">Recent tasks</h2>
              <p className="mt-1 text-[11px] text-slate">
                Latest activity across authorized repositories
              </p>
            </div>
            <Link href="/tasks" className="link-brand text-[12px]">
              View all
            </Link>
          </div>
          {loadError ? (
            <div className="p-5">
              <ErrorState
                title="Tasks could not be loaded"
                description={loadError}
              />
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No tasks yet"
              description="Create a coding task against one of your authorized repositories. Valmont will inspect it and return a plan for your approval."
              action={
                <Link href="/tasks/new" className="btn-primary text-xs">
                  <Plus className="size-3.5" aria-hidden="true" /> Create your
                  first task
                </Link>
              }
            />
          ) : (
            <div className="divide-y divide-line">
              {tasks.slice(0, 5).map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-ivory-50"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-ivory-100 text-brandblue">
                    <GitPullRequest className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-navy group-hover:text-copper-700">
                      {task.title}
                    </span>
                    <span className="mt-1 block truncate text-[11px] text-slate">
                      {task.repositoryName} · {task.baseBranch} ·{" "}
                      {relativeTime(task.updatedAt)}
                    </span>
                  </span>
                  <StatusBadge state={task.state} />
                  <ArrowRight
                    className="hidden size-4 text-slate-400 sm:block"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-copper" aria-hidden="true" />
              <h2 className="text-[13px] font-bold text-navy">
                Approval queue
              </h2>
            </div>
            {approvals > 0 ? (
              <>
                <p className="mt-3 text-[26px] font-bold tracking-[-0.03em] text-navy">
                  {approvals}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-slate">
                  {approvals === 1 ? "task is" : "tasks are"} waiting for a
                  decision from you.
                </p>
                <Link
                  href={firstApproval ? `/tasks/${firstApproval.id}` : "/tasks"}
                  className="btn-primary mt-4 w-full text-xs"
                >
                  Review now{" "}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </>
            ) : (
              <div className="mt-4 flex items-center gap-3 rounded-lg bg-pass-soft p-3">
                <CheckCircle2
                  className="size-5 shrink-0 text-pass"
                  aria-hidden="true"
                />
                <p className="text-[11px] font-semibold text-pass-strong">
                  You’re all caught up.
                </p>
              </div>
            )}
          </div>
          <div className="panel-navy p-5">
            <p className="text-[11px] font-bold tracking-[0.08em] text-copper-300 uppercase">
              Safety status
            </p>
            <h3 className="mt-2 text-sm font-bold text-ivory">
              All guardrails active
            </h3>
            <ul className="mt-4 space-y-2.5 text-[11px] text-ivory/70">
              {[
                "Protected branch writes blocked",
                "Validation commands allowlisted",
                "Final approval enforced",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <CheckCircle2
                    className="size-3.5 shrink-0 text-copper"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return "just now";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
