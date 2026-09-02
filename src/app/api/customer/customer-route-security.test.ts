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
  publicGetDraft: vi.fn(),
}));

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
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
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TRUST_PROXY", "false");
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.accountStore.getByEmail.mockResolvedValue(null);
    mocks.accountStore.createAccount.mockResolvedValue({
      id: "account-1",
      email: "ama@example.com",
      name: "Ama Mensah",
    });
    mocks.accountStore.createToken.mockResolvedValue(
      "verification-token-1234567890",
    );
    mocks.sendCustomerEmail.mockResolvedValue({ delivered: true });
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
      draftId: "11111111-2222-4333-8444-555555555555",
      customerEmail: "ama@example.com",
      customerAccountId: undefined,
    });
    // Fixture website has customer accounts switched ON.
    mocks.publicGetDraft.mockResolvedValue({
      id: "11111111-2222-4333-8444-555555555555",
      ownerId: "owner-1",
      brief: { features: { customerAccounts: true } },
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

  it("builds the verification link from APP_URL, never the request host", async () => {
    const response = await register(
      new NextRequest("http://0.0.0.0:3000/api/customer/auth/register", {
        method: "POST",
        headers: {
          cookie: `valmont_csrf=${csrf}`,
          "content-type": "application/json",
          "x-valmont-csrf": csrf,
          host: "attacker.example",
        },
        body: JSON.stringify(registrationBody("")),
      }),
    );

    expect(response.status).toBe(201);
    const email = mocks.sendCustomerEmail.mock.calls[0]?.[0] as {
      text: string;
      html: string;
    };
    expect(email.text).toContain(
      "https://shop.example/api/customer/auth/verify?token=",
    );
    expect(email.text).not.toContain("0.0.0.0");
    expect(email.text).not.toContain("attacker.example");
  });

  it("redirects a verification click to the APP_URL login page", async () => {
    const response = await verify(
      new NextRequest(
        "http://0.0.0.0:3000/api/customer/auth/verify?token=verification-token-1234567890",
        { headers: { host: "attacker.example" } },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://shop.example/account/login?verified=success",
    );
  });

  describe("registration does not reveal whether an address is taken", () => {
    const verifiedOwner = {
      id: "account-1",
      email: "ama@example.com",
      name: "Ama Mensah",
      emailVerifiedAt: "2026-08-01T00:00:00.000Z",
    };

    it("answers a brand-new address and an existing one identically", async () => {
      const fresh = await register(
        mutation("/api/customer/auth/register", registrationBody("")),
      );
      const freshBody = await fresh.json();

      mocks.accountStore.getByEmail.mockResolvedValue(verifiedOwner);
      const taken = await register(
        mutation("/api/customer/auth/register", registrationBody("")),
      );
      const takenBody = await taken.json();

      expect(fresh.status).toBe(201);
      expect(taken.status).toBe(201);
      expect(takenBody).toEqual(freshBody);
      expect(mocks.accountStore.createAccount).toHaveBeenCalledTimes(1);
    });

    it("tells the real owner of a verified address instead of the requester", async () => {
      mocks.accountStore.getByEmail.mockResolvedValue(verifiedOwner);

      const response = await register(
        mutation("/api/customer/auth/register", registrationBody("")),
      );

      expect(response.status).toBe(201);
      expect(mocks.accountStore.createAccount).not.toHaveBeenCalled();
      expect(mocks.accountStore.createToken).not.toHaveBeenCalled();
      const email = mocks.sendCustomerEmail.mock.calls[0]?.[0] as {
        to: string;
        subject: string;
        text: string;
      };
      expect(email.to).toBe("ama@example.com");
      expect(email.subject).toMatch(/already have/i);
      expect(email.text).toContain("https://shop.example/account/login");
    });

    it("re-sends a verification link when the existing account is unverified", async () => {
      mocks.accountStore.getByEmail.mockResolvedValue({
        ...verifiedOwner,
        emailVerifiedAt: undefined,
      });

      const response = await register(
        mutation("/api/customer/auth/register", registrationBody("")),
      );

      expect(response.status).toBe(201);
      expect(mocks.accountStore.createAccount).not.toHaveBeenCalled();
      expect(mocks.accountStore.createToken).toHaveBeenCalledWith(
        "account-1",
        "verify_email",
        expect.any(Number),
      );
      const email = mocks.sendCustomerEmail.mock.calls[0]?.[0] as {
        subject: string;
        text: string;
      };
      expect(email.subject).toMatch(/verify/i);
      expect(email.text).toContain(
        "https://shop.example/api/customer/auth/verify?token=",
      );
    });

    it("stays neutral when the existing-owner email cannot be delivered", async () => {
      mocks.accountStore.getByEmail.mockResolvedValue(verifiedOwner);
      const { CustomerEmailDeliveryError } = await import("@/lib/api-errors");
      mocks.sendCustomerEmail.mockRejectedValueOnce(
        new CustomerEmailDeliveryError(),
      );

      const response = await register(
        mutation("/api/customer/auth/register", registrationBody("")),
      );

      expect(response.status).toBe(201);
    });
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

  describe("websites with customer accounts switched off", () => {
    beforeEach(() => {
      mocks.publicGetDraft.mockResolvedValue({
        id: "11111111-2222-4333-8444-555555555555",
        ownerId: "owner-1",
        brief: { features: { customerAccounts: false } },
      });
    });

    it("refuses a direct order claim", async () => {
      const response = await claim(
        mutation("/api/customer/orders/claim", {
          accessCode: "guest-order-access-code-1234",
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.ordersStore.claimForCustomer).not.toHaveBeenCalled();
    });

    it("refuses a registration-time claim but never creates the account", async () => {
      const response = await register(
        mutation(
          "/api/customer/auth/register",
          registrationBody("guest-order-access-code-1234"),
        ),
      );

      expect(response.status).toBe(400);
      expect(mocks.accountStore.createAccount).not.toHaveBeenCalled();
      expect(mocks.accountStore.createToken).not.toHaveBeenCalled();
    });

    it("still verifies the email but never claims the order", async () => {
      const response = await verify(
        new NextRequest(
          "http://localhost/api/customer/auth/verify?token=verification-token-1234567890",
        ),
      );

      expect(response.status).toBe(307);
      expect(mocks.accountStore.verifyEmail).toHaveBeenCalledWith("account-1");
      expect(mocks.publicGetDraft).toHaveBeenCalledWith(
        "11111111-2222-4333-8444-555555555555",
      );
      expect(mocks.ordersStore.claimForCustomer).not.toHaveBeenCalled();
    });
  });
});
