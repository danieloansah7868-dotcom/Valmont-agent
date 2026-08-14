import Link from "next/link";
import { ArrowRight, GitBranch, ListChecks, Plus, Search } from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { StatusBadge } from "@/components/status-badge";
import { getSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await getSessionUser();
  const tasks = await getTaskStore(user).list();
  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-7 sm:py-9">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[12px] font-bold tracking-[0.08em] text-[#6c7b74] uppercase">
            Agent work
          </p>
          <h1 className="mt-1.5 text-[29px] font-bold tracking-[-0.035em]">
            Coding tasks
          </h1>
          <p className="mt-2 text-sm text-[#6b7872]">
            Every task pauses at plan and pull-request approval boundaries.
          </p>
        </div>
        <Link href="/tasks/new" className="btn-primary">
          <Plus className="size-4" /> New coding task
        </Link>
      </div>
      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Search tasks</span>
          <Search className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[#87948d]" />
          <input
            className="input pl-10"
            placeholder="Search tasks, repositories, or branches…"
          />
        </label>
        <select
          className="select w-full sm:w-48"
          aria-label="Filter task status"
        >
          <option>All statuses</option>
          <option>Approval needed</option>
          <option>In progress</option>
          <option>Completed</option>
        </select>
      </div>
      <section className="card mt-5 overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,1fr)_180px_150px_38px] border-b border-[#e2e8e4] bg-[#fafbfa] px-5 py-3 text-[10px] font-bold tracking-[0.06em] text-[#7b8881] uppercase sm:grid">
          <span>Task</span>
          <span>Repository</span>
          <span>Status</span>
          <span />
        </div>
        <div className="divide-y divide-[#e5eae7]">
          {tasks.map((task) => (
            <Link
              key={task.id}
              href={`/tasks/${task.id}`}
              className="group grid gap-3 px-5 py-4 hover:bg-[#fafbfa] sm:grid-cols-[minmax(0,1fr)_180px_150px_38px] sm:items-center sm:gap-0"
            >
              <div className="min-w-0 pr-5">
                <div className="flex items-center gap-2">
                  <ListChecks className="size-4 shrink-0 text-[#49715f]" />
                  <h2 className="truncate text-[13px] font-bold group-hover:text-[#1f6b4f]">
                    {task.title}
                  </h2>
                  {task.demo && <DemoBadge compact />}
                </div>
                <p className="mt-1.5 truncate pl-6 text-[10px] text-[#89948f]">
                  Updated{" "}
                  {new Date(task.updatedAt).toLocaleString("en", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#65726c]">
                <GitBranch className="size-3.5" />
                <span className="truncate">{task.repositoryName}</span>
              </div>
              <div>
                <StatusBadge state={task.state} />
              </div>
              <ArrowRight className="hidden size-4 text-[#9ba6a0] sm:block" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
