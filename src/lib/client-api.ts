export function csrfToken(): string {
  const item = document.cookie
    .split("; ")
    .find((value) => value.startsWith("valmont_csrf="));
  return decodeURIComponent(item?.split("=").slice(1).join("=") ?? "");
}

export async function apiMutation<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-valmont-csrf": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
