import { DemoModelProvider } from "@/lib/models/demo";
import { OpenAICompatibleProvider } from "@/lib/models/openai-compatible";
import type { ModelProvider } from "@/lib/models/types";

export function createModelProvider(
  env: Record<string, string | undefined> = process.env,
): ModelProvider {
  if (!env.MODEL_API_KEY) return new DemoModelProvider();
  return new OpenAICompatibleProvider({
    apiKey: env.MODEL_API_KEY,
    baseUrl: env.MODEL_BASE_URL ?? "https://api.openai.com/v1",
    model: env.MODEL_NAME ?? "gpt-4.1-mini",
  });
}

export * from "@/lib/models/types";
