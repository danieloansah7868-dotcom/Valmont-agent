import Link from "next/link";
import { ArrowRight, GitBranch, ListChecks, Plus, Search } from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { EmptyState, ErrorState, PageHeading } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { requireSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";
import type { CodingTask } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await requireSessionUser();
  let tasks: CodingTask[] = [];
  let loadError = "";
  try {
    tasks = await getTaskStore(user).list();
  } catch (error) {
    loadError =
      error instanceof Error ? error.message : "Tasks could not be loaded.";
  }

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-7 sm:py-9">
      <PageHeading
        eyebrow="Agent work"
        title="Coding tasks"
        description="Every task pauses at plan and pull-request approval boundaries."
        actions={
          <Link href="/tasks/new" className="btn-primary">
            <Plus className="size-4" aria-hidden="true" /> New coding task
          </Link>
        }
      />

      {loadError ? (
        <div className="mt-7">
          <ErrorState
            title="Tasks could not be loaded"
            description={loadError}
          />
        </div>
      ) : (
        <>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">Search tasks</span>
              <Search
                className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                className="input pl-10"
                placeholder="Search tasks, repositories, or branches…"
              />
            </label>
            <select
              className="select w-full sm:w-48"
              aria-label="Filter task status"
              defaultValue="all"
            >
              <option value="all">All statuses</option>
              <option value="approval">Approval needed</option>
              <option value="progress">In progress</option>
              <option value="completed">Completed</option>
            </select>
          </div>

          <section className="card mt-5 overflow-hidden">
            {tasks.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No tasks yet"
                description="Describe an outcome and Valmont will inspect the repository, propose a plan, and wait for your approval before changing anything."
                action={
                  <Link href="/tasks/new" className="btn-primary text-xs">
                    <Plus className="size-3.5" aria-hidden="true" /> New coding
                    task
                  </Link>
                }
              />
            ) : (
              <>
                <div className="hidden grid-cols-[minmax(0,1fr)_180px_150px_38px] border-b border-line bg-ivory-100 px-5 py-3 text-[10px] font-bold tracking-[0.06em] text-slate-700 uppercase sm:grid">
                  <span>Task</span>
                  <span>Repository</span>
                  <span>Status</span>
                  <span />
                </div>
                <div className="divide-y divide-line">
                  {tasks.map((task) => (
                    <Link
                      key={task.id}
                      href={`/tasks/${task.id}`}
                      className="group grid gap-3 px-5 py-4 transition-colors hover:bg-ivory-50 sm:grid-cols-[minmax(0,1fr)_180px_150px_38px] sm:items-center sm:gap-0"
                    >
                      <div className="min-w-0 pr-5">
                        <div className="flex items-center gap-2">
                          <ListChecks
                            className="size-4 shrink-0 text-brandblue"
                            aria-hidden="true"
                          />
                          <h2 className="truncate text-[13px] font-bold text-navy group-hover:text-copper-700">
                            {task.title}
                          </h2>
                          {task.demo && <DemoBadge compact />}
                        </div>
                        <p className="mt-1.5 truncate pl-6 text-[10px] text-slate">
                          Updated{" "}
                          {new Date(task.updatedAt).toLocaleString("en", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate">
                        <GitBranch className="size-3.5" aria-hidden="true" />
                        <span className="truncate">{task.repositoryName}</span>
                      </div>
                      <div>
                        <StatusBadge state={task.state} />
                      </div>
                      <ArrowRight
                        className="hidden size-4 text-slate-400 sm:block"
                        aria-hidden="true"
                      />
                    </Link>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
