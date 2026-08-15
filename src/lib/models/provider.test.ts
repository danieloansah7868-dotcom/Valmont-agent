import { describe, expect, it, vi } from "vitest";
import { createModelProvider, tryCreateModelProvider } from "@/lib/models";
import { OpenAICompatibleProvider } from "@/lib/models/openai-compatible";
import type { ModelProvider } from "@/lib/models/types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function acceptsProvider(provider: ModelProvider): string {
  return provider.id;
}

describe("model provider abstraction", () => {
  it("refuses to fabricate output when no credentials are set", () => {
    expect(() => createModelProvider({})).toThrow(/MODEL_API_KEY/);
    expect(tryCreateModelProvider({})).toBeNull();
  });

  it("ignores a legacy ENABLE_DEMO_MODE variable", () => {
    expect(() => createModelProvider({ ENABLE_DEMO_MODE: "true" })).toThrow(
      /MODEL_API_KEY/,
    );
    expect(tryCreateModelProvider({ ENABLE_DEMO_MODE: "true" })).toBeNull();
  });

  it("builds an OpenAI-compatible provider from real credentials", () => {
    const provider = createModelProvider({ MODEL_API_KEY: "server-only-key" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(acceptsProvider(provider)).toBe("openai-compatible");
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
      jsonSchema: {
        type: "object",
        properties: { operation: { const: "write" } },
      },
      messages: [],
      validate(value) {
        const data = value as { answer?: number };
        if (data.answer !== 42) throw new Error("invalid");
        return { answer: data.answer };
      },
    });
    expect(result.data).toEqual({ answer: 42 });
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as {
      response_format: {
        type: string;
        json_schema: {
          schema: {
            properties: {
              operation: Record<string, unknown>;
            };
          };
        };
      };
    };
    expect(requestBody.response_format.type).toBe("json_schema");
    expect(
      requestBody.response_format.json_schema.schema.properties.operation,
    ).toEqual({ enum: ["write"], type: "string" });
    expect(JSON.stringify(requestBody)).not.toContain('"const"');
  });

  it("surfaces messages from Gemini array-wrapped provider errors", async () => {
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify([
          {
            error: {
              code: 400,
              message: 'Unknown name "const" at schema.properties[0]',
              status: "INVALID_ARGUMENT",
            },
          },
        ]),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-test",
      fetcher,
    });

    await expect(
      provider.structured({
        schemaName: "answer",
        jsonSchema: { type: "object" },
        messages: [],
        validate: (value) => value,
      }),
    ).rejects.toMatchObject({
      message: 'Unknown name "const" at schema.properties[0]',
      code: "400",
    });
  });
});
