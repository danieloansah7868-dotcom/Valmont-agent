import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { x as extractTar } from "tar";
import type { GitHubProvider } from "@/lib/github/types";
import { isSensitivePath } from "@/lib/retrieval";

const MAX_ENTRIES = 20_000;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;

/** Downloads an authorized snapshot and extracts only safe regular files into a private source area. */
export async function prepareRepositorySource(
  github: GitHubProvider,
  taskId: string,
  owner: string,
  repository: string,
  ref: string,
  baseDirectory = path.join(process.cwd(), ".data", "sources"),
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(taskId))
    throw new Error("Invalid task identifier");
  const taskRoot = path.join(path.resolve(baseDirectory), taskId);
  const sourceRoot = path.join(taskRoot, "source");
  const archivePath = path.join(taskRoot, "repository.tgz");
  await rm(taskRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });

  const archive = await github.downloadArchive(owner, repository, ref);
  await writeFile(archivePath, archive, { mode: 0o600 });
  let entries = 0;
  let extractedBytes = 0;
  try {
    await extractTar({
      file: archivePath,
      cwd: sourceRoot,
      strip: 1,
      preservePaths: false,
      noChmod: true,
      filter: (entryPath, entry) => {
        entries += 1;
        extractedBytes += entry.size ?? 0;
        if (entries > MAX_ENTRIES || extractedBytes > MAX_EXTRACTED_BYTES)
          return false;
        if (
          "type" in entry &&
          (entry.type === "SymbolicLink" || entry.type === "Link")
        ) {
          return false;
        }
        if ("isSymbolicLink" in entry && entry.isSymbolicLink()) return false;
        const relative = entryPath
          .replaceAll("\\", "/")
          .split("/")
          .slice(1)
          .join("/");
        if (!relative) return true;
        if (relative.startsWith("/") || relative.split("/").includes(".."))
          return false;
        return !isSensitivePath(relative);
      },
    });
  } finally {
    await rm(archivePath, { force: true });
  }
  if (entries > MAX_ENTRIES || extractedBytes > MAX_EXTRACTED_BYTES) {
    await rm(taskRoot, { recursive: true, force: true });
    throw new Error("Repository exceeds workspace extraction limits");
  }
  return sourceRoot;
}
