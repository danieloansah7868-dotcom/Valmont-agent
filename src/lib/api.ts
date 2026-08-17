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
    throw new RateLimitError();
  }
}

/**
 * Errors that carry their own HTTP status. Preferring an explicit status over
 * matching words in a message means a reworded message can never silently
 * change a 409 into a 400.
 */
export interface StatusCarryingError extends Error {
  status: number;
}

function hasStatus(error: unknown): error is StatusCarryingError {
  return (
    error instanceof Error &&
    typeof (error as Partial<StatusCarryingError>).status === "number" &&
    (error as StatusCarryingError).status >= 400 &&
    (error as StatusCarryingError).status <= 599
  );
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(
    message = "Rate limit exceeded. Please wait before trying again.",
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor(message = "Request body too large") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export function safeApiError(error: unknown) {
  if (hasStatus(error)) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }

  const message =
    error instanceof Error ? error.message : "Unexpected request failure";
  const status =
    error instanceof NotConnectedError
      ? 401
      : message === "Task not found" || message === "Chat not found"
        ? 404
        : message.includes("CSRF") || message.includes("Cross-origin")
          ? 403
          : message.includes("Rate limit")
            ? 429
            : 400;
  return NextResponse.json({ error: message }, { status });
}
