export function csrfToken(): string {
  const item = document.cookie
    .split("; ")
    .find((value) => value.startsWith("valmont_csrf="));
  return decodeURIComponent(item?.split("=").slice(1).join("=") ?? "");
}

/**
 * A failed API call. The HTTP status is carried as data so callers branch on
 * `status === 409` instead of pattern-matching the message text — rewording a
 * server message must never change client behaviour.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiRequestOptions {
  /**
   * A bound on how long this one call may take, in milliseconds. When it
   * fires, the fetch rejects with an abort — a plain Error, NOT an ApiError,
   * so callers read it as a network-level failure that is safe to retry. Set
   * it just above any server-side abort for the same call, so on a live
   * connection the server's friendly error copy wins over a raw browser
   * abort.
   */
  timeoutMs?: number;
}

async function apiRequest<T>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<T> {
  const controller =
    options.timeoutMs === undefined ? undefined : new AbortController();
  const timer =
    controller === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-valmont-csrf": csrfToken(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });
    if (response.status === 204) return undefined as T;

    // A non-JSON error body (proxy timeout, HTML error page) must still
    // surface the status rather than throwing a parse error over the top of
    // it.
    let data: (T & { error?: string }) | undefined;
    let parsed = true;
    try {
      data = (await response.json()) as T & { error?: string };
    } catch {
      data = undefined;
      parsed = false;
    }

    if (!response.ok) {
      throw new ApiError(response.status, data?.error ?? "Request failed");
    }

    // A 2xx whose body is not JSON is a broken response, not a success.
    // Returning `undefined` here would let callers update the screen as
    // though the write had happened, or fail later somewhere unrelated.
    // Fail now, at the source.
    if (!parsed) {
      throw new ApiError(
        response.status,
        "The server sent a response we could not read. Your change may not have been saved.",
      );
    }
    return data as T;
  } finally {
    // The call settled one way or the other — never leave a pending abort.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function apiMutation<T>(
  url: string,
  body: unknown,
  options?: ApiRequestOptions,
): Promise<T> {
  return apiRequest<T>(url, "POST", body, options);
}

export function apiPatch<T>(url: string, body: unknown): Promise<T> {
  return apiRequest<T>(url, "PATCH", body);
}

/**
 * A whole-resource replace. Used by the Studio → TechChief connection card
 * (Stage 5), where saving a key replaces the connection rather than patching
 * one field of it.
 */
export function apiPut<T>(url: string, body: unknown): Promise<T> {
  return apiRequest<T>(url, "PUT", body);
}

export function apiDelete(url: string): Promise<void> {
  return apiRequest<void>(url, "DELETE");
}
