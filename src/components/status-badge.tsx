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

/**
 * Brand palette drives every state. Green and red are kept only where they
 * genuinely mean succeeded/failed.
 */
const COLORS: Record<TaskState, string> = {
  draft: "bg-ivory-100 text-slate-700 ring-line",
  planning: "bg-brandblue-50 text-brandblue ring-brandblue-200",
  awaiting_plan_approval: "bg-copper-50 text-copper-700 ring-copper-300",
  executing: "bg-brandblue-50 text-brandblue ring-brandblue-200",
  testing: "bg-brandblue-50 text-brandblue ring-brandblue-200",
  awaiting_final_approval: "bg-copper-50 text-copper-700 ring-copper-300",
  creating_pull_request: "bg-brandblue-50 text-brandblue ring-brandblue-200",
  completed: "bg-pass-soft text-pass-strong ring-pass/30",
  failed: "bg-fail-soft text-fail-strong ring-fail/30",
  cancelled: "bg-ivory-100 text-slate-700 ring-line",
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
