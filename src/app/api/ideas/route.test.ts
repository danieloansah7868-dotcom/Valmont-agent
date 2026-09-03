import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError } from "@/lib/api-errors";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireApiSessionUser: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireApiSessionUser: mocks.requireApiSessionUser,
}));

vi.mock("@/lib/idea-store", () => ({
  IDEA_STATUSES: ["idea", "planned", "building", "done", "dropped"],
  IDEA_PRIORITIES: [1, 2, 3],
  getIdeaStore: () => ({
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  }),
}));

const csrf = "0123456789abcdef";

function postRequest(body: unknown, opts: { csrf?: boolean } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.csrf !== false) {
    headers.cookie = `valmont_csrf=${csrf}`;
    headers["x-valmont-csrf"] = csrf;
  }
  return new NextRequest("http://localhost/api/ideas", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /api/ideas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers 401 when nobody is signed in", async () => {
    mocks.requireApiSessionUser.mockRejectedValueOnce(new NotConnectedError());
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("lists the signed-in user's ideas", async () => {
    mocks.requireApiSessionUser.mockResolvedValueOnce({ id: "user-1" });
    mocks.list.mockResolvedValueOnce([{ id: "idea-1", title: "Mine" }]);
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ideas).toEqual([{ id: "idea-1", title: "Mine" }]);
    expect(mocks.list).toHaveBeenCalledWith("user-1");
  });
});

describe("POST /api/ideas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it("answers 403 without a CSRF token", async () => {
    const response = await POST(postRequest({ title: "x" }, { csrf: false }));
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 401 when nobody is signed in", async () => {
    mocks.requireApiSessionUser.mockReset();
    mocks.requireApiSessionUser.mockRejectedValueOnce(new NotConnectedError());
    const response = await POST(postRequest({ title: "x" }));
    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 400 for an empty title", async () => {
    const response = await POST(postRequest({ title: "   " }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 400 for a title longer than 120 characters", async () => {
    const response = await POST(postRequest({ title: "a".repeat(121) }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown status", async () => {
    const response = await POST(
      postRequest({ title: "Good title", status: "someday" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 400 for an out-of-range priority", async () => {
    const response = await POST(
      postRequest({ title: "Good title", priority: 4 }),
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 400 when the text looks like a secret (ghp_ token)", async () => {
    const response = await POST(
      postRequest({
        title: "Store this key",
        details: "ghp_" + "a".repeat(36),
      }),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Ideas cannot contain secrets");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates an idea on the happy path and answers 201", async () => {
    mocks.create.mockImplementationOnce(async (_userId, input) => ({
      id: "idea-1",
      userId: "user-1",
      title: input.title,
      details: input.details ?? "",
      status: input.status ?? "idea",
      priority: input.priority ?? 2,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    }));
    const response = await POST(
      postRequest({
        title: "  Ship migration 0013  ",
        details: "  ideas table  ",
        status: "planned",
        priority: 1,
      }),
    );
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.idea).toMatchObject({
      id: "idea-1",
      title: "Ship migration 0013",
      details: "ideas table",
      status: "planned",
      priority: 1,
    });
    expect(mocks.create).toHaveBeenCalledWith("user-1", {
      title: "Ship migration 0013",
      details: "ideas table",
      status: "planned",
      priority: 1,
    });
  });

  it("defaults status and priority and allows an empty details field", async () => {
    mocks.create.mockImplementationOnce(async (_userId, input) => ({
      id: "idea-2",
      userId: "user-1",
      title: input.title,
      details: input.details ?? "",
      status: input.status ?? "idea",
      priority: input.priority ?? 2,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    }));
    const response = await POST(postRequest({ title: "Bare idea" }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("user-1", {
      title: "Bare idea",
      details: "",
      status: undefined,
      priority: 2,
    });
  });
});
