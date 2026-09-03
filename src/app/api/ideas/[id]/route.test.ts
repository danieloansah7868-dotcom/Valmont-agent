import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError } from "@/lib/api-errors";
import { DELETE, PATCH } from "./route";

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

const csrf = "fedcba9876543210";

function request(method: "PATCH" | "DELETE", id: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/ideas/${id}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `valmont_csrf=${csrf}`,
      "x-valmont-csrf": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function noCsrfRequest(method: "PATCH" | "DELETE", id: string) {
  return new NextRequest(`http://localhost/api/ideas/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "done" }),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

function storedIdea(overrides: Record<string, unknown> = {}) {
  return {
    id: "idea-1",
    userId: "user-1",
    title: "Original",
    details: "",
    status: "idea",
    priority: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("PATCH /api/ideas/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it("answers 403 without a CSRF token", async () => {
    const response = await PATCH(
      noCsrfRequest("PATCH", "idea-1"),
      context("idea-1"),
    );
    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("answers 401 when nobody is signed in", async () => {
    mocks.requireApiSessionUser.mockReset();
    mocks.requireApiSessionUser.mockRejectedValueOnce(new NotConnectedError());
    const response = await PATCH(
      request("PATCH", "idea-1", { status: "done" }),
      context("idea-1"),
    );
    expect(response.status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("answers 400 for an empty title", async () => {
    const response = await PATCH(
      request("PATCH", "idea-1", { title: "   " }),
      context("idea-1"),
    );
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("answers 400 for a 121-character title", async () => {
    const response = await PATCH(
      request("PATCH", "idea-1", { title: "b".repeat(121) }),
      context("idea-1"),
    );
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("answers 400 for a bad status", async () => {
    const response = await PATCH(
      request("PATCH", "idea-1", { status: "maybe" }),
      context("idea-1"),
    );
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("answers 400 for secret text", async () => {
    const response = await PATCH(
      request("PATCH", "idea-1", {
        details: "key is ghp_" + "z".repeat(36),
      }),
      context("idea-1"),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Ideas cannot contain secrets");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("answers 404 when the idea belongs to another user", async () => {
    mocks.update.mockResolvedValueOnce(null);
    const response = await PATCH(
      request("PATCH", "idea-9", { status: "done" }),
      context("idea-9"),
    );
    expect(response.status).toBe(404);
    expect(mocks.update).toHaveBeenCalledWith(
      "user-1",
      "idea-9",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("updates and answers 200 with the updated idea", async () => {
    mocks.update.mockImplementationOnce(async (_userId, _id, patch) =>
      storedIdea(patch),
    );
    const response = await PATCH(
      request("PATCH", "idea-1", {
        title: "  New title  ",
        details: "  Notes  ",
        status: "building",
        priority: 1,
      }),
      context("idea-1"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.idea).toMatchObject({
      id: "idea-1",
      title: "New title",
      details: "Notes",
      status: "building",
      priority: 1,
    });
    expect(mocks.update).toHaveBeenCalledWith("user-1", "idea-1", {
      title: "New title",
      details: "Notes",
      status: "building",
      priority: 1,
    });
  });
});

describe("DELETE /api/ideas/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it("answers 403 without a CSRF token", async () => {
    const response = await DELETE(
      noCsrfRequest("DELETE", "idea-1"),
      context("idea-1"),
    );
    expect(response.status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("answers 401 when nobody is signed in", async () => {
    mocks.requireApiSessionUser.mockReset();
    mocks.requireApiSessionUser.mockRejectedValueOnce(new NotConnectedError());
    const response = await DELETE(
      request("DELETE", "idea-1"),
      context("idea-1"),
    );
    expect(response.status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("answers 404 when the idea belongs to another user", async () => {
    mocks.remove.mockResolvedValueOnce(false);
    const response = await DELETE(
      request("DELETE", "idea-9"),
      context("idea-9"),
    );
    expect(response.status).toBe(404);
    expect(mocks.remove).toHaveBeenCalledWith("user-1", "idea-9");
  });

  it("deletes and answers 204", async () => {
    mocks.remove.mockResolvedValueOnce(true);
    const response = await DELETE(
      request("DELETE", "idea-1"),
      context("idea-1"),
    );
    expect(response.status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith("user-1", "idea-1");
  });
});
