import type { RuntimeEnv } from "@/lib/config";
import { FailoverModelProvider } from "@/lib/models/failover";
import { OpenAICompatibleProvider } from "@/lib/models/openai-compatible";
import type { ModelProvider } from "@/lib/models/types";

export const MODEL_NOT_CONFIGURED_MESSAGE =
  "MODEL_API_KEY is not configured. Set a server-side model provider before running a task.";

/** Blank values in an env file arrive as empty strings; treat them as unset. */
function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The optional backup provider ("spare brain").
 *
 * Configured only by `MODEL_BACKUP_API_KEY`. The endpoint and model name
 * default to the primary's — the common case is a second key on the same
 * provider — and are overridden by `MODEL_BACKUP_BASE_URL` /
 * `MODEL_BACKUP_NAME` for a genuinely different provider such as Groq or
 * OpenRouter.
 */
export function createBackupModelProvider(
  env: RuntimeEnv = process.env,
): ModelProvider | null {
  const apiKey = configured(env.MODEL_BACKUP_API_KEY);
  if (!apiKey) return null;
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl:
      configured(env.MODEL_BACKUP_BASE_URL) ??
      configured(env.MODEL_BASE_URL) ??
      "https://api.openai.com/v1",
    model:
      configured(env.MODEL_BACKUP_NAME) ??
      configured(env.MODEL_NAME) ??
      "gpt-4.1-mini",
    providerId: "openai-compatible-backup",
  });
}

/**
 * Valmont is live-only: without `MODEL_API_KEY` this throws rather than
 * substituting deterministic sample output.
 *
 * With no `MODEL_BACKUP_API_KEY` this returns the plain primary provider —
 * today's behaviour, unchanged. With one it returns a failover wrapper that
 * replays a transiently failed request (429, 5xx, network error, abort) on the
 * backup; configuration errors like 401 still fail loudly on the primary.
 */
export function createModelProvider(
  env: RuntimeEnv = process.env,
): ModelProvider {
  if (!env.MODEL_API_KEY) throw new Error(MODEL_NOT_CONFIGURED_MESSAGE);
  const primary = new OpenAICompatibleProvider({
    apiKey: env.MODEL_API_KEY,
    baseUrl: env.MODEL_BASE_URL ?? "https://api.openai.com/v1",
    model: env.MODEL_NAME ?? "gpt-4.1-mini",
  });
  const backup = createBackupModelProvider(env);
  return backup ? new FailoverModelProvider({ primary, backup }) : primary;
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
