import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as register } from "@/app/api/customer/auth/register/route";
import { GET as verify } from "@/app/api/customer/auth/verify/route";
import { POST as claim } from "@/app/api/customer/orders/claim/route";
import { resetRateLimitForTests } from "@/lib/security";

const mocks = vi.hoisted(() => ({
  accountStore: {
    createAccount: vi.fn(),
    getByEmail: vi.fn(),
    getById: vi.fn(),
    createToken: vi.fn(),
    consumeToken: vi.fn(),
    verifyEmail: vi.fn(),
  },
  ordersStore: {
    getByAccessCode: vi.fn(),
    claimForCustomer: vi.fn(),
  },
  requireCustomerSession: vi.fn(),
  sendCustomerEmail: vi.fn(),
}));

vi.mock("@/lib/customer-account-store", () => ({
  CUSTOMER_VERIFICATION_TTL_MS: 24 * 60 * 60 * 1000,
  getCustomerAccountStore: () => mocks.accountStore,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => mocks.ordersStore,
}));

vi.mock("@/lib/customer-auth", () => ({
  requireCustomerSession: mocks.requireCustomerSession,
}));

vi.mock("@/lib/customer-email", () => ({
  assertCustomerEmailDeliveryReady: vi.fn(),
  customerEmailHtml: vi.fn(() => "<p>email</p>"),
  sendCustomerEmail: mocks.sendCustomerEmail,
}));

const csrf = "customer-route-csrf-token-123456";

function mutation(path: string, body: unknown, forwardedFor?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie: `valmont_csrf=${csrf}`,
      "content-type": "application/json",
      "x-valmont-csrf": csrf,
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
    },
    body: JSON.stringify(body),
  });
}

function registrationBody(claimAccessCode: string) {
  return {
    name: "Ama Mensah",
    email: "ama@example.com",
    password: "a sufficiently long password",
    claimAccessCode,
  };
}

describe("customer account HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitForTests();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TRUST_PROXY", "false");
    mocks.accountStore.getByEmail.mockResolvedValue(null);
    mocks.accountStore.getById.mockResolvedValue({
      id: "account-1",
      email: "ama@example.com",
      name: "Ama Mensah",
    });
    mocks.accountStore.consumeToken.mockResolvedValue({
      accountId: "account-1",
      context: "guest-order-access-code-1234",
    });
    mocks.ordersStore.getByAccessCode.mockResolvedValue({
      accessCode: "guest-order-access-code-1234",
      customerEmail: "ama@example.com",
      customerAccountId: undefined,
    });
    mocks.ordersStore.claimForCustomer.mockResolvedValue({
      customerAccountId: "account-1",
    });
    mocks.requireCustomerSession.mockResolvedValue({
      account: { id: "account-1", email: "ama@example.com" },
    });
  });

  it("rejects registration without CSRF before looking up or creating anything", async () => {
    const request = new NextRequest(
      "http://localhost/api/customer/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registrationBody("guest-order-access-code-1234")),
      },
    );

    const response = await register(request);

    expect(response.status).toBe(403);
    expect(mocks.ordersStore.getByAccessCode).not.toHaveBeenCalled();
    expect(mocks.accountStore.createAccount).not.toHaveBeenCalled();
  });

  it("refuses to claim a guest order that has no checkout email", async () => {
    mocks.ordersStore.getByAccessCode.mockResolvedValueOnce({
      accessCode: "guest-order-access-code-1234",
      customerEmail: undefined,
      customerAccountId: undefined,
    });

    const response = await claim(
      mutation("/api/customer/orders/claim", {
        accessCode: "guest-order-access-code-1234",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("no email"),
    });
    expect(mocks.ordersStore.claimForCustomer).not.toHaveBeenCalled();
  });

  it("does not link an email-less order after verification", async () => {
    mocks.ordersStore.getByAccessCode.mockResolvedValueOnce({
      accessCode: "guest-order-access-code-1234",
      customerEmail: undefined,
      customerAccountId: undefined,
    });

    const response = await verify(
      new NextRequest(
        "http://localhost/api/customer/auth/verify?token=verification-token-1234567890",
      ),
    );

    expect(response.status).toBe(307);
    expect(
      new URL(response.headers.get("location")!).searchParams.get("verified"),
    ).toBe("success");
    expect(mocks.accountStore.verifyEmail).toHaveBeenCalledWith("account-1");
    expect(mocks.ordersStore.claimForCustomer).not.toHaveBeenCalled();
  });

  it("keeps the claim link owner-scoped after a successful email verification", async () => {
    const response = await verify(
      new NextRequest(
        "http://localhost/api/customer/auth/verify?token=verification-token-1234567890",
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.ordersStore.claimForCustomer).toHaveBeenCalledWith(
      "account-1",
      "guest-order-access-code-1234",
    );
  });
});
