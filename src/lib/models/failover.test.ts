import { describe, expect, it, vi } from "vitest";
import { createModelProvider } from "@/lib/models";
import { FailoverModelProvider } from "@/lib/models/failover";
import {
  ModelProviderError,
  OpenAICompatibleProvider,
} from "@/lib/models/openai-compatible";
import type { ChatRequest } from "@/lib/models/types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatAnswer(content: string, model = "test-model"): Response {
  return jsonResponse({
    model,
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: {},
  });
}

function providerError(
  code: string,
  message: string,
  status: number,
): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function provider(
  id: string,
  fetcher: typeof fetch,
  model = `${id}-model`,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiKey: `${id}-key`,
    baseUrl: `https://${id}.example/v1`,
    model,
    providerId: id,
    fetcher,
  });
}

const MESSAGES: ChatRequest = {
  messages: [{ role: "user", content: "suggest a brand" }],
};

function consoleLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

async function collect(iterable: AsyncIterable<{ delta: string }>) {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk.delta);
  return chunks;
}

describe("model provider failover", () => {
  it("retries chat on the backup after a primary 429 and logs a redacted notice", async () => {
    const leakedKey = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    const primaryFetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return providerError(
        "rate_limit_exceeded",
        `Rate limit reached for gpt-4.1-mini: high demand (${leakedKey})`,
        429,
      );
    });
    const backupFetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      return chatAnswer("from the backup");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const failover = new FailoverModelProvider({
        primary: provider("primary", primaryFetch),
        backup: provider("backup", backupFetch),
      });

      const response = await failover.chat(MESSAGES);

      expect(response.content).toBe("from the backup");
      expect(primaryFetch).toHaveBeenCalledOnce();
      expect(backupFetch).toHaveBeenCalledOnce();
      // The backup receives the identical request, not a rewritten one — the
      // only difference is the model name each provider is configured with.
      const withoutModel = (body: unknown) => {
        const copy = { ...(body as Record<string, unknown>) };
        delete copy.model;
        return copy;
      };
      const primaryBody = JSON.parse(
        String(primaryFetch.mock.calls[0]![1]!.body),
      );
      const backupBody = JSON.parse(
        String(backupFetch.mock.calls[0]![1]!.body),
      );
      expect(withoutModel(backupBody)).toEqual(withoutModel(primaryBody));
      expect(backupBody.model).toBe("backup-model");

      const notice = consoleLines(consoleSpy).find((line) =>
        line.includes("[models] primary failed"),
      );
      expect(notice).toBeDefined();
      expect(notice).toContain("using backup");
      expect(notice).toContain("429");
      expect(notice).not.toContain(leakedKey);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it.each([
    [
      "timeout",
      () =>
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
    ],
    [
      "abort",
      () => new DOMException("The operation was aborted.", "AbortError"),
    ],
    ["network error", () => new TypeError("fetch failed")],
  ])(
    "retries chat on the backup after a primary %s",
    async (_label, makeError) => {
      const primaryFetch = vi.fn(
        async (input: FetchInput, init?: FetchInit) => {
          void input;
          void init;
          throw makeError();
        },
      );
      const backupFetch = vi.fn(async () => chatAnswer("from the backup"));
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        const failover = new FailoverModelProvider({
          primary: provider("primary", primaryFetch),
          backup: provider("backup", backupFetch),
        });

        await expect(failover.chat(MESSAGES)).resolves.toMatchObject({
          content: "from the backup",
        });
        expect(backupFetch).toHaveBeenCalledOnce();
        expect(
          consoleLines(consoleSpy).some((line) =>
            line.includes("[models] primary failed"),
          ),
        ).toBe(true);
      } finally {
        consoleSpy.mockRestore();
      }
    },
  );

  it("retries structured on the backup after a primary timeout", async () => {
    const primaryFetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      void input;
      void init;
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    });
    const backupFetch = vi.fn(async () =>
      jsonResponse({
        choices: [
          { finish_reason: "stop", message: { content: '{"answer":42}' } },
        ],
        usage: {},
      }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const failover = new FailoverModelProvider({
        primary: provider("primary", primaryFetch),
        backup: provider("backup", backupFetch),
      });

      const result = await failover.structured({
        schemaName: "answer",
        jsonSchema: { type: "object" },
        messages: MESSAGES.messages,
        validate: (value) => value as { answer: number },
      });

      expect(result.data).toEqual({ answer: 42 });
      expect(primaryFetch).toHaveBeenCalledOnce();
      expect(backupFetch).toHaveBeenCalledOnce();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it.each([400, 401, 403])(
    "fails loudly on a primary %i without touching the backup",
    async (status) => {
      const primaryFetch = vi.fn(async () =>
        providerError("invalid_request_error", "wrong key or schema", status),
      );
      const backupFetch = vi.fn(async () => chatAnswer("from the backup"));
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        const failover = new FailoverModelProvider({
          primary: provider("primary", primaryFetch),
          backup: provider("backup", backupFetch),
        });

        await expect(failover.chat(MESSAGES)).rejects.toMatchObject({
          name: "ModelProviderError",
          status,
        });
        // Exactly one call each: one on the primary, none on the backup.
        expect(primaryFetch).toHaveBeenCalledOnce();
        expect(backupFetch).not.toHaveBeenCalled();
        expect(
          consoleLines(consoleSpy).some((line) =>
            line.includes("[models] primary failed"),
          ),
        ).toBe(false);
      } finally {
        consoleSpy.mockRestore();
      }
    },
  );

  it("exhausts the primary's tier ladder before failing the whole request over", async () => {
    const primaryBodies: Array<Record<string, unknown>> = [];
    const primaryFetch = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      primaryBodies.push(body);
      const format = (body.response_format as { type?: string } | undefined)
        ?.type;
      if (format === "json_schema") {
        return providerError(
          "invalid_request_error",
          "response_format json_schema is not supported",
          400,
        );
      }
      if (format === "json_object") {
        return providerError(
          "invalid_request_error",
          "response_format json_object is not supported",
          400,
        );
      }
      return providerError("rate_limit_exceeded", "high demand", 429);
    });
    const backupBodies: Array<Record<string, unknown>> = [];
    const backupFetch = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      backupBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return jsonResponse({
        choices: [
          { finish_reason: "stop", message: { content: '{"answer":7}' } },
        ],
        usage: {},
      });
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const failover = new FailoverModelProvider({
        primary: provider("primary", primaryFetch),
        backup: provider("backup", backupFetch),
      });

      const result = await failover.structured({
        schemaName: "answer",
        jsonSchema: { type: "object" },
        messages: MESSAGES.messages,
        validate: (value) => value as { answer: number },
      });

      expect(result.data).toEqual({ answer: 7 });
      // json_schema, json_object, plain — all three tiers on the primary …
      expect(primaryBodies).toHaveLength(3);
      expect(primaryBodies[2]!.response_format).toBeUndefined();
      // … and then the full request once on the backup, starting at its best tier.
      expect(backupBodies).toHaveLength(1);
      expect((backupBodies[0]!.response_format as { type: string }).type).toBe(
        "json_schema",
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[models] primary failed"),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("keeps the failing class when both providers are down", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Both rate-limited: the backup's ModelProviderError reaches the caller so
      // brand-kit still answers its friendly 502.
      const bothBusy = new FailoverModelProvider({
        primary: provider(
          "primary",
          vi.fn(async () => providerError("rate_limit_exceeded", "busy", 429)),
        ),
        backup: provider(
          "backup",
          vi.fn(async () => providerError("rate_limit_exceeded", "busy", 429)),
        ),
      });
      await expect(bothBusy.chat(MESSAGES)).rejects.toBeInstanceOf(
        ModelProviderError,
      );

      // Both timing out: the TimeoutError reaches the caller so brand-kit
      // still answers its friendly 504.
      const timeout = () =>
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        );
      const bothSlow = new FailoverModelProvider({
        primary: provider(
          "primary",
          vi.fn(async () => {
            throw timeout();
          }),
        ),
        backup: provider(
          "backup",
          vi.fn(async () => {
            throw timeout();
          }),
        ),
      });
      await expect(bothSlow.chat(MESSAGES)).rejects.toMatchObject({
        name: "TimeoutError",
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("fails over a stream that dies before the first chunk, never mid-answer", async () => {
    const encoder = new TextEncoder();
    const backupFetch = vi.fn(
      async () =>
        new Response(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"backup"}}]}\n\ndata: [DONE]\n\n',
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const deadPrimary = new FailoverModelProvider({
        primary: provider(
          "primary",
          vi.fn(async () => providerError("rate_limit_exceeded", "busy", 429)),
        ),
        backup: provider("backup", backupFetch),
      });
      await expect(collect(deadPrimary.stream(MESSAGES))).resolves.toEqual([
        "backup",
        "",
      ]);
      expect(backupFetch).toHaveBeenCalledOnce();

      // A stream that already delivered a chunk must not restart: the caller
      // would see duplicated text.
      let sent = false;
      const dyingFetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"half"}}]}\n\n',
                ),
              );
              return;
            }
            controller.error(new TypeError("network dropped"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      const backupAfterChunk = vi.fn(
        async () =>
          new Response(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"backup"}}]}\n\ndata: [DONE]\n\n',
            ),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      );
      const midStream = new FailoverModelProvider({
        primary: provider("primary", dyingFetch),
        backup: provider("backup", backupAfterChunk),
      });
      await expect(collect(midStream.stream(MESSAGES))).rejects.toThrow(
        "network dropped",
      );
      expect(backupAfterChunk).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("keeps today's behaviour — a plain primary — when no backup is configured", async () => {
    const fetchSpy = vi.fn(async () =>
      providerError("rate_limit_exceeded", "high demand", 429),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    try {
      const plain = createModelProvider({ MODEL_API_KEY: "primary-key" });
      expect(plain).toBeInstanceOf(OpenAICompatibleProvider);
      expect(plain).not.toBeInstanceOf(FailoverModelProvider);

      await expect(plain.chat(MESSAGES)).rejects.toMatchObject({ status: 429 });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(
        consoleLines(consoleSpy).some((line) =>
          line.includes("[models] primary failed"),
        ),
      ).toBe(false);

      // A blank key is the documented way to leave the backup off.
      const blank = createModelProvider({
        MODEL_API_KEY: "primary-key",
        MODEL_BACKUP_API_KEY: "   ",
      });
      expect(blank).not.toBeInstanceOf(FailoverModelProvider);
    } finally {
      vi.unstubAllGlobals();
      consoleSpy.mockRestore();
    }
  });

  it("wires the backup from the environment with primary defaults", async () => {
    const calls: Array<{
      url: string;
      model: unknown;
      authorization: unknown;
    }> = [];
    const fetchSpy = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({
        url: String(input),
        model: JSON.parse(String(init?.body)).model,
        authorization: (init?.headers as Record<string, string>).authorization,
      });
      return calls.length === 1
        ? providerError("rate_limit_exceeded", "high demand", 429)
        : chatAnswer("from the backup", "primary-model");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    try {
      const providerWithInheritedBackup = createModelProvider({
        MODEL_API_KEY: "primary-key",
        MODEL_BASE_URL: "https://primary.example/v1",
        MODEL_NAME: "primary-model",
        MODEL_BACKUP_API_KEY: "backup-key",
      });
      expect(providerWithInheritedBackup).toBeInstanceOf(FailoverModelProvider);
      expect(providerWithInheritedBackup.id).toBe("openai-compatible");
      expect(providerWithInheritedBackup.model).toBe("primary-model");

      await expect(
        providerWithInheritedBackup.chat(MESSAGES),
      ).resolves.toMatchObject({ content: "from the backup" });

      expect(calls).toHaveLength(2);
      // Blank MODEL_BACKUP_BASE_URL / MODEL_BACKUP_NAME reuse the primary's:
      // a second key on the same provider needs only that key.
      expect(calls[1]!.url).toBe("https://primary.example/v1/chat/completions");
      expect(calls[1]!.model).toBe("primary-model");
      expect(calls[1]!.authorization).toBe("Bearer backup-key");
    } finally {
      vi.unstubAllGlobals();
      consoleSpy.mockRestore();
    }
  });

  it("honours MODEL_BACKUP_BASE_URL and MODEL_BACKUP_NAME for a different provider", async () => {
    const calls: Array<{ url: string; model: unknown }> = [];
    const fetchSpy = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({
        url: String(input),
        model: JSON.parse(String(init?.body)).model,
      });
      return calls.length === 1
        ? providerError("rate_limit_exceeded", "high demand", 429)
        : chatAnswer("from the backup", "backup-model");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    try {
      const providerWithOwnBackup = createModelProvider({
        MODEL_API_KEY: "primary-key",
        MODEL_BASE_URL: "https://primary.example/v1",
        MODEL_NAME: "primary-model",
        MODEL_BACKUP_API_KEY: "backup-key",
        MODEL_BACKUP_BASE_URL: "https://backup.example/v1",
        MODEL_BACKUP_NAME: "backup-model",
      });

      await expect(providerWithOwnBackup.chat(MESSAGES)).resolves.toMatchObject(
        { content: "from the backup" },
      );
      expect(calls[1]!.url).toBe("https://backup.example/v1/chat/completions");
      expect(calls[1]!.model).toBe("backup-model");
    } finally {
      vi.unstubAllGlobals();
      consoleSpy.mockRestore();
    }
  });
});
