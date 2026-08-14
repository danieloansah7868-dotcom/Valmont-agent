import type { Approval, CodingTask, TaskState } from "@/lib/types";

export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["planning", "cancelled"],
  planning: ["awaiting_plan_approval", "failed", "cancelled"],
  awaiting_plan_approval: ["executing", "cancelled"],
  executing: ["testing", "failed", "cancelled"],
  testing: ["awaiting_final_approval", "failed", "cancelled"],
  awaiting_final_approval: ["creating_pull_request", "cancelled"],
  creating_pull_request: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`Invalid task transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(stage: "plan" | "final") {
    super(`An explicit ${stage} approval is required before this action`);
    this.name = "ApprovalRequiredError";
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function hasApproval(
  task: Pick<CodingTask, "approvals">,
  stage: Approval["stage"],
): boolean {
  const decisions = task.approvals.filter(
    (approval) => approval.stage === stage,
  );
  return decisions.length > 0 && decisions.at(-1)?.decision === "approved";
}

export function assertCanExecute(
  task: Pick<CodingTask, "state" | "approvals">,
): void {
  if (task.state !== "awaiting_plan_approval") {
    throw new InvalidTransitionError(task.state, "executing");
  }
  if (!hasApproval(task as Pick<CodingTask, "approvals">, "plan")) {
    throw new ApprovalRequiredError("plan");
  }
}

export function assertCanCreatePullRequest(
  task: Pick<CodingTask, "state" | "approvals">,
): void {
  if (task.state !== "awaiting_final_approval") {
    throw new InvalidTransitionError(task.state, "creating_pull_request");
  }
  if (!hasApproval(task as Pick<CodingTask, "approvals">, "final")) {
    throw new ApprovalRequiredError("final");
  }
}
