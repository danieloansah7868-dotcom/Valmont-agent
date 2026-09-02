import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkMigrationReadiness: vi.fn(),
  tryCreateModelProvider: vi.fn(),
  resolvePaymentConfig: vi.fn(),
}));

vi.mock("@/lib/db/migration-readiness", () => ({
  checkMigrationReadiness: mocks.checkMigrationReadiness,
}));
vi.mock("@/lib/models", () => ({
  tryCreateModelProvider: mocks.tryCreateModelProvider,
}));
vi.mock("@/lib/studio/payment-settings", () => ({
  resolvePaymentConfig: mocks.resolvePaymentConfig,
}));

import { GET } from "./route";

const strongSecret = "9f2c1e0b7a6d4c3b8e5f1a2d3c4b5e6f7a8b9c0d1e2f3a4b";

function request(query = "") {
  return new NextRequest(`http://localhost/api/health${query}`);
}

describe("/api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // A production deployment that is missing its e-mail provider: the
    // readiness probe must say so, the liveness probe must not care.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("SESSION_SECRET", strongSecret);
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    vi.stubEnv("MODEL_API_KEY", "key");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "");
    mocks.tryCreateModelProvider.mockReturnValue({});
    mocks.resolvePaymentConfig.mockResolvedValue({
      mode: "test",
      liveActive: false,
      keysPresent: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers the liveness probe with 200 even while configuration is incomplete", async () => {
    const response = await GET(request("?probe=live"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "alive" });
    // Liveness never touches the database or provider configuration.
    expect(mocks.checkMigrationReadiness).not.toHaveBeenCalled();
  });

  it("reports the same deployment as degraded on the readiness probe", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.missingConfiguration).toEqual(
      expect.arrayContaining(["RESEND_API_KEY", "NOTIFY_EMAIL_FROM"]),
    );
    expect(body.dependencies.customerEmail).toBe("not_configured");
  });

  it("is ready once every requirement is met", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "Valmont <orders@example.com>");

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.dependencies.payments).toBe("test");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("treats a weak SESSION_SECRET as missing configuration", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "Valmont <orders@example.com>");
    vi.stubEnv("SESSION_SECRET", "replace-with-a-long-random-value");

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.missingConfiguration).toContain("SESSION_SECRET");
    expect(body.dependencies.github).toBe("not_configured");
  });

  it("flags Live payments that are selected but not fully configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "Valmont <orders@example.com>");
    mocks.resolvePaymentConfig.mockResolvedValue({
      mode: "live",
      liveActive: true,
      keysPresent: true,
      webhookSecret: undefined,
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.dependencies.payments).toBe("live_misconfigured");
  });

  it("degrades when migrations are incomplete but never leaks driver detail", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://example/valmont");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "Valmont <orders@example.com>");
    mocks.checkMigrationReadiness.mockResolvedValue({
      status: "incomplete",
      expected: 11,
      applied: 10,
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.dependencies.migrations).toEqual({
      status: "incomplete",
      expected: 11,
      applied: 10,
    });
    expect(JSON.stringify(body)).not.toContain("postgresql://");
  });
});
