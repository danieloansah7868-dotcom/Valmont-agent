import type { GitHubProvider } from "@/lib/github/types";
import { isSensitivePath } from "@/lib/retrieval";
import { redactSecrets } from "@/lib/security";

export interface GitHubContextFile {
  path: string;
  content: string;
  score: number;
}

export interface RepositorySnapshot {
  /** Paths already on the branch. Use this to avoid inventing or duplicating files. */
  paths: string[];
  files: GitHubContextFile[];
}

const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|vue|svelte|css|scss|html|md|json|ya?ml|toml)$/i;
const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "build",
  "change",
  "create",
  "from",
  "have",
  "into",
  "make",
  "should",
  "that",
  "their",
  "this",
  "website",
  "with",
]);

const PINNED_CHAT_PATHS = [
  "README.md",
  "GET-STARTED.md",
  "AGENTS.md",
  "ads/CONTEXT-FOR-AGENT.md",
  "ads/PROMPT-FOR-AGENT.md",
  "ads/README.md",
  "ads/package.json",
  "ads/src/app/page.tsx",
  "ads/src/app/layout.tsx",
  "ads/src/app/post/page.tsx",
  "ads/src/app/my-ads/page.tsx",
  "ads/src/app/ads/page.tsx",
  "ads/src/lib/store.ts",
  "ads/src/lib/types.ts",
  "ads/src/lib/taxonomy.ts",
  "docs/README.md",
  "package.json",
  "src/app/page.tsx",
];

const AGENT_BRIEFING_PATH =
  /(^|\/)(context-for-agent|prompt-for-agent|agents)\.md$/i;

export function isAgentBriefingPath(filePath: string): boolean {
  return AGENT_BRIEFING_PATH.test(filePath);
}

/**
 * Reads a small, known set of files without listing the whole Git tree.
 * Chat uses this first so a huge repo cannot time out and leave the model
 * inventing the product.
 */
export async function retrievePinnedRepositoryFiles(
  github: GitHubProvider,
  owner: string,
  repository: string,
  ref: string,
): Promise<GitHubContextFile[]> {
  const fetched = await Promise.all(
    PINNED_CHAT_PATHS.map(
      async (filePath): Promise<GitHubContextFile | null> => {
        if (isSensitivePath(filePath)) return null;
        try {
          const file = await github.readFile(owner, repository, filePath, ref);
          const redacted = redactSecrets(file.content);
          if (redacted.length > 256_000 || redacted.includes("\0")) return null;
          return {
            path: file.path,
            content: boundedExcerpt(redacted, [], 8_000),
            score: pinnedFileScore(file.path),
          };
        } catch {
          return null;
        }
      },
    ),
  );
  return fetched
    .filter((file): file is GitHubContextFile => file !== null)
    .sort((a, b) => b.score - a.score);
}

/**
 * List the branch and read files under a deadline. Pinned briefings start
 * immediately so a slow tree walk cannot leave the model inventing the product.
 */
export async function retrieveChatRepositoryContext(
  github: GitHubProvider,
  owner: string,
  repository: string,
  ref: string,
  question: string,
  timeoutMs = 12_000,
): Promise<RepositorySnapshot> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  const listPromise = github
    .listFiles(owner, repository, ref)
    .then((listed) =>
      listed.filter(
        (filePath) =>
          !isSensitivePath(filePath) && SOURCE_EXTENSION.test(filePath),
      ),
    )
    .catch(() => [] as string[]);

  const pinnedPromise = retrievePinnedRepositoryFiles(
    github,
    owner,
    repository,
    ref,
  );

  const pinned = await withTimeout(pinnedPromise, remaining(), []);
  const paths = await withTimeout(listPromise, remaining(), []);
  const byPath = new Map(pinned.map((file) => [file.path, file]));

  const unreadBriefings = paths.filter(
    (filePath) => isAgentBriefingPath(filePath) && !byPath.has(filePath),
  );
  if (unreadBriefings.length > 0 && remaining() > 800) {
    const briefings = await withTimeout(
      readNamedFiles(github, owner, repository, ref, unreadBriefings, 60),
      remaining(),
      [],
    );
    for (const file of briefings) byPath.set(file.path, file);
  }

  if (paths.length > 0 && remaining() > 1_500) {
    const extra = await withTimeout(
      readRankedFiles(github, owner, repository, ref, paths, question, 6),
      remaining(),
      [],
    );
    for (const file of extra) {
      const existing = byPath.get(file.path);
      if (!existing || file.score > existing.score) byPath.set(file.path, file);
    }
  }

  return {
    paths,
    files: [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, 10),
  };
}

export function formatBranchListing(paths: string[], limit = 280): string {
  if (paths.length === 0) return "";
  const preferred = paths.filter(
    (filePath) =>
      isAgentBriefingPath(filePath) ||
      /^(ads|src|app|docs)\//i.test(filePath) ||
      /(^|\/)(readme\.md|package\.json)$/i.test(filePath),
  );
  const rest = paths.filter((filePath) => !preferred.includes(filePath));
  const listed = [...preferred, ...rest].slice(0, limit);
  const extra = paths.length - listed.length;
  return extra > 0
    ? `${listed.join("\n")}\n… ${extra} more files on this branch`
    : listed.join("\n");
}

async function readNamedFiles(
  github: GitHubProvider,
  owner: string,
  repository: string,
  ref: string,
  filePaths: string[],
  score: number,
): Promise<GitHubContextFile[]> {
  const fetched = await Promise.all(
    filePaths
      .slice(0, 8)
      .map(async (filePath): Promise<GitHubContextFile | null> => {
        if (isSensitivePath(filePath)) return null;
        try {
          const file = await github.readFile(owner, repository, filePath, ref);
          const redacted = redactSecrets(file.content);
          if (redacted.length > 256_000 || redacted.includes("\0")) return null;
          return {
            path: file.path,
            content: boundedExcerpt(redacted, [], 8_000),
            score,
          };
        } catch {
          return null;
        }
      }),
  );
  return fetched.filter((file): file is GitHubContextFile => file !== null);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function readRankedFiles(
  github: GitHubProvider,
  owner: string,
  repository: string,
  ref: string,
  allPaths: string[],
  taskText: string,
  limit: number,
): Promise<GitHubContextFile[]> {
  const terms = taskTerms(taskText);
  const rankedPaths = allPaths
    .map((filePath) => ({ path: filePath, score: pathScore(filePath, terms) }))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, 32);
  const fetched = await Promise.all(
    rankedPaths.map(async (candidate): Promise<GitHubContextFile | null> => {
      try {
        const file = await github.readFile(
          owner,
          repository,
          candidate.path,
          ref,
        );
        const redacted = redactSecrets(file.content);
        if (redacted.length > 256_000 || redacted.includes("\0")) return null;
        const contentScore = terms.reduce((score, term) => {
          const matches = redacted.toLowerCase().split(term).length - 1;
          return score + Math.min(matches, 8) * 2;
        }, 0);
        return {
          path: candidate.path,
          content: boundedExcerpt(redacted, terms),
          score: candidate.score + contentScore,
        };
      } catch {
        return null;
      }
    }),
  );
  const files = fetched
    .filter((file): file is GitHubContextFile => file !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  let totalCharacters = 0;
  return files.filter((file) => {
    totalCharacters += file.content.length;
    return totalCharacters <= 80_000;
  });
}

export async function retrieveGitHubContext(
  github: GitHubProvider,
  owner: string,
  repository: string,
  ref: string,
  taskText: string,
  limit = 12,
): Promise<{
  totalFiles: number;
  paths: string[];
  files: GitHubContextFile[];
}> {
  const allPaths = (await github.listFiles(owner, repository, ref)).filter(
    (filePath) => !isSensitivePath(filePath) && SOURCE_EXTENSION.test(filePath),
  );
  const files = await readRankedFiles(
    github,
    owner,
    repository,
    ref,
    allPaths,
    taskText,
    limit,
  );
  return { totalFiles: allPaths.length, paths: allPaths, files };
}

export function selectWorkspaceContextPaths(
  allPaths: string[],
  requestedPaths: string[],
  taskText: string,
  limit = 16,
): string[] {
  const allowed = new Set(allPaths.filter((item) => !isSensitivePath(item)));
  const requested = requestedPaths.filter((item) => allowed.has(item));
  const briefings = allPaths.filter(
    (item) => allowed.has(item) && isAgentBriefingPath(item),
  );
  const terms = taskTerms(taskText);
  const ranked = allPaths
    .filter((item) => allowed.has(item) && SOURCE_EXTENSION.test(item))
    .sort((a, b) => pathScore(b, terms) - pathScore(a, terms));
  return [...new Set([...briefings, ...requested, ...ranked])].slice(0, limit);
}

function taskTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 24);
}

function pinnedFileScore(filePath: string): number {
  if (isAgentBriefingPath(filePath)) return 60;
  if (/(^|\/)readme\.md$/i.test(filePath)) return 40;
  return 10;
}

function pathScore(filePath: string, terms: string[]): number {
  const lower = filePath.toLowerCase();
  let score = terms.reduce(
    (total, term) => total + (lower.includes(term) ? 12 : 0),
    0,
  );
  if (isAgentBriefingPath(filePath)) score += 50;
  if (/(^|\/)readme\.md$/i.test(filePath)) score += 24;
  if (
    /(^|\/)(package\.json|pyproject\.toml|go\.mod|cargo\.toml)$/i.test(filePath)
  )
    score += 18;
  if (/\.(?:test|spec)\.[jt]sx?$/i.test(filePath)) score += 4;
  if (/(^|\/)(src|app|pages|components|lib)\//i.test(filePath)) score += 3;
  if (/\.(?:min\.js|map)$/i.test(filePath)) score -= 20;
  return score;
}

function boundedExcerpt(
  content: string,
  terms: string[],
  limit = 10_000,
): string {
  if (content.length <= limit) return content;
  const lower = content.toLowerCase();
  const match =
    terms
      .map((term) => lower.indexOf(term))
      .find((position) => position >= 0) ?? 0;
  const start = Math.max(0, match - 1_500);
  return `${start > 0 ? "…\n" : ""}${content.slice(start, start + limit)}${start + limit < content.length ? "\n…" : ""}`;
}
