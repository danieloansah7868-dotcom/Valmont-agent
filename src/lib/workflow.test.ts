import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ConflictError, TaskNotFoundError } from "@/lib/api-errors";
import type {
  CreatedPullRequest,
  GitHubProvider,
  RepositoryFile,
} from "@/lib/github/types";
import type { TaskStore } from "@/lib/task-store";
import type { CodingTask } from "@/lib/types";
import { RestrictedLocalWorkspaceProvider } from "@/lib/workspace";
import { DockerWorkspaceProvider } from "@/lib/workspace-docker";
import {
  createWorkspaceProvider,
  resetWorkspaceProviderForTests,
  resolveWorkspaceProviderKind,
  TaskWorkflowService,
} from "@/lib/workflow";

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

describe("workflow errors the API can trust", () => {
  it("reports an unknown task as a typed 404", async () => {
    const service = new TaskWorkflowService(
      new MemoryStore(finalTask(true)),
      new UnusedGitHub(),
    );
    const failure = await service
      .approvePlan("no-such-task", "u")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaskNotFoundError);
    expect((failure as ApiError).status).toBe(404);
  });

  it("reports an approval in the wrong state as a typed 409", async () => {
    const service = new TaskWorkflowService(
      new MemoryStore(finalTask(false)),
      new UnusedGitHub(),
    );
    const plan = await service
      .approvePlan("task-test", "u")
      .catch((error: unknown) => error);
    expect(plan).toBeInstanceOf(ConflictError);
    expect((plan as ApiError).status).toBe(409);
    expect((plan as Error).message).toMatch(/awaiting_final_approval/);

    const reject = await service
      .reject("task-test", "plan", "u")
      .catch((error: unknown) => error);
    expect(reject).toBeInstanceOf(ConflictError);
  });
});

describe("workspace provider selection", () => {
  afterEach(() => {
    resetWorkspaceProviderForTests();
    vi.unstubAllEnvs();
  });

  it("defaults to the restricted local provider", () => {
    expect(resolveWorkspaceProviderKind({})).toBe("local");
    expect(createWorkspaceProvider({})).toBeInstanceOf(
      RestrictedLocalWorkspaceProvider,
    );
  });

  it("builds one shared Docker provider when VALMONT_WORKSPACE_PROVIDER=docker", () => {
    const env = {
      VALMONT_WORKSPACE_PROVIDER: "docker",
      VALMONT_SANDBOX_IMAGE: "valmont-sandbox:test",
      // A zero reap interval keeps the test free of background timers.
      VALMONT_SANDBOX_REAP_INTERVAL_MS: "0",
    };
    const first = createWorkspaceProvider(env);
    const second = createWorkspaceProvider(env);
    expect(first).toBeInstanceOf(DockerWorkspaceProvider);
    expect(second).toBe(first);
  });

  it("refuses an unknown provider name instead of silently using local", () => {
    expect(() =>
      resolveWorkspaceProviderKind({
        VALMONT_WORKSPACE_PROVIDER: "firecracker",
      }),
    ).toThrow(/VALMONT_WORKSPACE_PROVIDER/);
  });
});
