import { demoModeEnabled, type RuntimeEnv } from "@/lib/config";
import { DemoModelProvider } from "@/lib/models/demo";
import { OpenAICompatibleProvider } from "@/lib/models/openai-compatible";
import type { ModelProvider } from "@/lib/models/types";

export const MODEL_NOT_CONFIGURED_MESSAGE =
  "MODEL_API_KEY is not configured. Set a server-side model provider before running a task.";

/**
 * Live mode is the default: without `MODEL_API_KEY` this throws instead of
 * silently substituting deterministic sample output. The demo planner is only
 * returned when an operator sets `ENABLE_DEMO_MODE=true`.
 */
export function createModelProvider(
  env: RuntimeEnv = process.env,
): ModelProvider {
  if (!env.MODEL_API_KEY) {
    if (demoModeEnabled(env)) return new DemoModelProvider();
    throw new Error(MODEL_NOT_CONFIGURED_MESSAGE);
  }
  return new OpenAICompatibleProvider({
    apiKey: env.MODEL_API_KEY,
    baseUrl: env.MODEL_BASE_URL ?? "https://api.openai.com/v1",
    model: env.MODEL_NAME ?? "gpt-4.1-mini",
  });
}

/** Non-throwing variant for status surfaces such as settings and /api/health. */
export function tryCreateModelProvider(
  env: RuntimeEnv = process.env,
): ModelProvider | null {
  try {
    return createModelProvider(env);
  } catch {
    return null;
  }
}

export * from "@/lib/models/types";
