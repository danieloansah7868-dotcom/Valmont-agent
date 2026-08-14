/**
 * Runtime configuration.
 *
 * Valmont is live-only. Every repository listing, plan, patch, validation,
 * diff, and pull request comes from the real GitHub account, the configured
 * model provider, and real workspace execution. There is no demo mode and no
 * sample-data fallback: when a credential is missing the application says so
 * instead of inventing output.
 */

export type RuntimeEnv = Record<string, string | undefined>;

export function githubCredentialsConfigured(
  env: RuntimeEnv = process.env,
): boolean {
  return Boolean(
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET,
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
  if (!env.SESSION_SECRET) missing.push("SESSION_SECRET");
  if (!env.GITHUB_CLIENT_ID) missing.push("GITHUB_CLIENT_ID");
  if (!env.GITHUB_CLIENT_SECRET) missing.push("GITHUB_CLIENT_SECRET");
  if (!env.MODEL_API_KEY) missing.push("MODEL_API_KEY");
  return missing;
}
