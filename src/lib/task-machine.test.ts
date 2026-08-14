import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  assertCanCreatePullRequest,
  assertCanExecute,
  assertTransition,
  canTransition,
  InvalidTransitionError,
} from "@/lib/task-machine";
import type { CodingTask } from "@/lib/types";

function task(
  state: CodingTask["state"],
  approvals: CodingTask["approvals"] = [],
) {
  return { state, approvals } as CodingTask;
}

describe("task state machine", () => {
  it("allows only declared forward transitions", () => {
    expect(canTransition("draft", "planning")).toBe(true);
    expect(canTransition("planning", "awaiting_plan_approval")).toBe(true);
    expect(canTransition("completed", "executing")).toBe(false);
    expect(() => assertTransition("awaiting_plan_approval", "testing")).toThrow(
      InvalidTransitionError,
    );
  });

  it("requires explicit plan approval before execution", () => {
    expect(() => assertCanExecute(task("awaiting_plan_approval"))).toThrow(
      ApprovalRequiredError,
    );
    expect(() =>
      assertCanExecute(
        task("awaiting_plan_approval", [
          {
            id: "approval-1",
            taskId: "task-1",
            stage: "plan",
            decision: "approved",
            actorId: "user-1",
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("requires the latest final decision to be approval before PR creation", () => {
    const approved = {
      id: "approval-1",
      taskId: "task-1",
      stage: "final" as const,
      decision: "approved" as const,
      actorId: "user-1",
      createdAt: new Date().toISOString(),
    };
    expect(() =>
      assertCanCreatePullRequest(task("awaiting_final_approval")),
    ).toThrow(ApprovalRequiredError);
    expect(() =>
      assertCanCreatePullRequest(task("awaiting_final_approval", [approved])),
    ).not.toThrow();
    expect(() =>
      assertCanCreatePullRequest(
        task("awaiting_final_approval", [
          approved,
          { ...approved, id: "approval-2", decision: "rejected" },
        ]),
      ),
    ).toThrow(ApprovalRequiredError);
  });
});
