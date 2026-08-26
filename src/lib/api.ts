import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { NotConnectedError } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security";

/**
 * Returns a request bucket key only when the deployment explicitly trusts its
 * reverse proxy. Browsers can forge X-Forwarded-For and X-Real-IP when the
 * application is reached directly, so the safe default is one shared
 * untrusted-client bucket rather than an attacker-controlled identity.
 */
export function clientKey(request: NextRequest): string {
  if (process.env.TRUST_PROXY !== "true") return "untrusted-client";
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip")?.trim() ??
    "trusted-proxy-unknown-client"
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
 * Customer authentication needs a stable identity bucket as well as a
 * network bucket. The identifier is hashed before entering the in-process map
 * so email addresses, tokens, and account ids are not retained there in plain
 * text. The network bucket is deliberately wider to avoid penalising a shared
 * connection while the identity bucket prevents header rotation from
 * bypassing password/credential limits.
 */
export function assertCustomerRateLimit(
  request: NextRequest,
  operation: string,
  identifier: string,
  limit = 10,
): void {
  const identifierKey = createHash("sha256")
    .update(identifier.trim().toLowerCase())
    .digest("hex");
  if (!checkRateLimit(`${operation}:identifier:${identifierKey}`, limit)) {
    throw new RateLimitError();
  }

  const networkLimit = Math.max(limit * 5, 30);
  if (
    !checkRateLimit(`${operation}:network:${clientKey(request)}`, networkLimit)
  ) {
    throw new RateLimitError();
  }
}

/**
 * Rate-limit an authenticated Studio or backup operation by the canonical
 * owner id. Client-supplied `x-forwarded-for` / `x-real-ip` headers are
 * ignored here so rotating those values cannot mint a fresh bucket.
 */
export function assertOwnerRateLimit(
  operation: string,
  ownerId: string,
  limit = 30,
): void {
  if (!ownerId) throw new RateLimitError();
  if (!checkRateLimit(`${operation}:owner:${ownerId}`, limit)) {
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

  // Legacy fallback, inherited from before typed errors existed. Matching on
  // message text is the very pattern the Studio code was corrected away from,
  // and it is wrong in the same way: reword "Task not found" and the status
  // silently becomes 400. It survives here only because pre-existing chat and
  // task routes still throw bare `Error`s that rely on it, and re-typing those
  // is outside Website Studio's scope. Recorded in NEXT-STEPS.md.
  //
  // An earlier version of this comment claimed no Studio path reaches the
  // fallback. That was wrong, and an independent review caught it: the draft
  // routes call `siteBriefSchemaV1.parse`, and a Zod validation failure is a
  // bare `ZodError` with no `status`, so it lands here and is answered 400.
  // That is the correct status for malformed input, so the behaviour is right
  // even though the old justification was not. The hazard is unchanged —
  // anything reaching this branch gets its status from message text.
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
