import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubProvider, requireApiSessionUser } from "@/lib/auth";
import { GET } from "@/app/api/repositories/[id]/branches/route";

vi.mock("@/lib/auth", () => ({
  getGitHubProvider: vi.fn(),
  requireApiSessionUser: vi.fn(),
}));

describe("repository branches API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns every GitHub branch for the selected authorized repository", async () => {
    vi.mocked(requireApiSessionUser).mockResolvedValue({
      id: "user-1",
    } as never);
    const provider = {
      listRepositories: vi.fn().mockResolvedValue([
        {
          id: "42",
          owner: "acme",
          name: "app",
          fullName: "acme/app",
          defaultBranch: "main",
        },
      ]),
      listBranches: vi
        .fn()
        .mockResolvedValue(["main", "feature/windows-validation"]),
    };
    vi.mocked(getGitHubProvider).mockResolvedValue(provider as never);

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "42" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      branches: ["main", "feature/windows-validation"],
      defaultBranch: "main",
    });
    expect(provider.listBranches).toHaveBeenCalledWith("acme", "app");
  });
});
