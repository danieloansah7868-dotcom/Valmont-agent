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

interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
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
  readonly demo = false;
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
          schema: request.jsonSchema,
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
      max_tokens: request.maxTokens ?? 2_000,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
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
      const payload = (await response.json()) as OpenAIResponse;
      message = payload.error?.message ?? message;
      code = payload.error?.code ?? code;
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
      content: choice?.message?.content ?? "",
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
