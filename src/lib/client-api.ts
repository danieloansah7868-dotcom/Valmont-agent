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

async function apiRequest<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-valmont-csrf": csrfToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;

  // A non-JSON error body (proxy timeout, HTML error page) must still surface
  // the status rather than throwing a parse error over the top of it.
  let data: (T & { error?: string }) | undefined;
  try {
    data = (await response.json()) as T & { error?: string };
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? "Request failed");
  }
  return data as T;
}

export function apiMutation<T>(url: string, body: unknown): Promise<T> {
  return apiRequest<T>(url, "POST", body);
}

export function apiPatch<T>(url: string, body: unknown): Promise<T> {
  return apiRequest<T>(url, "PATCH", body);
}

export function apiDelete(url: string): Promise<void> {
  return apiRequest<void>(url, "DELETE");
}
