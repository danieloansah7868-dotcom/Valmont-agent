export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  role: ModelRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface ModelError {
  provider: string;
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface ChatRequest {
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ModelTool[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string;
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
  model: string;
  provider: string;
  finishReason: string;
}

export interface StructuredRequest<T> extends ChatRequest {
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  validate: (value: unknown) => T;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: ModelUsage;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly supportsStreaming: boolean;
  readonly demo: boolean;
  chat(request: ChatRequest): Promise<ModelResponse>;
  structured<T>(
    request: StructuredRequest<T>,
  ): Promise<ModelResponse & { data: T }>;
  stream(request: ChatRequest): AsyncIterable<StreamChunk>;
}
