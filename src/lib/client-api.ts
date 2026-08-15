export function csrfToken(): string {
  const item = document.cookie
    .split("; ")
    .find((value) => value.startsWith("valmont_csrf="));
  return decodeURIComponent(item?.split("=").slice(1).join("=") ?? "");
}

async function apiRequest<T>(
  url: string,
  method: "POST" | "DELETE",
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
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export function apiMutation<T>(url: string, body: unknown): Promise<T> {
  return apiRequest<T>(url, "POST", body);
}

export function apiDelete(url: string): Promise<void> {
  return apiRequest<void>(url, "DELETE");
}
