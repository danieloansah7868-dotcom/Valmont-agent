import { describe, expect, it } from "vitest";
import type {
  CreatedPullRequest,
  GitHubProvider,
  RepositoryFile,
} from "@/lib/github/types";
import type { TaskStore } from "@/lib/task-store";
import type { CodingTask } from "@/lib/types";
import { TaskWorkflowService } from "@/lib/workflow";

/** A GitHub provider that fails loudly: the guards under test must run first. */
class UnusedGitHub implements GitHubProvider {
  private fail(): never {
    throw new Error("GitHub must not be contacted before final approval");
  }
  async createRepository(): Promise<never> {
    this.fail();
  }
  async listRepositories(): Promise<never> {
    this.fail();
  }
  async listBranches(): Promise<never> {
    this.fail();
  }
  async listFiles(): Promise<never> {
    this.fail();
  }
  async downloadArchive(): Promise<never> {
    this.fail();
  }
  async readFile(): Promise<RepositoryFile> {
    this.fail();
  }
  async createBranch(): Promise<never> {
    this.fail();
  }
  async commitFiles(): Promise<string> {
    this.fail();
  }
  async createPullRequest(): Promise<CreatedPullRequest> {
    this.fail();
  }
}

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
  };
}

describe("pull request workflow guard", () => {
  it("prevents PR creation without a final approval", async () => {
    const service = new TaskWorkflowService(
      new MemoryStore(finalTask(false)),
      new UnusedGitHub(),
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
      new UnusedGitHub(),
    );
    await expect(
      service.createPullRequestWithoutApproval(task.id),
    ).rejects.toThrow(/final approval/);
  });
});
