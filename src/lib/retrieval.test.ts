import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitivePath, LocalRepositoryRetriever } from "@/lib/retrieval";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  ),
);

describe("repository retrieval", () => {
  it.each([
    ".env",
    ".env.production",
    "node_modules/pkg/index.js",
    "keys/private-key.pem",
    ".git/config",
    "credentials.json",
    "dist/app.js",
    "customer-data/export.csv",
  ])("excludes sensitive/generated path %s", (file) => {
    expect(isSensitivePath(file)).toBe(true);
  });

  it("lists and searches only allowed text files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "valmont-retrieval-"));
    temporary.push(root);
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(
      path.join(root, "src", "session.ts"),
      "export function createSession() { return 'safe'; }",
    );
    await writeFile(path.join(root, ".env"), "API_KEY=do-not-read");
    await writeFile(
      path.join(root, "node_modules", "package.js"),
      "createSession leaked",
    );
    const retriever = new LocalRepositoryRetriever(root);
    expect(await retriever.listFiles()).toEqual(["src/session.ts"]);
    const results = await retriever.search("createSession");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("src/session.ts");
    await expect(retriever.readFile("../outside.txt")).rejects.toThrow(
      /escapes/,
    );
    await expect(retriever.readFile(".env")).rejects.toThrow(/excluded/);
  });
});
