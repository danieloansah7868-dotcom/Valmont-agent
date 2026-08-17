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

/**
 * Text that must never reach a browser. A database driver puts the failing
 * statement, its bound parameter values and the host it dialled into
 * `error.message`; returning that verbatim hands an attacker the schema and
 * leaks whatever was in those parameters. Anything matching here is replaced
 * with a generic message and reported as a 500, because a driver failure is a
 * server fault, not a bad request.
 */
const INTERNAL_DETAIL = [
  /failed query/i,
  /\bselect\b[\s\S]*\bfrom\b/i,
  /\binsert into\b/i,
  /\bupdate\b[\s\S]*\bset\b/i,
  /\bdelete from\b/i,
  /\bparams:/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i,
  /postgres:\/\/|postgresql:\/\//i,
  /sqlite/i,
  /\bat [\w.]+ \(.*:\d+:\d+\)/,
];

function leaksInternals(message: string): boolean {
  return INTERNAL_DETAIL.some((pattern) => pattern.test(message));
}

const GENERIC_FAILURE =
  "Something went wrong handling that request. Please try again.";

export function safeApiError(error: unknown) {
  if (hasStatus(error)) {
    // A deliberate status still gets its message screened: a wrapped driver
    // error could otherwise carry statement text out with it.
    return NextResponse.json(
      {
        error: leaksInternals(error.message) ? GENERIC_FAILURE : error.message,
      },
      { status: leaksInternals(error.message) ? 500 : error.status },
    );
  }

  const message =
    error instanceof Error ? error.message : "Unexpected request failure";

  // Unrecognised failures that expose internals become an opaque 500.
  if (leaksInternals(message)) {
    return NextResponse.json({ error: GENERIC_FAILURE }, { status: 500 });
  }

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
