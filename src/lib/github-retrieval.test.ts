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
    const snapshot = await retrieveChatRepositoryContext(
      github as never,
      "acme",
      "data",
      "main",
      "what is missing?",
    );
    expect(snapshot.paths).toEqual([]);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.content).toContain("Classifieds");
  });

  it("lists the branch and reads file contents", async () => {
    const github = githubWith({
      "ads/README.md": "Classifieds.",
      "ads/src/app/page.tsx": "export default function Home() { return null }",
    });
    const snapshot = await retrieveChatRepositoryContext(
      github as never,
      "acme",
      "data",
      "main",
      "continue the ads work",
    );
    expect(github.listFiles).toHaveBeenCalledOnce();
    expect(snapshot.paths).toEqual(["ads/README.md", "ads/src/app/page.tsx"]);
    expect(snapshot.files.map((file) => file.path)).toContain("ads/README.md");
  });

  it("ranks CONTEXT-FOR-AGENT above other ads files", async () => {
    const github = githubWith({
      "ads/CONTEXT-FOR-AGENT.md":
        "A classifieds marketplace for Ghana. Not an ad network.",
      "ads/README.md": "Valmont Ads — Ghana classifieds marketplace",
      "ads/src/app/page.tsx": "export default function Home() { return null }",
    });
    const snapshot = await retrieveChatRepositoryContext(
      github as never,
      "acme",
      "Valmont-data",
      "main",
      "what is this product?",
    );
    expect(snapshot.files[0]?.path).toBe("ads/CONTEXT-FOR-AGENT.md");
    expect(snapshot.files[0]?.content).toContain("classifieds marketplace");
  });

  it("returns pinned briefings when the tree listing hangs", async () => {
    const github = {
      readFile: vi.fn(async (_o: string, _r: string, filePath: string) => {
        if (filePath !== "ads/CONTEXT-FOR-AGENT.md") throw new Error("missing");
        return {
          path: filePath,
          sha: "1",
          content: "Classifieds only. Do not invent CPM slots.",
        };
      }),
      listFiles: vi.fn(() => new Promise<string[]>(() => {})),
    };
    const snapshot = await retrieveChatRepositoryContext(
      github as never,
      "acme",
      "data",
      "main",
      "what is Valmont Ads?",
      80,
    );
    expect(snapshot.paths).toEqual([]);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.path).toBe("ads/CONTEXT-FOR-AGENT.md");
    expect(snapshot.files[0]?.content).toContain("Classifieds only");
  });

  it("reads a briefing found on the branch even if it was not pre-pinned", async () => {
    const github = githubWith({
      "packages/ads/CONTEXT-FOR-AGENT.md":
        "This is classifieds, not an advertising network.",
      "packages/ads/src/app/page.tsx": "export default function Home() {}",
    });
    const snapshot = await retrieveChatRepositoryContext(
      github as never,
      "acme",
      "data",
      "main",
      "describe the product",
    );
    expect(snapshot.files.map((file) => file.path)).toContain(
      "packages/ads/CONTEXT-FOR-AGENT.md",
    );
  });
});
