import { describe, expect, it, vi } from "vitest";
import { DemoModelProvider } from "@/lib/models/demo";
import { createModelProvider } from "@/lib/models";
import { OpenAICompatibleProvider } from "@/lib/models/openai-compatible";
import type { ModelProvider } from "@/lib/models/types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function acceptsProvider(provider: ModelProvider): string {
  return provider.id;
}

describe("model provider abstraction", () => {
  it("selects clearly labelled demo mode without credentials", async () => {
    const provider = createModelProvider({});
    expect(provider).toBeInstanceOf(DemoModelProvider);
    expect(provider.demo).toBe(true);
    expect(acceptsProvider(provider)).toBe("demo-provider");
    const response = await provider.chat({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.content).toMatch(/Demo mode/);
    expect(response.usage.totalTokens).toBe(0);
  });

  it("normalizes chat, usage, and tool calls from OpenAI-compatible APIs", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          model: "test-model",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"src/app.ts"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "server-only-key",
      baseUrl: "https://model.example/v1/",
      model: "test-model",
      fetcher,
    });
    const response = await provider.chat({
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        {
          name: "read_file",
          description: "Read an allowed file",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(response.provider).toBe("openai-compatible");
    expect(response.usage.totalTokens).toBe(17);
    expect(response.toolCalls[0]).toEqual({
      id: "call-1",
      name: "read_file",
      arguments: { path: "src/app.ts" },
    });
    const request = fetcher.mock.calls[0]![1]!;
    expect((request.headers as Record<string, string>).authorization).toBe(
      "Bearer server-only-key",
    );
    expect(JSON.parse(String(request.body)).stream).toBe(false);
  });

  it("validates structured model output through the caller contract", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: '{"answer":42}' } },
          ],
          usage: {},
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "key",
      baseUrl: "https://model.example/v1",
      model: "model",
      fetcher,
    });
    const result = await provider.structured({
      schemaName: "answer",
      jsonSchema: { type: "object" },
      messages: [],
      validate(value) {
        const data = value as { answer?: number };
        if (data.answer !== 42) throw new Error("invalid");
        return { answer: data.answer };
      },
    });
    expect(result.data).toEqual({ answer: 42 });
    expect(
      JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).response_format.type,
    ).toBe("json_schema");
  });
});
