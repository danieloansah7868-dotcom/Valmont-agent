import type { RepositorySummary } from "@/lib/types";

export interface RepositoryFile {
  path: string;
  content: string;
  sha: string;
}

export interface FileChange {
  path: string;
  /** Null deletes an existing file through the Git Trees API. */
  content: string | null;
}

export interface CreatedPullRequest {
  id: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  baseBranch: string;
}

export interface GitHubProvider {
  listRepositories(): Promise<RepositorySummary[]>;
  listBranches(owner: string, repository: string): Promise<string[]>;
  listFiles(owner: string, repository: string, ref: string): Promise<string[]>;
  downloadArchive(
    owner: string,
    repository: string,
    ref: string,
  ): Promise<Uint8Array>;
  readFile(
    owner: string,
    repository: string,
    filePath: string,
    ref: string,
  ): Promise<RepositoryFile>;
  createBranch(
    owner: string,
    repository: string,
    baseBranch: string,
    branch: string,
  ): Promise<void>;
  commitFiles(
    owner: string,
    repository: string,
    branch: string,
    message: string,
    files: FileChange[],
  ): Promise<string>;
  createPullRequest(
    owner: string,
    repository: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<CreatedPullRequest>;
}
