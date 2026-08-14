import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FolderGit2,
  GitPullRequest,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { StatusBadge } from "@/components/status-badge";
import { getSessionUser } from "@/lib/auth";
import { DEMO_REPOSITORIES } from "@/lib/github/demo";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getSessionUser();
  const tasks = await getTaskStore(user).list();
  const approvals = tasks.filter((task) =>
    task.state.includes("approval"),
  ).length;
  const completed = tasks.filter((task) => task.state === "completed").length;
  return (
    <div className="mx-auto max-w-[1180px] px-4 py-7 sm:px-7 sm:py-9">
      {user.demo && (
        <div className="mb-7 flex flex-col gap-3 rounded-xl border border-[#ecd8aa] bg-[#fff9e9] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <DemoBadge />
            <p className="text-[12px] leading-5 text-[#795c35]">
              You’re viewing sample repositories and deterministic agent output.
              No model or GitHub requests are being made.
            </p>
          </div>
          <Link
            href="/settings"
            className="shrink-0 text-[12px] font-bold text-[#815518] hover:underline"
          >
            Configure integrations →
          </Link>
        </div>
      )}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[12px] font-bold tracking-[0.08em] text-[#6c7b74] uppercase">
            Workspace overview
          </p>
          <h1 className="mt-1.5 text-[27px] font-bold tracking-[-0.035em] sm:text-[31px]">
            Good morning, {user.demo ? "builder" : user.name.split(" ")[0]}
          </h1>
          <p className="mt-2 text-sm text-[#6b7872]">
            Review agent work and decide what moves forward.
          </p>
        </div>
        <Link href="/tasks/new" className="btn-primary">
          <Plus className="size-4" /> New coding task
        </Link>
      </div>

      <section
        className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Workspace statistics"
      >
        {[
          {
            label: "Connected repositories",
            value: user.demo ? DEMO_REPOSITORIES.length : "—",
            note: "Authorized access",
            icon: FolderGit2,
            tone: "text-[#346552] bg-[#eaf3ed]",
          },
          {
            label: "Active tasks",
            value: tasks.filter(
              (task) =>
                !["completed", "cancelled", "failed"].includes(task.state),
            ).length,
            note: "Across all repos",
            icon: Clock3,
            tone: "text-[#47677a] bg-[#eaf0f4]",
          },
          {
            label: "Awaiting your approval",
            value: approvals,
            note: approvals ? "Action required" : "Nothing blocked",
            icon: ShieldCheck,
            tone: "text-[#9a5e16] bg-[#fff4dc]",
          },
          {
            label: "Pull requests created",
            value: completed,
            note: "Never auto-merged",
            icon: GitPullRequest,
            tone: "text-[#576398] bg-[#eeeff8]",
          },
        ].map(({ label, value, note, icon: Icon, tone }) => (
          <div key={label} className="card p-4.5 sm:p-5">
            <div className="flex items-start justify-between">
              <span
                className={`flex size-9 items-center justify-center rounded-lg ${tone}`}
              >
                <Icon className="size-[17px]" />
              </span>
              <span className="text-[25px] font-bold tracking-[-0.03em]">
                {value}
              </span>
            </div>
            <p className="mt-4 text-[12px] font-bold text-[#33423c]">{label}</p>
            <p className="mt-1 text-[11px] text-[#849089]">{note}</p>
          </div>
        ))}
      </section>

      <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_310px]">
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#e1e7e3] px-5 py-4">
            <div>
              <h2 className="text-sm font-bold">Recent tasks</h2>
              <p className="mt-1 text-[11px] text-[#7a8780]">
                Latest activity across authorized repositories
              </p>
            </div>
            <Link
              href="/tasks"
              className="text-[12px] font-bold text-[#27674e] hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="divide-y divide-[#e7ebe8]">
            {tasks.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm font-semibold">No tasks yet</p>
                <Link
                  href="/tasks/new"
                  className="mt-3 inline-flex text-xs font-bold text-[#24664d]"
                >
                  Create your first task
                </Link>
              </div>
            ) : (
              tasks.slice(0, 5).map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="group flex items-center gap-4 px-5 py-4 hover:bg-[#fafbfa]"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#dfe6e1] bg-[#f5f8f6] text-[#47705f]">
                    <GitPullRequest className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-[#26362f] group-hover:text-[#1f6b4f]">
                      {task.title}
                    </span>
                    <span className="mt-1 block truncate text-[11px] text-[#7a8781]">
                      {task.repositoryName} · {task.baseBranch} ·{" "}
                      {relativeTime(task.updatedAt)}
                    </span>
                  </span>
                  <StatusBadge state={task.state} />
                  <ArrowRight className="hidden size-4 text-[#a1aba6] sm:block" />
                </Link>
              ))
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-[#2d7256]" />
              <h2 className="text-[13px] font-bold">Approval queue</h2>
            </div>
            {approvals > 0 ? (
              <>
                <p className="mt-3 text-[26px] font-bold tracking-[-0.03em]">
                  {approvals}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-[#78847e]">
                  {approvals === 1 ? "task is" : "tasks are"} waiting for a
                  decision from you.
                </p>
                <Link
                  href={
                    tasks.find((task) => task.state.includes("approval"))
                      ? `/tasks/${tasks.find((task) => task.state.includes("approval"))!.id}`
                      : "/tasks"
                  }
                  className="btn-secondary mt-4 w-full text-xs"
                >
                  Review now <ArrowRight className="size-3.5" />
                </Link>
              </>
            ) : (
              <div className="mt-4 flex items-center gap-3 rounded-lg bg-[#eef7f1] p-3">
                <CheckCircle2 className="size-5 text-[#2d7b59]" />
                <p className="text-[11px] font-semibold text-[#35634f]">
                  You’re all caught up.
                </p>
              </div>
            )}
          </div>
          <div className="rounded-xl bg-[#173e31] p-5 text-white shadow-sm">
            <p className="text-[11px] font-bold tracking-[0.08em] text-[#a5c8b9] uppercase">
              Safety status
            </p>
            <h3 className="mt-2 text-sm font-bold">All guardrails active</h3>
            <ul className="mt-4 space-y-2.5 text-[11px] text-[#c5d9d0]">
              {[
                "Protected branch writes blocked",
                "Validation commands allowlisted",
                "Final approval enforced",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-[#77c5a2]" />
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
