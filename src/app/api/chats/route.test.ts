import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createChat } from "@/app/api/chats/route";
import { POST as sendMessage } from "@/app/api/chats/[id]/messages/route";
import type { ChatSession } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  appendMessages: vi.fn(),
  create: vi.fn(),
  createModelProvider: vi.fn(),
  get: vi.fn(),
  getGitHubProvider: vi.fn(),
  list: vi.fn(),
  retrieveGitHubContext: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  NotConnectedError: class NotConnectedError extends Error {},
  requireApiSessionUser: vi.fn().mockResolvedValue({
    id: "user-1",
    login: "octocat",
    name: "Octo Cat",
  }),
  getGitHubProvider: mocks.getGitHubProvider,
}));

vi.mock("@/lib/chat-store", () => ({
  getChatStore: () => ({
    appendMessages: mocks.appendMessages,
    create: mocks.create,
    get: mocks.get,
    list: mocks.list,
  }),
}));

vi.mock("@/lib/models", () => ({
  createModelProvider: mocks.createModelProvider,
}));

vi.mock("@/lib/github-retrieval", () => ({
  retrieveGitHubContext: mocks.retrieveGitHubContext,
}));

const csrf = "1234567890abcdef";

function mutationRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      cookie: `valmont_csrf=${csrf}`,
      "content-type": "application/json",
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify(body),
  });
}

function emptySession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-1",
    userId: "user-1",
    title: "New conversation",
    messages: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("chat APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
  });

  it("creates a general session without requesting repository access", async () => {
    const session = emptySession();
    mocks.create.mockResolvedValue(session);

    const response = await createChat(
      mutationRequest("http://localhost/api/chats", { title: "General help" }),
    );

    expect(response.status).toBe(201);
    expect(mocks.getGitHubProvider).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith({
      userId: "user-1",
      title: "General help",
      repository: undefined,
    });
  });

  it("stores only a selected authorized repository and valid branch", async () => {
    const github = {
      listRepositories: vi.fn().mockResolvedValue([
        {
          id: "42",
          owner: "acme",
          name: "app",
          fullName: "acme/app",
        },
      ]),
      listBranches: vi.fn().mockResolvedValue(["main", "feature/chat"]),
    };
    mocks.getGitHubProvider.mockResolvedValue(github);
    mocks.create.mockResolvedValue(emptySession());

    const response = await createChat(
      mutationRequest("http://localhost/api/chats", {
        repositoryId: "42",
        baseBranch: "feature/chat",
      }),
    );

    expect(response.status).toBe(201);
    expect(github.listBranches).toHaveBeenCalledWith("acme", "app");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: {
          id: "42",
          owner: "acme",
          name: "app",
          fullName: "acme/app",
          baseBranch: "feature/chat",
        },
      }),
    );
  });

  it("sends a general message through the model and persists both turns", async () => {
    const session = emptySession();
    const chat = vi.fn().mockResolvedValue({
      content: "Hello! How can I help?",
      model: "gemini-test",
      provider: "openai-compatible",
      finishReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
    });
    mocks.get.mockResolvedValue(session);
    mocks.createModelProvider.mockReturnValue({ chat });
    mocks.appendMessages.mockImplementation(
      async (_id, _userId, messages, titleIfNew) => ({
        ...session,
        title: titleIfNew ?? session.title,
        messages,
      }),
    );

    const response = await sendMessage(
      mutationRequest("http://localhost/api/chats/chat-1/messages", {
        content: "Help me reason about an API",
      }),
      { params: Promise.resolve({ id: "chat-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("chat-1", "user-1");
    expect(mocks.getGitHubProvider).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("cannot edit repository files"),
          }),
        ]),
      }),
    );
    expect(mocks.appendMessages).toHaveBeenCalledWith(
      "chat-1",
      "user-1",
      [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ],
      "Help me reason about an API",
    );
  });

  it("rechecks repository authorization before retrieving read-only context", async () => {
    const session = emptySession({
      repository: {
        id: "42",
        owner: "acme",
        name: "app",
        fullName: "acme/app",
        baseBranch: "main",
      },
    });
    const github = {
      listRepositories: vi
        .fn()
        .mockResolvedValue([
          { id: "42", owner: "acme", name: "app", fullName: "acme/app" },
        ]),
      listBranches: vi.fn().mockResolvedValue(["main"]),
    };
    mocks.get.mockResolvedValue(session);
    mocks.getGitHubProvider.mockResolvedValue(github);
    mocks.retrieveGitHubContext.mockResolvedValue({
      totalFiles: 1,
      files: [{ path: "README.md", content: "Project docs", score: 10 }],
    });
    mocks.createModelProvider.mockReturnValue({
      chat: vi.fn().mockResolvedValue({
        content: "The README describes the project.",
        model: "gemini-test",
        provider: "openai-compatible",
        finishReason: "stop",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    });
    mocks.appendMessages.mockImplementation(
      async (_id, _userId, messages, titleIfNew) => ({
        ...session,
        title: titleIfNew ?? session.title,
        messages,
      }),
    );

    const response = await sendMessage(
      mutationRequest("http://localhost/api/chats/chat-1/messages", {
        content: "What does this project do?",
      }),
      { params: Promise.resolve({ id: "chat-1" }) },
    );

    expect(response.status).toBe(200);
    expect(github.listBranches).toHaveBeenCalledWith("acme", "app");
    expect(mocks.retrieveGitHubContext).toHaveBeenCalledWith(
      github,
      "acme",
      "app",
      "main",
      "What does this project do?",
      8,
    );
  });
});
