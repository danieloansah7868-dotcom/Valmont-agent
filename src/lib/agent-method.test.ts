import { describe, expect, it } from "vitest";
import { AGENT_WORKING_METHOD } from "@/lib/agent-method";
import { buildChatCompletionMessages } from "@/lib/chat";
import type { ChatSession } from "@/lib/types";

function session(overrides: Partial<ChatSession> = {}): ChatSession {
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

describe("agent working method", () => {
  it("teaches fetch-first, do-not-invent, do-not-rebuild", () => {
    expect(AGENT_WORKING_METHOD).toContain("Fetch first");
    expect(AGENT_WORKING_METHOD).toContain("CONTEXT-FOR-AGENT.md");
    expect(AGENT_WORKING_METHOD).toContain("Already-built stays built");
    expect(AGENT_WORKING_METHOD).toContain("One job");
    expect(AGENT_WORKING_METHOD).toContain("classifieds");
    expect(AGENT_WORKING_METHOD).toContain("escrow");
  });

  it("is injected into every chat completion", () => {
    const messages = buildChatCompletionMessages({
      session: session(),
      userContent: "What should we build?",
    });
    expect(messages[0]?.content).toContain("Fetch first");
    expect(messages[0]?.content).toContain("Already-built stays built");
    expect(messages[0]?.content).toContain("One job");
  });
});
