/**
 * Runtime configuration.
 *
 * Valmont is live-only. Every repository listing, plan, patch, validation,
 * diff, and pull request comes from the real GitHub account, the configured
 * model provider, and real workspace execution. There is no demo mode and no
 * sample-data fallback: when a credential is missing the application says so
 * instead of inventing output.
 */

import { getResendConfigState } from "@/lib/resend-config";
import { isStrongSessionSecret } from "@/lib/session-secret";

export type RuntimeEnv = Record<string, string | undefined>;

/**
 * True only for a usable SESSION_SECRET: present, at least 32 characters and
 * not one of the placeholder values that ship in example files. A weak secret
 * is reported exactly like a missing one so nothing — OAuth, health, the
 * dashboard — treats the deployment as configured while sessions are forgeable.
 */
export function sessionSecretConfigured(
  env: RuntimeEnv = process.env,
): boolean {
  return isStrongSessionSecret(env.SESSION_SECRET);
}

export function githubCredentialsConfigured(
  env: RuntimeEnv = process.env,
): boolean {
  return Boolean(
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    sessionSecretConfigured(env),
  );
}

export function modelCredentialsConfigured(
  env: RuntimeEnv = process.env,
): boolean {
  return Boolean(env.MODEL_API_KEY);
}

export function databaseConfigured(env: RuntimeEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL);
}

export function customerEmailConfigured(
  env: RuntimeEnv = process.env,
): boolean {
  return getResendConfigState(env) === "configured";
}

export interface RuntimeReadiness {
  github: boolean;
  model: boolean;
  database: boolean;
  /** True when the real end-to-end workflow can run. */
  liveReady: boolean;
}

export function runtimeReadiness(
  env: RuntimeEnv = process.env,
): RuntimeReadiness {
  const github = githubCredentialsConfigured(env);
  const model = modelCredentialsConfigured(env);
  const database = databaseConfigured(env);
  return { github, model, database, liveReady: github && model };
}

/** Human-readable list of what still has to be configured before Valmont can run. */
export function missingLiveRequirements(
  env: RuntimeEnv = process.env,
): string[] {
  const missing: string[] = [];
  if (!sessionSecretConfigured(env)) missing.push("SESSION_SECRET");
  if (!env.GITHUB_CLIENT_ID) missing.push("GITHUB_CLIENT_ID");
  if (!env.GITHUB_CLIENT_SECRET) missing.push("GITHUB_CLIENT_SECRET");
  if (!env.MODEL_API_KEY) missing.push("MODEL_API_KEY");
  return missing;
}

/** Customer-account email is required for the production account flows. */
export function missingCustomerEmailRequirements(
  env: RuntimeEnv = process.env,
): string[] {
  if (env.NODE_ENV !== "production") return [];
  const state = getResendConfigState(env);
  if (state !== "configured") {
    // In production, both variables must be valid together. Partial, blank,
    // malformed, or missing config is reported as missing so health is degraded.
    const missing: string[] = [];
    if (!env.RESEND_API_KEY || (env.RESEND_API_KEY ?? "").trim() === "") {
      missing.push("RESEND_API_KEY");
    }
    if (!env.NOTIFY_EMAIL_FROM || (env.NOTIFY_EMAIL_FROM ?? "").trim() === "") {
      missing.push("NOTIFY_EMAIL_FROM");
    }
    // If both are present but invalid (malformed/injection), still report both
    // as required to avoid leaking validation detail, but ensure health is degraded.
    if (missing.length === 0) {
      missing.push("RESEND_API_KEY");
      missing.push("NOTIFY_EMAIL_FROM");
    }
    return missing;
  }
  return [];
}
