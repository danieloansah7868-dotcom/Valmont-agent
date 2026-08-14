import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CreatedPullRequest,
  FileChange,
  GitHubProvider,
  RepositoryFile,
} from "@/lib/github/types";
import type {
  ModelProvider,
  ModelResponse,
  StreamChunk,
  StructuredRequest,
} from "@/lib/models/types";
import type { TaskStore } from "@/lib/task-store";
import type { CodingTask, RepositorySummary } from "@/lib/types";
import { TaskWorkflowService } from "@/lib/workflow";
import { RestrictedLocalWorkspaceProvider } from "@/lib/workspace";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  ),
);

class MemoryStore implements TaskStore {
  private readonly tasks = new Map<string, CodingTask>();
  async list() {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }
  async get(id: string) {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }
  async save(task: CodingTask) {
    this.tasks.set(task.id, structuredClone(task));
  }
}

class RealTestModel implements ModelProvider {
  readonly id = "test-provider";
  readonly model = "test-model";
  readonly supportsStreaming = false;

  async chat(): Promise<ModelResponse> {
    return response("");
  }

  async structured<T>(request: StructuredRequest<T>) {
    const value =
      request.schemaName === "implementation_plan"
        ? {
            summary:
              "Create a tested output module from the existing project structure.",
            steps: [
              {
                title: "Create output module",
                description: "Add the requested exported value.",
                files: ["src/output.ts"],
              },
            ],
            validationCommands: ["npm test"],
            risk: "low",
          }
        : {
            summary: "Added the requested output module with a typed export.",
            files: [
              {
                operation: "write",
                path: "src/output.ts",
                content: "export const ready = true;\n",
                rationale: "Implements the approved output module.",
              },
            ],
          };
    return {
      ...response(JSON.stringify(value)),
      data: request.validate(value),
    };
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { delta: "", done: true };
  }
}

class RealTestGitHub implements GitHubProvider {
  createdBranch = "";
  committedFiles: FileChange[] = [];

  constructor(private readonly archive: Uint8Array) {}
  async listRepositories(): Promise<RepositorySummary[]> {
    return [];
  }
  async listBranches() {
    return ["main"];
  }
  async listFiles() {
    return ["README.md", "package.json", "src/input.ts"];
  }
  async downloadArchive() {
    return this.archive;
  }
  async readFile(
    _owner: string,
    _repository: string,
    filePath: string,
  ): Promise<RepositoryFile> {
    const contents: Record<string, string> = {
      "README.md": "# Test repository",
      "package.json":
        '{"scripts":{"test":"node -e \\"require(\\\'fs\\\').accessSync(\\\'src/output.ts\\\')\\""}}',
      "src/input.ts": "export const input = true;",
    };
    return { path: filePath, sha: "sha", content: contents[filePath] ?? "" };
  }
  async createBranch(
    _owner: string,
    _repository: string,
    _base: string,
    branch: string,
  ) {
    this.createdBranch = branch;
  }
  async commitFiles(
    _owner: string,
    _repository: string,
    _branch: string,
    _message: string,
    files: FileChange[],
  ) {
    this.committedFiles = files;
    return "1234567890abcdef";
  }
  async createPullRequest(
    _owner: string,
    _repository: string,
    branch: string,
    baseBranch: string,
    title: string,
  ): Promise<CreatedPullRequest> {
    return {
      id: "99",
      number: 9,
      url: "https://github.com/acme/app/pull/9",
      title,
      branch,
      baseBranch,
    };
  }
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    model: "test-model",
    provider: "test-provider",
    finishReason: "stop",
  };
}

async function repositoryArchive(): Promise<Uint8Array> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "valmont-real-flow-source-"),
  );
  temporary.push(root);
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "README.md"), "# Test repository\n");
  await writeFile(
    path.join(repository, "package.json"),
    JSON.stringify({
      scripts: {
        test: `node -e "require('fs').accessSync('src/output.ts')"`,
      },
    }),
  );
  await writeFile(
    path.join(repository, "src", "input.ts"),
    "export const input = true;\n",
  );
  await writeFile(
    path.join(repository, ".env"),
    "API_KEY=must-not-be-extracted\n",
  );
  const archivePath = path.join(root, "repository.tgz");
  await createTar({ gzip: true, cwd: root, file: archivePath }, ["repository"]);
  return new Uint8Array(await readFile(archivePath));
}

describe("real repository workflow", () => {
  it("retrieves, changes, validates, and creates a PR only after both approvals", async () => {
    const workspaces = await mkdtemp(
      path.join(os.tmpdir(), "valmont-real-flow-workspaces-"),
    );
    const sources = await mkdtemp(
      path.join(os.tmpdir(), "valmont-real-flow-sources-"),
    );
    temporary.push(workspaces, sources);
    const github = new RealTestGitHub(await repositoryArchive());
    const store = new MemoryStore();
    const workflow = new TaskWorkflowService(
      store,
      github,
      new RealTestModel(),
      new RestrictedLocalWorkspaceProvider({
        baseDirectory: workspaces,
        timeoutMs: 5_000,
      }),
      sources,
    );

    const planned = await workflow.create({
      userId: "user-1",
      title: "Create a production output module",
      description:
        "Add a typed output module and ensure the repository test can find it.",
      repositoryId: "repo-1",
      repositoryName: "acme/app",
      baseBranch: "main",
    });
    expect(planned.state).toBe("awaiting_plan_approval");
    expect(planned.plan?.generatedBy).toBe("model");
    expect(github.createdBranch).toBe("");

    const executed = await workflow.approvePlan(planned.id, "user-1");
    expect(executed.state).toBe("awaiting_final_approval");
    expect(executed.diff).toContain("src/output.ts");
    await expect(
      access(path.join(workspaces, planned.id, ".env")),
    ).rejects.toThrow();
    expect(executed.validations).toMatchObject([
      { command: "npm test", status: "passed" },
    ]);
    expect(github.createdBranch).toBe("");

    const completed = await workflow.approveFinal(planned.id, "user-1");
    expect(completed.state).toBe("completed");
    expect(completed.pullRequest?.number).toBe(9);
    expect(github.createdBranch).toMatch(/^valmont\//);
    expect(github.committedFiles).toEqual([
      { path: "src/output.ts", content: "export const ready = true;\n" },
    ]);
  });
});
