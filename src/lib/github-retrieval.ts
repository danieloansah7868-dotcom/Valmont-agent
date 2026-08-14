import type { GitHubProvider } from "@/lib/github/types";
import { isSensitivePath } from "@/lib/retrieval";
import { redactSecrets } from "@/lib/security";

export interface GitHubContextFile {
  path: string;
  content: string;
  score: number;
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

/** Bounded GitHub lexical retrieval. Raw content is never persisted by this layer. */
export async function retrieveGitHubContext(
  github: GitHubProvider,
  owner: string,
  repository: string,
  ref: string,
  taskText: string,
  limit = 12,
): Promise<{ totalFiles: number; files: GitHubContextFile[] }> {
  const allPaths = (await github.listFiles(owner, repository, ref)).filter(
    (filePath) => !isSensitivePath(filePath) && SOURCE_EXTENSION.test(filePath),
  );
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
  const bounded = files.filter((file) => {
    totalCharacters += file.content.length;
    return totalCharacters <= 80_000;
  });
  return { totalFiles: allPaths.length, files: bounded };
}

export function selectWorkspaceContextPaths(
  allPaths: string[],
  requestedPaths: string[],
  taskText: string,
  limit = 16,
): string[] {
  const allowed = new Set(allPaths.filter((item) => !isSensitivePath(item)));
  const requested = requestedPaths.filter((item) => allowed.has(item));
  const terms = taskTerms(taskText);
  const ranked = allPaths
    .filter((item) => allowed.has(item) && SOURCE_EXTENSION.test(item))
    .sort((a, b) => pathScore(b, terms) - pathScore(a, terms));
  return [...new Set([...requested, ...ranked])].slice(0, limit);
}

function taskTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 24);
}

function pathScore(filePath: string, terms: string[]): number {
  const lower = filePath.toLowerCase();
  let score = terms.reduce(
    (total, term) => total + (lower.includes(term) ? 12 : 0),
    0,
  );
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
