import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/customer/auth/login/route";
import { resetRateLimitForTests } from "@/lib/security";

const mocks = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/lib/customer-account-store", () => ({
  getCustomerAccountStore: () => mocks,
}));

const csrf = "login-route-csrf-token-123456";

function request(email: string, forwardedFor?: string) {
  return new NextRequest("http://localhost/api/customer/auth/login", {
    method: "POST",
    headers: {
      cookie: `valmont_csrf=${csrf}`,
      "content-type": "application/json",
      "x-valmont-csrf": csrf,
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    body: JSON.stringify({
      email,
      password: "a sufficiently long password",
    }),
  });
}

describe("customer login HTTP route", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TRUST_PROXY", "false");
    resetRateLimitForTests();
    vi.clearAllMocks();
    mocks.verifyPassword.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue({ token: "session-token" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires CSRF before touching the password store", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/customer/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "ama@example.com",
          password: "a sufficiently long password",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("uses the same invalid-credentials response for unknown and unverified emails", async () => {
    const unknown = await POST(request("unknown@example.com"));
    mocks.verifyPassword.mockResolvedValueOnce({
      id: "account-1",
      email: "unverified@example.com",
      emailVerifiedAt: undefined,
    });
    const unverified = await POST(request("unverified@example.com"));

    expect(unknown.status).toBe(401);
    expect(unverified.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual(await unverified.json());
  });

  it("cannot bypass the identifier limit by rotating forged proxy headers", async () => {
    let lastStatus = 0;
    for (let index = 0; index < 11; index += 1) {
      lastStatus = (
        await POST(request("target@example.com", `203.0.113.${index + 1}`))
      ).status;
    }

    expect(lastStatus).toBe(429);
    expect(mocks.verifyPassword).toHaveBeenCalledTimes(10);
  });
});
