import { describe, expect, it, vi } from "vitest";
import { createModelProvider, tryCreateModelProvider } from "@/lib/models";
import {
  compatibleJsonSchema,
  extractJsonText,
  extractMessageText,
  OpenAICompatibleProvider,
} from "@/lib/models/openai-compatible";
import type { ModelProvider } from "@/lib/models/types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function acceptsProvider(provider: ModelProvider): string {
  return provider.id;
}

describe("extractMessageText", () => {
  it("joins Gemini-style content parts into a string", () => {
    expect(
      extractMessageText([
        { type: "text", text: "Hello " },
        { type: "text", text: "Valmont" },
      ]),
    ).toBe("Hello Valmont");
    expect(extractMessageText("plain")).toBe("plain");
    expect(extractMessageText(null)).toBe("");
  });
});

describe("extractJsonText", () => {
  it("unwraps markdown json code fences", () => {
    expect(extractJsonText('```json\n{"hello": "world"}\n```')).toBe(
      '{"hello": "world"}',
    );
    expect(extractJsonText('```\n{"hello": "world"}\n```')).toBe(
      '{"hello": "world"}',
    );
  });

  it("extracts json surrounded by conversational preamble", () => {
    expect(
      extractJsonText('Here is the json output:\n{"a": 1}\nHope this helps!'),
    ).toBe('{"a": 1}');
  });
});

describe("compatibleJsonSchema", () => {
  it("strips OpenAI strict-incompatible validation keywords", () => {
    const raw = {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 2,
          maxLength: 30,
          pattern: "^[A-Z]",
        },
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string" },
        },
        count: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["name"],
    };
    const stripped = compatibleJsonSchema(raw);
    expect(JSON.stringify(stripped)).not.toContain("pattern");
    expect(JSON.stringify(stripped)).not.toContain("minLength");
    expect(JSON.stringify(stripped)).not.toContain("maxLength");
    expect(JSON.stringify(stripped)).not.toContain("minItems");
    expect(JSON.stringify(stripped)).not.toContain("maxItems");
    expect(JSON.stringify(stripped)).not.toContain("minimum");
    expect(JSON.stringify(stripped)).not.toContain("maximum");
  });
});

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

  it("handles structured output wrapped in markdown code fences", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '```json\n{"answer": 99}\n```' },
            },
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
        return value as { answer: number };
      },
    });
    expect(result.data).toEqual({ answer: 99 });
  });

  it("retries with json_object when the provider rejects json_schema with 400", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type: string };
      };
      if (body.response_format?.type === "json_schema") {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_request_error",
              message: "response_format 'json_schema' is not supported",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: '{"answer": 77}' } },
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
        return value as { answer: number };
      },
    });
    expect(result.data).toEqual({ answer: 77 });
    expect(callCount).toBe(2);
  });

  it("lets an aborted fetch propagate as-is without burning the other tiers", async () => {
    // What AbortSignal.timeout rejects fetch with: a DOMException, NOT a
    // ModelProviderError. It must not be mistaken for a tier the provider can
    // fall back from — a timed-out provider is not going to answer faster on
    // the next attempt, and the caller maps the abort to a friendly 504.
    const abortError = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const fetcher = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      throw abortError;
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "key",
      baseUrl: "https://model.example/v1",
      model: "model",
      fetcher,
    });

    await expect(
      provider.structured({
        schemaName: "answer",
        jsonSchema: { type: "object" },
        messages: [],
        validate: (value) => value,
      }),
    ).rejects.toBe(abortError);

    expect(fetcher).toHaveBeenCalledOnce();
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

  it("falls back to plain chat-identical shape when json_schema and json_object are refused, and logs the tier", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const fmt = (body.response_format as { type?: string } | undefined)?.type;
      if (fmt === "json_schema") {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_request_error",
              message: "This model is currently experiencing high demand",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (fmt === "json_object") {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_request_error",
              message:
                "response_format json_object is not supported by this model",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      // plain — chat-identical shape, no response_format
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: 'Here is the result:\n```json\n{"answer": 123}\n```',
              },
            },
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

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await provider.structured({
      schemaName: "answer",
      jsonSchema: { type: "object" },
      messages: [{ role: "user", content: "give json" }],
      temperature: 0.8,
      maxTokens: 1200,
      validate(value) {
        return value as { answer: number };
      },
    });

    expect(result.data).toEqual({ answer: 123 });
    expect(bodies).toHaveLength(3);

    // Tier 1: json_schema — has response_format json_schema + strict schema
    expect((bodies[0]!.response_format as { type: string }).type).toBe(
      "json_schema",
    );
    // Tier 2: json_object — has response_format json_object
    expect((bodies[1]!.response_format as { type: string }).type).toBe(
      "json_object",
    );
    // Tier 3: plain — no response_format, chat-identical shape
    expect(bodies[2]!.response_format).toBeUndefined();
    expect(bodies[2]!.model).toBe("model");
    expect(bodies[2]!.stream).toBe(false);
    expect(bodies[2]!.temperature).toBe(0.8);
    expect(bodies[2]!.max_tokens).toBe(1200);

    // Diff vs chat(): chat() body is {model, messages, temperature, max_tokens, stream}
    // json_schema body adds response_format.json_schema; json_object adds response_format json_object; plain matches chat
    const chatBody = {
      model: "model",
      messages: [{ role: "user", content: "give json" }],
      temperature: 0.8,
      max_tokens: 1200,
      stream: false,
    };
    expect(bodies[2]).toEqual(chatBody);

    // Logging names the tier
    const logs = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(
      logs.some(
        (l) => l.includes("json_schema") && l.includes("ModelProviderError"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) => l.includes("json_object") && l.includes("ModelProviderError"),
      ),
    ).toBe(true);

    consoleSpy.mockRestore();
  });
});
