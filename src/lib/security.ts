import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { NextRequest } from "next/server";
import { ForbiddenError } from "@/lib/api-errors";
import {
  describeSessionSecretProblem,
  sessionSecretProblem,
} from "@/lib/session-secret";

export { redactSecrets, redactPaymentData } from "./redact";

/** High-confidence scan used before generated files can be committed. */
export function containsLikelySecret(value: string): boolean {
  return [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    // TechChief developer API key (Stage 5 bundle delivery).
    /\bTCHX-[A-Za-z0-9]{16,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/i,
  ].some((pattern) => pattern.test(value));
}

export class WeakSessionSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakSessionSecretError";
  }
}

/**
 * Derives the AES key. A missing, short or placeholder secret is refused here
 * — at the primitive — so no code path can encrypt a session, an OAuth state
 * or a payment credential under a guessable key, whatever the caller did or
 * did not check first.
 */
function sessionKey(secret = process.env.SESSION_SECRET): Buffer {
  const problem = sessionSecretProblem(secret);
  if (problem) {
    throw new WeakSessionSecretError(describeSessionSecretProblem(problem));
  }
  return createHash("sha256").update(secret!).digest();
}

/** AES-256-GCM envelope for short-lived OAuth session values. */
export function encryptSessionValue(value: string, secret?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptSessionValue(envelope: string, secret?: string): string {
  const [ivValue, tagValue, encryptedValue] = envelope.split(".");
  if (!ivValue || !tagValue || !encryptedValue)
    throw new Error("Invalid session envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    sessionKey(secret),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ForbiddenError("Cross-origin mutation rejected");
  }
  // Reverse proxies may rewrite request.nextUrl to an internal host. Trust only the concrete Host
  // values supplied by Next/the proxy, never an arbitrary allowlist from user input.
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const requestHost = request.headers.get("host")?.trim();
  const acceptedHosts = new Set(
    [forwardedHost, requestHost, request.nextUrl.host].filter(
      (value): value is string => Boolean(value),
    ),
  );
  if (!acceptedHosts.has(originUrl.host))
    throw new ForbiddenError("Cross-origin mutation rejected");
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost && originUrl.host === forwardedHost && forwardedProtocol) {
    if (originUrl.protocol !== `${forwardedProtocol}:`) {
      throw new ForbiddenError("Cross-origin mutation rejected");
    }
  }
}

export function assertCsrf(request: NextRequest): void {
  assertSameOrigin(request);
  const cookie = request.cookies.get("valmont_csrf")?.value;
  const header = request.headers.get("x-valmont-csrf");
  if (!cookie || !header || cookie !== header || cookie.length < 16) {
    throw new ForbiddenError("Invalid CSRF token");
  }
}

interface RateWindow {
  count: number;
  resetsAt: number;
}

const rateWindows = new Map<string, RateWindow>();

/** In-process development limiter; production deployments should use Redis or gateway limits. */
export function checkRateLimit(
  key: string,
  limit = 30,
  windowMs = 60_000,
): boolean {
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || current.resetsAt <= now) {
    rateWindows.set(key, { count: 1, resetsAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

/** Test helper only — clears in-process buckets between cases. */
export function resetRateLimitForTests(): void {
  rateWindows.clear();
}
