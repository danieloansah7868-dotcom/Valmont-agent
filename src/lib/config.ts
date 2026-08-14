/**
 * Runtime mode configuration.
 *
 * Valmont runs in live mode by default: every repository listing, plan, patch,
 * validation, diff, and pull request comes from the real GitHub account, model
 * provider, and workspace. Fictional sample data is only ever produced when an
 * operator explicitly opts in with `ENABLE_DEMO_MODE=true`.
 */

export type RuntimeEnv = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Demo mode is opt-in. Anything other than an explicit truthy value is live mode. */
export function demoModeEnabled(env: RuntimeEnv = process.env): boolean {
  return flag(env.ENABLE_DEMO_MODE);
}

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
  demoMode: boolean;
  github: boolean;
  model: boolean;
  database: boolean;
  /** True when the real end-to-end workflow can run without demo fallbacks. */
  liveReady: boolean;
}

export function runtimeReadiness(
  env: RuntimeEnv = process.env,
): RuntimeReadiness {
  const github = githubCredentialsConfigured(env);
  const model = modelCredentialsConfigured(env);
  const database = databaseConfigured(env);
  return {
    demoMode: demoModeEnabled(env),
    github,
    model,
    database,
    liveReady: github && model,
  };
}

/** Human-readable list of what still has to be configured for live mode. */
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
