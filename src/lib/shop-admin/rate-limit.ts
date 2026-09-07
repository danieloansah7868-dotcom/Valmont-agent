import { createHash } from "node:crypto";
import { RateLimitError } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";

const HOUR_MS = 60 * 60 * 1000;

/**
 * An hourly bucket keyed on a hashed identifier (an email, a website id).
 * The shared limiter defaults to a one-minute window, which is right for
 * sign-in attempts but far too generous for "send me a link" endpoints —
 * five reset emails an hour is plenty for a real person and a ceiling for
 * anyone trying to flood an inbox. The identifier is hashed before it enters
 * the in-process map so no email address is retained there in plain text.
 */
export function assertHourlyRateLimit(
  operation: string,
  identifier: string,
  limit: number,
): void {
  const key = createHash("sha256")
    .update(identifier.trim().toLowerCase())
    .digest("hex");
  if (!checkRateLimit(`${operation}:hourly:${key}`, limit, HOUR_MS)) {
    throw new RateLimitError();
  }
}
