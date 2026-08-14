import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@/lib/security";

const EXCLUDED_NAMES = new Set([
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".netrc",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".lock",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".sqlite",
  ".db",
]);

const SENSITIVE_SEGMENTS = [
  /(^|[/_.-])(secret|credential|private[-_]?key|payment|customer[-_]?data)([/_.-]|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
];

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return (
    parts.some(
      (part) => EXCLUDED_NAMES.has(part) || part.startsWith(".env."),
    ) ||
    EXCLUDED_EXTENSIONS.has(path.extname(normalized).toLowerCase()) ||
    SENSITIVE_SEGMENTS.some((pattern) => pattern.test(normalized))
  );
}

function appearsBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

export interface RetrievedFile {
  path: string;
  content: string;
  score: number;
  matches: number;
}

export interface RepositoryRetriever {
  listFiles(limit?: number): Promise<string[]>;
  readFile(relativePath: string): Promise<string>;
  search(query: string, limit?: number): Promise<RetrievedFile[]>;
}

/** Modular lexical retriever. It deliberately sends only scored, redacted text context. */
export class LocalRepositoryRetriever implements RepositoryRetriever {
  private readonly root: string;
  private readonly maxFileBytes: number;

  constructor(root: string, maxFileBytes = 256_000) {
    this.root = path.resolve(root);
    this.maxFileBytes = maxFileBytes;
  }

  async listFiles(limit = 2_000): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      if (files.length >= limit) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path
          .relative(this.root, absolute)
          .replaceAll("\\", "/");
        if (isSensitivePath(relative) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files.push(relative);
        if (files.length >= limit) break;
      }
    };
    await walk(this.root);
    return files;
  }

  async readFile(relativePath: string): Promise<string> {
    const normalized = this.resolveSafe(relativePath);
    if (isSensitivePath(relativePath))
      throw new Error("Sensitive or generated path is excluded");
    const info = await lstat(normalized);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Only regular files can be read");
    if (info.size > this.maxFileBytes)
      throw new Error("File exceeds retrieval size limit");
    const actual = await realpath(normalized);
    if (!this.isInside(actual)) throw new Error("Path escapes repository root");
    const value = await readFile(actual);
    if (appearsBinary(value)) throw new Error("Binary files are excluded");
    return redactSecrets(value.toString("utf8"));
  }

  async search(query: string, limit = 12): Promise<RetrievedFile[]> {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const tokens = needle.split(/\s+/).filter((token) => token.length > 1);
    const results: RetrievedFile[] = [];
    for (const file of await this.listFiles()) {
      const fileName = file.toLowerCase();
      let content: string;
      try {
        content = await this.readFile(file);
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      const exactMatches = lower.split(needle).length - 1;
      const tokenMatches = tokens.reduce(
        (count, token) => count + Math.min(5, lower.split(token).length - 1),
        0,
      );
      const filenameScore = tokens.reduce(
        (score, token) => score + (fileName.includes(token) ? 8 : 0),
        0,
      );
      const symbolScore = tokens.reduce(
        (score, token) =>
          score +
          (new RegExp(
            `(?:class|function|interface|type|const)\\s+${escapeRegExp(token)}`,
            "i",
          ).test(content)
            ? 10
            : 0),
        0,
      );
      const score =
        exactMatches * 12 + tokenMatches + filenameScore + symbolScore;
      if (score > 0) {
        results.push({
          path: file,
          content: excerpt(content, needle),
          score,
          matches: exactMatches,
        });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private resolveSafe(relativePath: string): string {
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0")
    ) {
      throw new Error("Invalid repository path");
    }
    const absolute = path.resolve(this.root, relativePath);
    if (!this.isInside(absolute))
      throw new Error("Path escapes repository root");
    return absolute;
  }

  private isInside(absolute: string): boolean {
    return (
      absolute === this.root || absolute.startsWith(`${this.root}${path.sep}`)
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerpt(content: string, query: string, limit = 4_000): string {
  if (content.length <= limit) return content;
  const position = content.toLowerCase().indexOf(query);
  const start = Math.max(0, (position >= 0 ? position : 0) - 800);
  return `${start > 0 ? "…\n" : ""}${content.slice(start, start + limit)}${start + limit < content.length ? "\n…" : ""}`;
}
