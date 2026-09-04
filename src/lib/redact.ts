/**
 * Secret and payment-detail redaction.
 *
 * Deliberately free of any Node-only import so it can be used by schema code
 * that runs in the browser as well as on the server. `security.ts` re-exports
 * everything here, so existing server imports keep working unchanged.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]"],
  /**
   * A TechChief developer API key (Stage 5). Each shop owner pastes their own
   * key into Studio; it is stored encrypted and must never appear in a log
   * line, an error message, a generated file or a backup. The 9-character
   * `key_prefix` we deliberately show owners ("TCHX-AB12•••") is too short to
   * match, so masking a real key never hides the prefix.
   */
  [/\b(TCHX-[A-Za-z0-9]{16,})\b/g, "[REDACTED_TECHCHIEF_KEY]"],
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

/**
 * Luhn check. Used to tell a real card number from any other long digit run,
 * so order numbers, invoice references and phone numbers are left alone.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Removes payment details a person might paste into a free-text field.
 *
 * This is a safety net, not a guarantee. It catches the common shapes — card
 * numbers that pass a Luhn check, and PINs/CVVs written next to their label —
 * and it runs in addition to `redactSecrets`. It cannot catch every way a
 * number might be written, which is why the interface also tells people not to
 * enter payment details and why `docs/SECURITY.md` states the limit plainly.
 */
export function redactPaymentData(value: string): string {
  return (
    value
      // 13–19 digits, optionally split by spaces or dashes, that satisfy Luhn.
      .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
        const digits = match.replace(/[^\d]/g, "");
        if (digits.length < 13 || digits.length > 19) return match;
        return passesLuhn(digits) ? "[REDACTED_CARD_NUMBER]" : match;
      })
      // A PIN, CVV or CVC written next to its label.
      .replace(
        /\b(pin|cvv|cvc|security\s+code)\b(\s*(?:is|=|:)?\s*)(\d{3,6})\b/gi,
        (_match, label: string, join: string) =>
          `${label}${join}[REDACTED_PIN]`,
      )
  );
}
