import type { TaskState } from "@/lib/types";

const LABELS: Record<TaskState, string> = {
  draft: "Draft",
  planning: "Planning",
  awaiting_plan_approval: "Plan approval",
  executing: "Executing",
  testing: "Testing",
  awaiting_final_approval: "Final approval",
  creating_pull_request: "Creating PR",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const COLORS: Record<TaskState, string> = {
  draft: "bg-slate-100 text-slate-600 ring-slate-200",
  planning: "bg-blue-50 text-blue-700 ring-blue-200",
  awaiting_plan_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  executing: "bg-blue-50 text-blue-700 ring-blue-200",
  testing: "bg-violet-50 text-violet-700 ring-violet-200",
  awaiting_final_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  creating_pull_request: "bg-blue-50 text-blue-700 ring-blue-200",
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
  cancelled: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function StatusBadge({ state }: { state: TaskState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ring-inset ${COLORS[state]}`}
    >
      {LABELS[state]}
    </span>
  );
}
