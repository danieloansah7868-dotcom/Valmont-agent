import { NextResponse, type NextRequest } from "next/server";
import { NotConnectedError } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security";

export function clientKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local"
  );
}

export function assertApiRateLimit(
  request: NextRequest,
  operation: string,
  limit = 30,
): void {
  if (!checkRateLimit(`${operation}:${clientKey(request)}`, limit)) {
    throw new Error("Rate limit exceeded. Please wait before trying again.");
  }
}

export function safeApiError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unexpected request failure";
  const status =
    error instanceof NotConnectedError
      ? 401
      : message === "Task not found"
        ? 404
        : message.includes("CSRF") || message.includes("Cross-origin")
          ? 403
          : message.includes("Rate limit")
            ? 429
            : 400;
  return NextResponse.json({ error: message }, { status });
}
