/**
 * Model provider failover ("spare brain").
 *
 * A free-tier or otherwise busy primary provider answers 429 "high demand" or
 * times out; the backup is a second, independently configured provider that
 * receives the *same* request. Nothing here is a retry loop: one attempt on
 * the primary, and at most one attempt on the backup.
 *
 * Failover is deliberately narrow. A 400/401/403 means the request or the key
 * is wrong — the backup would only bury a real misconfiguration, so those
 * errors are surfaced to the caller unchanged. Like the provider itself, this
 * class never fabricates output and never invents a response.
 */

import { ModelProviderError } from "@/lib/models/openai-compatible";
import type {
  ChatRequest,
  ModelProvider,
  ModelResponse,
  StreamChunk,
  StructuredRequest,
} from "@/lib/models/types";
import { redactSecrets } from "@/lib/redact";

export const FAILOVER_NOTICE_PREFIX = "[models] primary failed";

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

/**
 * True only for transient provider trouble a different provider can fix:
 *
 * - `ModelProviderError` with HTTP 429 or 5xx (the provider is busy or down),
 * - a network failure — `fetch` rejects with a TypeError when the connection
 *   never reaches the host (DNS, TLS, socket reset),
 * - an abort or timeout — a DOMException named AbortError (cancellation) or
 *   TimeoutError (AbortSignal.timeout).
 *
 * Everything else — a 400 schema rejection, a 401/403 key, a 404 model, an
 * invalid-JSON answer from the model — is rethrown untouched.
 */
export function isFailoverEligible(error: unknown): boolean {
  if (error instanceof ModelProviderError) {
    return (
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500)
    );
  }
  const name = errorName(error);
  return (
    error instanceof TypeError ||
    name === "TypeError" ||
    name === "AbortError" ||
    name === "TimeoutError"
  );
}

/** One plain line naming the failure, with any secret-looking text masked. */
export function describeModelFailure(error: unknown): string {
  if (error instanceof ModelProviderError) {
    const status =
      error.status === undefined ? undefined : `HTTP ${error.status}`;
    const label = [status, error.code].filter(Boolean).join(" ");
    return `${label}: ${redactSecrets(error.message)}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${redactSecrets(error.message)}`;
  }
  return redactSecrets(String(error));
}

export interface FailoverProviderConfig {
  primary: ModelProvider;
  backup: ModelProvider;
}

export class FailoverModelProvider implements ModelProvider {
  /** Reports the primary's identity; the backup is an implementation detail. */
  readonly id: string;
  readonly model: string;
  readonly supportsStreaming: boolean;
  private readonly primary: ModelProvider;
  private readonly backup: ModelProvider;

  constructor({ primary, backup }: FailoverProviderConfig) {
    this.primary = primary;
    this.backup = backup;
    this.id = primary.id;
    this.model = primary.model;
    this.supportsStreaming = primary.supportsStreaming;
  }

  async chat(request: ChatRequest): Promise<ModelResponse> {
    try {
      return await this.primary.chat(request);
    } catch (error) {
      if (!isFailoverEligible(error)) throw error;
      this.reportFailover(error);
    }
    return this.backup.chat(request);
  }

  /**
   * The primary gets the whole tier ladder first — a schema the model refuses
   * is a property of that provider, not of the backup. Only when every tier on
   * the primary has failed for a transient reason is the full request replayed
   * on the backup, where the ladder starts again from its best tier.
   */
  async structured<T>(
    request: StructuredRequest<T>,
  ): Promise<ModelResponse & { data: T }> {
    try {
      return await this.primary.structured(request);
    } catch (error) {
      if (!isFailoverEligible(error)) throw error;
      this.reportFailover(error);
    }
    return this.backup.structured(request);
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    let delivered = false;
    try {
      for await (const chunk of this.primary.stream(request)) {
        // Once the caller has seen a chunk the answer is partially delivered;
        // replaying it on the backup would duplicate text, so a later failure
        // propagates like it does today.
        delivered = true;
        yield chunk;
      }
      return;
    } catch (error) {
      if (delivered || !isFailoverEligible(error)) throw error;
      this.reportFailover(error);
    }
    yield* this.backup.stream(request);
  }

  private reportFailover(error: unknown): void {
    console.error(
      redactSecrets(
        `${FAILOVER_NOTICE_PREFIX} (${describeModelFailure(error)}), using backup`,
      ),
    );
  }
}
