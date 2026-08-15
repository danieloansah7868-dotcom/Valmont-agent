import { describe, expect, it, vi } from "vitest";
import { GitHubApiProvider } from "@/lib/github/github";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe("GitHub API adapter", () => {
  it("lists only data returned by the authorized user endpoint", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return json([
        {
          id: 12,
          name: "app",
          full_name: "acme/app",
          private: true,
          description: null,
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-14T00:00:00Z",
          owner: { login: "acme" },
        },
      ]);
    });
    const provider = new GitHubApiProvider({
      accessToken: "encrypted-session-token",
      fetcher,
    });
    const repositories = await provider.listRepositories();
    expect(repositories[0]).toMatchObject({
      id: "12",
      fullName: "acme/app",
      private: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("/user/repos?");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer encrypted-session-token",
    );
  });

  it("creates and initializes a repository with the selected visibility", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      expect(String(input)).toBe("https://api.github.com/user/repos");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "private-project",
        description: "A new project",
        private: true,
        auto_init: true,
      });
      return json(
        {
          id: 21,
          name: "private-project",
          full_name: "octocat/private-project",
          private: true,
          description: "A new project",
          default_branch: "main",
          language: null,
          updated_at: "2026-08-15T00:00:00Z",
          owner: { login: "octocat" },
        },
        201,
      );
    });
    const provider = new GitHubApiProvider({ accessToken: "token", fetcher });

    await expect(
      provider.createRepository({
        name: "private-project",
        description: "A new project",
        visibility: "private",
      }),
    ).resolves.toMatchObject({
      id: "21",
      fullName: "octocat/private-project",
      private: true,
      defaultBranch: "main",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects invalid repository creation input before GitHub is contacted", async () => {
    const fetcher = vi.fn();
    const provider = new GitHubApiProvider({ accessToken: "token", fetcher });

    await expect(
      provider.createRepository({ name: "../unsafe", visibility: "public" }),
    ).rejects.toThrow(/repository name/i);
    await expect(
      provider.createRepository({
        name: "valid",
        visibility: "private",
        description: "x".repeat(351),
      }),
    ).rejects.toThrow(/too long/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates only valmont branches from the requested base SHA", async () => {
    const fetcher = vi.fn(async (url: FetchInput, init?: FetchInit) => {
      void url;
      return init?.method === "POST"
        ? json({})
        : json({ object: { sha: "base-sha" } });
    });
    const provider = new GitHubApiProvider({ accessToken: "token", fetcher });
    await provider.createBranch(
      "acme",
      "app",
      "main",
      "valmont/fix-empty-state",
    );
    const createBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(createBody).toEqual({
      ref: "refs/heads/valmont/fix-empty-state",
      sha: "base-sha",
    });
    await expect(
      provider.createBranch("acme", "app", "main", "main"),
    ).rejects.toThrow(/valmont/);
  });

  it("blocks sensitive file reads before making a request", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return json({});
    });
    const provider = new GitHubApiProvider({ accessToken: "token", fetcher });
    await expect(
      provider.readFile("acme", "app", ".env", "main"),
    ).rejects.toThrow(/Sensitive/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates a pull request but exposes no merge operation", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return json({
        id: 101,
        number: 8,
        html_url: "https://github.com/acme/app/pull/8",
        title: "Fix",
        head: { ref: "valmont/fix" },
        base: { ref: "main" },
      });
    });
    const provider = new GitHubApiProvider({ accessToken: "token", fetcher });
    const pull = await provider.createPullRequest(
      "acme",
      "app",
      "valmont/fix",
      "main",
      "Fix",
      "Reviewed",
    );
    expect(pull.number).toBe(8);
    expect(pull.url).toContain("/pull/8");
    expect("mergePullRequest" in provider).toBe(false);
  });
});
