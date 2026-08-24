import type { SessionUser } from "@/lib/auth";

/**
 * GitHub accounts allowed to see or change real-payment credentials.
 *
 * Valmont Agent is an agency workspace, so it begins locked to Danny's
 * account. An agency deployment can add more comma-separated GitHub logins in
 * PAYMENT_SETTINGS_ADMIN_LOGINS without exposing any payment secret.
 */
const DEFAULT_PAYMENT_ADMIN_LOGIN = "danieloansah7868-dotcom";

function configuredLogins(): Set<string> {
  const raw = process.env.PAYMENT_SETTINGS_ADMIN_LOGINS?.trim();
  const values = raw ? raw.split(",") : [DEFAULT_PAYMENT_ADMIN_LOGIN];
  return new Set(
    values.map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
}

export function canManagePaymentSettings(user: SessionUser): boolean {
  return configuredLogins().has(user.login.trim().toLowerCase());
}

export function assertCanManagePaymentSettings(user: SessionUser): void {
  if (!canManagePaymentSettings(user)) {
    throw new Error(
      "Only an approved Valmont agency payment manager can change these settings.",
    );
  }
}
