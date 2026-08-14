import { describe, expect, it } from "vitest";
import { DemoGitHubProvider } from "@/lib/github/demo";
import type { TaskStore } from "@/lib/task-store";
import type { CodingTask } from "@/lib/types";
import { TaskWorkflowService } from "@/lib/workflow";

class MemoryStore implements TaskStore {
  constructor(private task: CodingTask) {}
  async list() {
    return [structuredClone(this.task)];
  }
  async get(id: string) {
    return id === this.task.id ? structuredClone(this.task) : undefined;
  }
  async save(task: CodingTask) {
    this.task = structuredClone(task);
  }
}

function finalTask(approved: boolean): CodingTask {
  return {
    id: "task-test",
    title: "Safe fix",
    description: "A test task for approval guards",
    repositoryId: "repo",
    repositoryName: "acme/app",
    baseBranch: "main",
    state: "awaiting_final_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validations: [],
    events: [],
    toolExecutions: [],
    approvals: approved
      ? [
          {
            id: "a",
            taskId: "task-test",
            stage: "final",
            decision: "approved",
            actorId: "u",
            createdAt: new Date().toISOString(),
          },
        ]
      : [],
    demo: true,
  };
}

describe("pull request workflow guard", () => {
  it("prevents PR creation without a final approval", async () => {
    const service = new TaskWorkflowService(
      new MemoryStore(finalTask(false)),
      new DemoGitHubProvider(),
    );
    await expect(
      service.createPullRequestWithoutApproval("task-test"),
    ).rejects.toThrow(/final approval/);
  });

  it("does not treat plan approval as final approval", async () => {
    const task = finalTask(false);
    task.approvals.push({
      id: "p",
      taskId: task.id,
      stage: "plan",
      decision: "approved",
      actorId: "u",
      createdAt: new Date().toISOString(),
    });
    const service = new TaskWorkflowService(
      new MemoryStore(task),
      new DemoGitHubProvider(),
    );
    await expect(
      service.createPullRequestWithoutApproval(task.id),
    ).rejects.toThrow(/final approval/);
  });
});
