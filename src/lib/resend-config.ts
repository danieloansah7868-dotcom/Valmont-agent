/**
 * Conservative Resend configuration validation.
 *
 * RESEND_API_KEY and NOTIFY_EMAIL_FROM must be valid together. Partial,
 * blank, malformed sender, or header-injection values must fail closed.
 */

export function hasHeaderInjection(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function isValidEmailAddress(email: string): boolean {
  if (!email) return false;
  if (hasHeaderInjection(email)) return false;
  const trimmed = email.trim();
  if (!trimmed) return false;
  if (trimmed.length > 254) return false;
  if (trimmed.length < 3) return false;
  if (/\s/.test(trimmed)) return false;
  if (/[<>"']/.test(trimmed)) return false;
  if (trimmed.includes("..")) return false;
  // Basic email shape: local@domain.tld
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(trimmed)) return false;
  return true;
}

export function isValidSender(from: string): boolean {
  if (!from) return false;
  if (hasHeaderInjection(from)) return false;
  const trimmed = from.trim();
  if (!trimmed) return false;
  if (trimmed.length > 320) return false;
  if (hasHeaderInjection(trimmed)) return false;

  // Display-name format: "Name <email>" or "<email>" or "Name <email>"
  // We allow an optional display name before <email>.
  const displayMatch = trimmed.match(/^(.*)<\s*([^<>]+)\s*>\s*$/);
  if (displayMatch) {
    const displayName = displayMatch[1].trim();
    const email = displayMatch[2].trim();
    if (displayName) {
      if (hasHeaderInjection(displayName)) return false;
      if (/[<>]/.test(displayName)) return false;
      if (displayName.length > 100) return false;
      // Display name should not contain CR/LF already checked, but also not contain
      // control chars or excessive quotes.
      if (/[\r\n]/.test(displayName)) return false;
    }
    return isValidEmailAddress(email);
  }

  // No angle brackets: must be plain email
  if (/[<>]/.test(trimmed)) return false;
  return isValidEmailAddress(trimmed);
}

export type ResendConfigState = "not_configured" | "configured" | "invalid";

export function getResendConfigState(
  env: Record<string, string | undefined> = process.env,
): ResendConfigState {
  const apiKeyRaw = env.RESEND_API_KEY;
  const fromRaw = env.NOTIFY_EMAIL_FROM;

  const apiKeyPresent = apiKeyRaw !== undefined;
  const fromPresent = fromRaw !== undefined;

  if (!apiKeyPresent && !fromPresent) return "not_configured";

  if (apiKeyPresent !== fromPresent) return "invalid";

  // Both present — check blank after trim
  const apiKey = (apiKeyRaw ?? "").trim();
  const from = (fromRaw ?? "").trim();

  if (!apiKey || !from) return "invalid";

  if (
    hasHeaderInjection(apiKeyRaw ?? "") ||
    hasHeaderInjection(fromRaw ?? "")
  ) {
    return "invalid";
  }

  if (hasHeaderInjection(apiKey) || hasHeaderInjection(from)) {
    return "invalid";
  }

  // API key basic sanity: no whitespace, no angle brackets/quotes, min length
  if (/\s/.test(apiKey)) return "invalid";
  if (apiKey.length < 8) return "invalid";
  if (/[<>"'\r\n]/.test(apiKey)) return "invalid";

  // Sender must be valid in both raw and trimmed forms to catch injection
  if (!isValidSender(fromRaw ?? "")) return "invalid";
  if (!isValidSender(from)) return "invalid";

  return "configured";
}

export function isResendConfigValid(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return getResendConfigState(env) === "configured";
}

export function getValidatedResendConfig(
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; from: string } | null {
  const state = getResendConfigState(env);
  if (state !== "configured") return null;
  return {
    apiKey: (env.RESEND_API_KEY ?? "").trim(),
    from: (env.NOTIFY_EMAIL_FROM ?? "").trim(),
  };
}
