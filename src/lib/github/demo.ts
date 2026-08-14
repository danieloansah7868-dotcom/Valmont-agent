import type {
  CreatedPullRequest,
  GitHubProvider,
  RepositoryFile,
} from "@/lib/github/types";
import type { RepositorySummary } from "@/lib/types";

export const DEMO_REPOSITORIES: RepositorySummary[] = [
  {
    id: "demo-repo-1",
    owner: "acme-labs",
    name: "atlas-web",
    fullName: "acme-labs/atlas-web",
    description: "Customer-facing logistics dashboard",
    defaultBranch: "main",
    private: true,
    language: "TypeScript",
    updatedAt: "2026-08-13T16:40:00.000Z",
    demo: true,
  },
  {
    id: "demo-repo-2",
    owner: "acme-labs",
    name: "signal-api",
    fullName: "acme-labs/signal-api",
    description: "Internal event processing API",
    defaultBranch: "main",
    private: true,
    language: "Go",
    updatedAt: "2026-08-11T10:20:00.000Z",
    demo: true,
  },
  {
    id: "demo-repo-3",
    owner: "studio-north",
    name: "design-system",
    fullName: "studio-north/design-system",
    description: "Shared accessible UI primitives",
    defaultBranch: "main",
    private: false,
    language: "TypeScript",
    updatedAt: "2026-08-09T08:05:00.000Z",
    demo: true,
  },
];

export class DemoGitHubProvider implements GitHubProvider {
  readonly demo = true;

  async listRepositories(): Promise<RepositorySummary[]> {
    return structuredClone(DEMO_REPOSITORIES);
  }

  async listBranches(): Promise<string[]> {
    return ["main", "develop", "release/next"];
  }

  async listFiles(): Promise<string[]> {
    return [
      "README.md",
      "package.json",
      "src/features/projects/project-grid.tsx",
      "src/features/projects/project-grid.test.tsx",
    ];
  }

  async downloadArchive(): Promise<Uint8Array> {
    throw new Error(
      "Demo repositories do not have downloadable source archives",
    );
  }

  async readFile(
    owner: string,
    repository: string,
    filePath: string,
  ): Promise<RepositoryFile> {
    void owner;
    void repository;
    return {
      path: filePath,
      sha: "demo-file-sha",
      content: "// Demo repository content. No GitHub request was made.\n",
    };
  }

  async createBranch(): Promise<void> {
    // Deterministic no-op for the labelled demo workflow.
  }

  async commitFiles(): Promise<string> {
    return "demo-commit-9d3c6f2";
  }

  async createPullRequest(
    owner: string,
    repository: string,
    branch: string,
    baseBranch: string,
    title: string,
  ): Promise<CreatedPullRequest> {
    return {
      id: "demo-pr-184",
      number: 184,
      url: `https://github.com/${owner}/${repository}/pull/184`,
      title,
      branch,
      baseBranch,
    };
  }
}
