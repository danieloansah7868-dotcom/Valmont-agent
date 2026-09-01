import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { ApiError, RateLimitError } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";

// Re-export typed errors so existing imports from "@/lib/api" continue to work.
export { ApiError } from "@/lib/api-errors";
export {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
  EmailDeliveryError,
  ConfigurationError,
  CustomerEmailDeliveryError,
  CustomerEmailConfigurationError,
  CustomerAccountExistsError,
  InvalidCustomerCredentialsError,
  InvalidOrderClaimError,
  InvalidPasswordResetError,
  CustomerNotConnectedError,
  NotConnectedError,
  ChatNotFoundError,
  TaskNotFoundError,
  MemoryNotFoundError,
  RepositoryNotFoundError,
  GitHubApiError,
} from "@/lib/api-errors";

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

const GENERIC_BAD_REQUEST = "Invalid request";

export function safeApiError(error: unknown) {
  // Strict: only explicit ApiError instances are trusted for status/message.
  if (error instanceof ApiError) {
    const message = error.message;
    // Even deliberate errors get screened for accidental internal leakage.
    if (leaksInternals(message)) {
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 500 });
    }
    return NextResponse.json({ error: message }, { status: error.status });
  }

  // Zod validation failures are generic 400, never echoing field details that
  // might contain business data.
  if (error instanceof ZodError) {
    return NextResponse.json({ error: GENERIC_BAD_REQUEST }, { status: 400 });
  }

  const message =
    error instanceof Error ? error.message : "Unexpected request failure";

  // Bounded JSON helper throws "Request body is not valid JSON" on SyntaxError.
  if (
    error instanceof SyntaxError ||
    (typeof message === "string" &&
      message.toLowerCase().includes("not valid json"))
  ) {
    return NextResponse.json({ error: GENERIC_BAD_REQUEST }, { status: 400 });
  }

  // Unrecognised failures that expose internals become an opaque 500.
  if (leaksInternals(message)) {
    return NextResponse.json({ error: GENERIC_FAILURE }, { status: 500 });
  }

  // Everything else — arbitrary Errors, plain objects with status, DB errors,
  // network errors, stack traces — is opaque 500. This prevents
  // status-property injection and message-text heuristics.
  return NextResponse.json({ error: GENERIC_FAILURE }, { status: 500 });
}
