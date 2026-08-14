import { isSensitivePath } from "@/lib/retrieval";
import type {
  CreatedPullRequest,
  FileChange,
  GitHubProvider,
  RepositoryFile,
} from "@/lib/github/types";
import type { RepositorySummary } from "@/lib/types";

interface GitHubConfig {
  accessToken: string;
  fetcher?: typeof fetch;
}

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  language: string | null;
  updated_at: string;
  owner: { login: string };
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubApiProvider implements GitHubProvider {
  readonly demo = false;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(config: GitHubConfig) {
    if (!config.accessToken) throw new Error("GitHub access token is required");
    this.token = config.accessToken;
    this.fetcher = config.fetcher ?? fetch;
  }

  async listRepositories(): Promise<RepositorySummary[]> {
    const repositories = await this.request<GitHubRepository[]>(
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    );
    return repositories.map((repository) => ({
      id: String(repository.id),
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      description: repository.description ?? "No description",
      defaultBranch: repository.default_branch,
      private: repository.private,
      language: repository.language ?? "Unknown",
      updatedAt: repository.updated_at,
      demo: false,
    }));
  }

  async listBranches(owner: string, repository: string): Promise<string[]> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    const branches = await this.request<Array<{ name: string }>>(
      `/repos/${owner}/${repository}/branches?per_page=100`,
    );
    return branches.map((branch) => branch.name);
  }

  async listFiles(
    owner: string,
    repository: string,
    ref: string,
  ): Promise<string[]> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    validateRef(ref);
    const result = await this.request<{
      truncated: boolean;
      tree: Array<{ path: string; type: string; size?: number }>;
    }>(
      `/repos/${owner}/${repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    if (result.truncated) {
      throw new Error("Repository tree is too large for bounded retrieval");
    }
    return result.tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          (entry.size ?? 0) <= 256_000 &&
          !isSensitivePath(entry.path),
      )
      .map((entry) => entry.path)
      .slice(0, 10_000);
  }

  async downloadArchive(
    owner: string,
    repository: string,
    ref: string,
  ): Promise<Uint8Array> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    validateRef(ref);
    const response = await this.fetcher(
      `https://api.github.com/repos/${owner}/${repository}/tarball/${encodeURIComponent(ref)}`,
      { headers: this.headers() },
    );
    if (!response.ok) await this.throwGitHubError(response);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 50 * 1024 * 1024) {
      throw new Error("Repository archive exceeds the 50 MB workspace limit");
    }
    const archive = new Uint8Array(await response.arrayBuffer());
    if (archive.byteLength > 50 * 1024 * 1024) {
      throw new Error("Repository archive exceeds the 50 MB workspace limit");
    }
    return archive;
  }

  async readFile(
    owner: string,
    repository: string,
    filePath: string,
    ref: string,
  ): Promise<RepositoryFile> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    validateRef(ref);
    if (isSensitivePath(filePath))
      throw new Error("Sensitive repository path is blocked");
    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const file = await this.request<{
      path: string;
      content: string;
      encoding: string;
      sha: string;
    }>(
      `/repos/${owner}/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );
    if (file.encoding !== "base64")
      throw new Error("Unsupported GitHub content encoding");
    return {
      path: file.path,
      sha: file.sha,
      content: Buffer.from(
        file.content.replaceAll("\n", ""),
        "base64",
      ).toString("utf8"),
    };
  }

  async createBranch(
    owner: string,
    repository: string,
    baseBranch: string,
    branch: string,
  ): Promise<void> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    validateRef(baseBranch);
    validateAgentBranch(branch);
    const base = await this.request<{ object: { sha: string } }>(
      `/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    );
    await this.request(`/repos/${owner}/${repository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: base.object.sha,
      }),
    });
  }

  async commitFiles(
    owner: string,
    repository: string,
    branch: string,
    message: string,
    files: FileChange[],
  ): Promise<string> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    validateAgentBranch(branch);
    if (files.length === 0 || files.length > 100)
      throw new Error("Commit must contain 1–100 files");
    for (const file of files) {
      if (
        isSensitivePath(file.path) ||
        file.path.includes("..") ||
        file.path.startsWith("/")
      ) {
        throw new Error(`Unsafe commit path: ${file.path}`);
      }
    }
    const ref = await this.request<{ object: { sha: string } }>(
      `/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const parent = await this.request<{ tree: { sha: string } }>(
      `/repos/${owner}/${repository}/git/commits/${ref.object.sha}`,
    );
    const treeItems = await Promise.all(
      files.map(async (file) => {
        if (file.content === null) {
          return { path: file.path, mode: "100644", type: "blob", sha: null };
        }
        const blob = await this.request<{ sha: string }>(
          `/repos/${owner}/${repository}/git/blobs`,
          {
            method: "POST",
            body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
          },
        );
        return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
      }),
    );
    const tree = await this.request<{ sha: string }>(
      `/repos/${owner}/${repository}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({ base_tree: parent.tree.sha, tree: treeItems }),
      },
    );
    const commit = await this.request<{ sha: string }>(
      `/repos/${owner}/${repository}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: message.slice(0, 240),
          tree: tree.sha,
          parents: [ref.object.sha],
        }),
      },
    );
    await this.request(
      `/repos/${owner}/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
    );
    return commit.sha;
  }

  async createPullRequest(
    owner: string,
    repository: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<CreatedPullRequest> {
    validateSlug(owner, "owner");
    validateSlug(repository, "repository");
    validateAgentBranch(branch);
    validateRef(baseBranch);
    const result = await this.request<{
      id: number;
      number: number;
      html_url: string;
      title: string;
      head: { ref: string };
      base: { ref: string };
    }>(`/repos/${owner}/${repository}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: title.slice(0, 240),
        body,
        head: branch,
        base: baseBranch,
        draft: false,
      }),
    });
    return {
      id: String(result.id),
      number: result.number,
      url: result.html_url,
      title: result.title,
      branch: result.head.ref,
      baseBranch: result.base.ref,
    };
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetcher(`https://api.github.com${pathname}`, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
    });
    if (!response.ok) await this.throwGitHubError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Valmont-Agent/0.1",
    };
  }

  private async throwGitHubError(response: Response): Promise<never> {
    let message = `GitHub API request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      message = body.message ?? message;
    } catch {
      // Keep status-only message rather than exposing arbitrary response text.
    }
    throw new GitHubApiError(message, response.status);
  }
}

function validateSlug(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value))
    throw new Error(`Invalid GitHub ${label}`);
}

function validateRef(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("Invalid Git reference");
  }
}

function validateAgentBranch(value: string): void {
  validateRef(value);
  if (!value.startsWith("valmont/")) {
    throw new Error("Valmont Agent only writes to valmont/* working branches");
  }
}
