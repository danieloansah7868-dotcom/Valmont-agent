import type {
  ChatRequest,
  ModelError,
  ModelProvider,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
  StreamChunk,
  StructuredRequest,
} from "@/lib/models/types";

interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerId?: string;
  fetcher?: typeof fetch;
}

/** Gemini and some OpenAI-compatible hosts return parts instead of a string. */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => extractMessageText(part)).join("");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    text?: string | null;
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: string; message?: string };
}

interface ProviderErrorDetails {
  code?: string;
  message?: string;
}

function jsonTypeOf(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return typeof value;
  }
  return undefined;
}

/**
 * OpenAI-compatible providers implement different JSON Schema subsets.
 * Gemini rejects `const`, but accepts an enum containing one value. Normalize
 * recursively while callers continue to enforce the original runtime contract.
 */
function compatibleJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? compatibleJsonSchema(item as Record<string, unknown>)
              : item,
          )
        : value && typeof value === "object"
          ? compatibleJsonSchema(value as Record<string, unknown>)
          : value,
    ]),
  );

  if (Object.prototype.hasOwnProperty.call(normalized, "const")) {
    const literal = normalized.const;
    delete normalized.const;
    if (!Object.prototype.hasOwnProperty.call(normalized, "enum")) {
      normalized.enum = [literal];
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "type")) {
      const type = jsonTypeOf(literal);
      if (type) normalized.type = type;
    }
  }

  return normalized;
}

function extractProviderError(payload: unknown): ProviderErrorDetails {
  const candidates = Array.isArray(payload) ? payload : [payload];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const error = (candidate as { error?: unknown }).error;
    if (!error || typeof error !== "object") continue;

    const { code, message } = error as {
      code?: unknown;
      message?: unknown;
    };
    return {
      code:
        typeof code === "string" || typeof code === "number"
          ? String(code)
          : undefined,
      message: typeof message === "string" ? message : undefined,
    };
  }

  return {};
}

export class ModelProviderError extends Error implements ModelError {
  provider: string;
  code: string;
  retryable: boolean;
  status?: number;

  constructor(error: ModelError) {
    super(error.message);
    this.name = "ModelProviderError";
    this.provider = error.provider;
    this.code = error.code;
    this.retryable = error.retryable;
    this.status = error.status;
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly supportsStreaming = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) throw new Error("A model API key is required");
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model;
    this.id = config.providerId ?? "openai-compatible";
    this.fetcher = config.fetcher ?? fetch;
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    const body = this.requestBody(request, false);
    const data = await this.post(body, request.signal);
    return this.normalize(data);
  }

  async structured<T>(
    request: StructuredRequest<T>,
  ): Promise<ModelResponse & { data: T }> {
    const body = {
      ...this.requestBody(request, false),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: compatibleJsonSchema(request.jsonSchema),
        },
      },
    };
    const response = this.normalize(await this.post(body, request.signal));
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      throw new ModelProviderError({
        provider: this.id,
        code: "invalid_structured_output",
        message: "The model returned invalid JSON for structured output",
        retryable: true,
      });
    }
    return { ...response, data: request.validate(parsed) };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(request, true)),
      signal: request.signal,
    });
    if (!response.ok || !response.body) await this.throwResponseError(response);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          yield { delta: "", done: true };
          return;
        }
        const event = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: OpenAIResponse["usage"];
        };
        const usage = event.usage ? this.usage(event.usage) : undefined;
        yield {
          delta: event.choices?.[0]?.delta?.content ?? "",
          done: false,
          usage,
        };
      }
    }
    yield { delta: "", done: true };
  }

  private requestBody(
    request: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 4_096,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: compatibleJsonSchema(tool.inputSchema),
              },
            })),
          }
        : {}),
    };
  }

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    };
  }

  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenAIResponse> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) await this.throwResponseError(response);
    return (await response.json()) as OpenAIResponse;
  }

  private async throwResponseError(response: Response): Promise<never> {
    let message = `Model provider request failed (${response.status})`;
    let code = "provider_error";
    try {
      const providerError = extractProviderError(await response.json());
      message = providerError.message ?? message;
      code = providerError.code ?? code;
    } catch {
      // Provider did not return JSON; use the safe status-only message.
    }
    throw new ModelProviderError({
      provider: this.id,
      code,
      message,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  private normalize(data: OpenAIResponse): ModelResponse {
    const choice = data.choices?.[0];
    const calls: ModelToolCall[] = (choice?.message?.tool_calls ?? []).map(
      (call) => ({
        id: call.id,
        name: call.function.name,
        arguments: this.parseToolArguments(call.function.arguments),
      }),
    );
    return {
      content: extractMessageText(
        choice?.message?.content ?? choice?.text ?? "",
      ),
      toolCalls: calls,
      usage: this.usage(data.usage),
      model: data.model ?? this.model,
      provider: this.id,
      finishReason: choice?.finish_reason ?? "unknown",
    };
  }

  private usage(usage?: OpenAIResponse["usage"]): ModelUsage {
    return {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens:
        usage?.total_tokens ??
        (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    };
  }

  private parseToolArguments(value: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
