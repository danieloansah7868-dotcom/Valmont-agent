import type {
  ModelProvider,
  ModelResponse,
  StreamChunk,
  StructuredRequest,
} from "@/lib/models/types";

const NOTICE =
  "Demo mode: no model request was made. Configure MODEL_API_KEY to use a real server-side provider.";

export class DemoModelProvider implements ModelProvider {
  readonly id = "demo-provider";
  readonly model = "deterministic-demo";
  readonly supportsStreaming = true;
  readonly demo = true;

  async chat(): Promise<ModelResponse> {
    return this.response(NOTICE);
  }

  async structured<T>(
    request: StructuredRequest<T>,
  ): Promise<ModelResponse & { data: T }> {
    const fallback: unknown = {
      summary: NOTICE,
      steps: [],
      validationCommands: ["npm test"],
      risk: "low",
      generatedBy: "demo",
    };
    return {
      ...this.response(JSON.stringify(fallback)),
      data: request.validate(fallback),
    };
  }

  async *stream(): AsyncIterable<StreamChunk> {
    for (const word of NOTICE.split(" "))
      yield { delta: `${word} `, done: false };
    yield { delta: "", done: true, usage: this.response("").usage };
  }

  private response(content: string): ModelResponse {
    return {
      content,
      toolCalls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
      model: this.model,
      provider: this.id,
      finishReason: "demo",
    };
  }
}
