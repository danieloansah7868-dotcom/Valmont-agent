import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/repositories/route";

const mocks = vi.hoisted(() => ({
  createRepository: vi.fn(),
  getGitHubProvider: vi.fn(),
  requireApiSessionUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  NotConnectedError: class NotConnectedError extends Error {},
  getGitHubProvider: mocks.getGitHubProvider,
  requireApiSessionUser: mocks.requireApiSessionUser,
}));

const csrf = "1234567890abcdef";

function request(body: unknown, includeCsrf = true) {
  return new NextRequest("http://localhost/api/repositories", {
    method: "POST",
    headers: includeCsrf
      ? {
          cookie: `valmont_csrf=${csrf}`,
          "content-type": "application/json",
          "x-valmont-csrf": csrf,
          "x-forwarded-for": "192.0.2.20",
        }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const createdRepository = {
  id: "42",
  owner: "octocat",
  name: "new-project",
  fullName: "octocat/new-project",
  description: "A fresh project",
  defaultBranch: "main",
  private: true,
  language: "Unknown",
  updatedAt: "2026-08-15T00:00:00Z",
};

describe("repository creation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiSessionUser.mockResolvedValue({ id: "user-1" });
    mocks.getGitHubProvider.mockResolvedValue({
      createRepository: mocks.createRepository,
    });
    mocks.createRepository.mockResolvedValue(createdRepository);
  });

  it("safely defaults to a private repository for an authenticated user", async () => {
    const response = await POST(
      request({
        name: "new-project",
        description: "A fresh project",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      repository: createdRepository,
    });
    expect(mocks.requireApiSessionUser).toHaveBeenCalledOnce();
    expect(mocks.createRepository).toHaveBeenCalledWith({
      name: "new-project",
      description: "A fresh project",
      visibility: "private",
    });
  });

  it("forwards an explicit public visibility choice", async () => {
    const response = await POST(
      request({ name: "open-project", visibility: "public" }),
    );

    expect(response.status).toBe(201);
    expect(mocks.createRepository).toHaveBeenCalledWith({
      name: "open-project",
      description: undefined,
      visibility: "public",
    });
  });

  it("rejects invalid names without calling GitHub", async () => {
    const response = await POST(
      request({ name: "../unsafe", visibility: "private" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.getGitHubProvider).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it("requires a valid same-origin CSRF token", async () => {
    const response = await POST(
      request({ name: "new-project", visibility: "private" }, false),
    );

    expect(response.status).toBe(403);
    expect(mocks.requireApiSessionUser).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });
});
