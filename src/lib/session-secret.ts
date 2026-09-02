/**
 * SESSION_SECRET strength policy.
 *
 * The secret keys the AES-256-GCM envelope that protects OAuth sessions, the
 * OAuth state cookie and the encrypted Valmont Pay credentials. A short or
 * placeholder value makes every one of those forgeable offline, so the same
 * rule is enforced everywhere the secret is read: the encryption primitive
 * refuses to derive a key from it, and the configuration checks report it as
 * missing so health, the dashboard and the OAuth entry point all fail closed
 * instead of silently running on a weak key.
 *
 * Kept dependency-free so it can be imported from both `security.ts` and
 * `config.ts` without a cycle.
 */

/** Minimum secret length in bytes — 32 random bytes, as `.env.example` says. */
export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * Values that have shipped in example files, documentation or scaffolding and
 * therefore must never be accepted as a real secret regardless of length.
 * Compared case-insensitively after trimming.
 */
const PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-long-random-value",
  "replace-with-a-long-random-value-of-at-least-32-bytes",
  "replace-me",
  "changeme",
  "change-me",
  "change-this-before-production",
  "your-session-secret",
  "your-session-secret-here",
  "session-secret",
  "secret",
  "development",
  "dev-secret",
  "test-secret",
]);

const PLACEHOLDER_PATTERNS = [
  /^replace[-_ ]/i,
  /^change[-_ ]?(me|this)/i,
  /^your[-_ ]/i,
  /^(x+|0+|a+|1+|-+|\*+)$/i,
];

export type SessionSecretProblem = "missing" | "too_short" | "placeholder";

/**
 * Returns `null` when the secret is acceptable, otherwise the reason it is
 * not. Never includes the secret itself in the result so callers can log it.
 */
export function sessionSecretProblem(
  secret: string | undefined,
): SessionSecretProblem | null {
  if (secret === undefined || secret === null) return "missing";
  const value = String(secret).trim();
  if (value.length === 0) return "missing";
  if (value.length < SESSION_SECRET_MIN_LENGTH) return "too_short";
  const lowered = value.toLowerCase();
  if (PLACEHOLDER_SECRETS.has(lowered)) return "placeholder";
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
    return "placeholder";
  }
  return null;
}

export function isStrongSessionSecret(secret: string | undefined): boolean {
  return sessionSecretProblem(secret) === null;
}

/** Operator-facing explanation for a rejected secret; never echoes the value. */
export function describeSessionSecretProblem(
  problem: SessionSecretProblem,
): string {
  switch (problem) {
    case "missing":
      return "SESSION_SECRET is required";
    case "too_short":
      return `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters of random data`;
    case "placeholder":
      return "SESSION_SECRET is a placeholder value and must be replaced with random data";
  }
}
