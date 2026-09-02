import { describe, expect, it } from "vitest";
import {
  customerEmailConfigured,
  databaseConfigured,
  githubCredentialsConfigured,
  missingCustomerEmailRequirements,
  missingLiveRequirements,
  modelCredentialsConfigured,
  runtimeReadiness,
} from "@/lib/config";

describe("runtime configuration", () => {
  it("reports nothing as configured for an empty environment", () => {
    expect(githubCredentialsConfigured({})).toBe(false);
    expect(modelCredentialsConfigured({})).toBe(false);
    expect(databaseConfigured({})).toBe(false);
    expect(runtimeReadiness({})).toEqual({
      github: false,
      model: false,
      database: false,
      liveReady: false,
    });
  });

  it("requires both customer email provider variables", () => {
    expect(customerEmailConfigured({})).toBe(false);
    expect(
      customerEmailConfigured({
        RESEND_API_KEY: "resend-key",
        NOTIFY_EMAIL_FROM: "Valmont <noreply@example.com>",
      }),
    ).toBe(true);
  });

  it("requires the full GitHub OAuth triple before GitHub counts as configured", () => {
    expect(
      githubCredentialsConfigured({
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
      }),
    ).toBe(false);
    expect(
      githubCredentialsConfigured({
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        SESSION_SECRET: "c0nf1g-t3st-s3cr3t-9f2c1e0b7a6d4c3b",
      }),
    ).toBe(true);
  });

  it("reports readiness from GitHub, model, and database credentials", () => {
    expect(
      runtimeReadiness({
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        SESSION_SECRET: "c0nf1g-t3st-s3cr3t-9f2c1e0b7a6d4c3b",
        MODEL_API_KEY: "key",
        DATABASE_URL: "postgres://localhost/valmont",
      }),
    ).toEqual({
      github: true,
      model: true,
      database: true,
      liveReady: true,
    });
  });

  it("lists exactly the variables still required to run", () => {
    expect(missingLiveRequirements({})).toEqual([
      "SESSION_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "MODEL_API_KEY",
    ]);
    expect(
      missingLiveRequirements({
        SESSION_SECRET: "c0nf1g-t3st-s3cr3t-9f2c1e0b7a6d4c3b",
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        MODEL_API_KEY: "key",
      }),
    ).toEqual([]);
  });

  it("reports missing customer email delivery configuration in production", () => {
    const env = {
      NODE_ENV: "production",
      SESSION_SECRET: "c0nf1g-t3st-s3cr3t-9f2c1e0b7a6d4c3b",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      MODEL_API_KEY: "key",
    };
    expect(missingLiveRequirements(env)).toEqual([]);
    expect(missingCustomerEmailRequirements(env)).toEqual([
      "RESEND_API_KEY",
      "NOTIFY_EMAIL_FROM",
    ]);
  });

  it("does not require customer email delivery for local development", () => {
    expect(
      missingCustomerEmailRequirements({ NODE_ENV: "development" }),
    ).toEqual([]);
  });

  it("ignores a legacy ENABLE_DEMO_MODE variable entirely", () => {
    const env = {
      ENABLE_DEMO_MODE: "true",
      SESSION_SECRET: "c0nf1g-t3st-s3cr3t-9f2c1e0b7a6d4c3b",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    };
    expect(missingLiveRequirements(env)).toEqual(["MODEL_API_KEY"]);
    expect(runtimeReadiness(env).liveReady).toBe(false);
  });
});
