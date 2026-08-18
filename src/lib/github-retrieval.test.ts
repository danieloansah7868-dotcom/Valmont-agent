import { describe, expect, it, vi } from "vitest";
import {
  retrieveChatRepositoryContext,
  retrievePinnedRepositoryFiles,
} from "@/lib/github-retrieval";

function githubWith(files: Record<string, string>) {
  return {
    readFile: vi.fn(async (_o: string, _r: string, filePath: string) => {
      const content = files[filePath];
      if (!content) throw new Error("missing");
      return { path: filePath, sha: "1", content };
    }),
    listFiles: vi.fn(async () => Object.keys(files)),
  };
}

describe("chat repository reading", () => {
  it("reads pinned ads files without needing the full tree", async () => {
    const github = githubWith({
      "ads/README.md": "Ghana classifieds. Kofi sells a fridge.",
      "ads/src/app/page.tsx": "export default function Home() { return null }",
    });
    const files = await retrievePinnedRepositoryFiles(
      github as never,
      "acme",
      "data",
      "main",
    );
    expect(files.map((file) => file.path)).toEqual([
      "ads/README.md",
      "ads/src/app/page.tsx",
    ]);
    expect(github.listFiles).not.toHaveBeenCalled();
  });

  it("keeps pinned files when the tree walk fails", async () => {
    const github = {
      readFile: vi.fn(async (_o: string, _r: string, filePath: string) => {
        if (filePath !== "ads/README.md") throw new Error("missing");
        return { path: filePath, sha: "1", content: "Classifieds only." };
      }),
      listFiles: vi.fn(async () => {
        throw new Error("tree too large");
      }),
    };
    const files = await retrieveChatRepositoryContext(
      github as never,
      "acme",
      "data",
      "main",
      "what is missing?",
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain("Classifieds");
  });
});
