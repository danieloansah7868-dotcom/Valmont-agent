import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { NextRequest } from "next/server";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]"],
  [
    /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@"],
];

const NAMED_SECRET_PATTERN =
  /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi;
const DOCUMENTATION_SECRET_PLACEHOLDERS = new Set(["replace-me"]);

export function redactSecrets(value: string): string {
  const redacted = SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
  return redacted.replace(
    NAMED_SECRET_PATTERN,
    (match, prefix: string, candidate: string) =>
      DOCUMENTATION_SECRET_PLACEHOLDERS.has(candidate.toLowerCase())
        ? match
        : `${prefix}[REDACTED]`,
  );
}

/** High-confidence scan used before generated files can be committed. */
export function containsLikelySecret(value: string): boolean {
  return [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/i,
  ].some((pattern) => pattern.test(value));
}

function sessionKey(secret = process.env.SESSION_SECRET): Buffer {
  if (!secret) throw new Error("SESSION_SECRET is required");
  return createHash("sha256").update(secret).digest();
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
    throw new Error("Cross-origin mutation rejected");
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
    throw new Error("Cross-origin mutation rejected");
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost && originUrl.host === forwardedHost && forwardedProtocol) {
    if (originUrl.protocol !== `${forwardedProtocol}:`) {
      throw new Error("Cross-origin mutation rejected");
    }
  }
}

export function assertCsrf(request: NextRequest): void {
  assertSameOrigin(request);
  const cookie = request.cookies.get("valmont_csrf")?.value;
  const header = request.headers.get("x-valmont-csrf");
  if (!cookie || !header || cookie !== header || cookie.length < 16) {
    throw new Error("Invalid CSRF token");
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
