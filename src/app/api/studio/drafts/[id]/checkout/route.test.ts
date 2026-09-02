import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/studio/drafts/[id]/checkout/route";

const mocks = vi.hoisted(() => ({
  assertApiRateLimit: vi.fn(),
  assertSameOrigin: vi.fn(),
  internalGetDraftForCheckout: vi.fn(),
  getCustomerSession: vi.fn(),
  create: vi.fn(),
  getOrdersStore: vi.fn(),
  computeTotals: vi.fn(),
  createPaymentLink: vi.fn(),
  onlinePaymentAvailability: vi.fn(),
  notifyMerchantNewOrder: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  assertApiRateLimit: mocks.assertApiRateLimit,
  safeApiError: (error: unknown) => {
    throw error;
  },
}));

vi.mock("@/lib/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
}));

vi.mock("@/lib/studio/draft-public", () => ({
  internalGetDraftForCheckout: mocks.internalGetDraftForCheckout,
}));

vi.mock("@/lib/customer-auth", () => ({
  getCustomerSession: mocks.getCustomerSession,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: mocks.getOrdersStore,
}));

vi.mock("@/lib/studio/valmont-pay", () => ({
  computeTotals: mocks.computeTotals,
  createPaymentLink: mocks.createPaymentLink,
  onlinePaymentAvailability: mocks.onlinePaymentAvailability,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE:
    "Online payment is temporarily unavailable for this shop. Please choose another payment method or try again later.",
}));

vi.mock("@/lib/studio/notifications", () => ({
  notifyMerchantNewOrder: mocks.notifyMerchantNewOrder,
}));

const draftId = "11111111-2222-4333-8444-555555555555";
const account = {
  id: "account-1",
  email: "Ama@Example.com",
};
const draft = {
  id: draftId,
  ownerId: "owner-1",
  brief: {
    businessName: "Akwaaba Bites",
    currency: "GHS",
    items: [{ id: "item-1", name: "Jollof Rice", price: 25 }],
    payments: {
      enabled: true,
      methods: ["cod"],
      delivery: {
        enabled: false,
        fee: 0,
        minimumOrder: 0,
        freeDeliveryAbove: 0,
      },
    },
    features: { customerAccounts: true },
  },
};
/** Identical website, but with the customer-accounts feature left off. */
const guestOnlyDraft = {
  ...draft,
  brief: { ...draft.brief, features: { customerAccounts: false } },
};
const createdOrder = {
  id: "22222222-3333-4444-8555-666666666666",
  status: "cod_pending",
};

function request(
  customerEmail?: string,
  options: { paymentMethod?: string; url?: string; host?: string } = {},
) {
  return new NextRequest(
    options.url ?? `http://localhost/api/studio/drafts/${draftId}/checkout`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.host ? { host: options.host } : {}),
      },
      body: JSON.stringify({
        lines: [{ itemId: "item-1", quantity: 1 }],
        customerName: "Ama Mensah",
        customerPhone: "+233240000000",
        customerEmail,
        paymentMethod: options.paymentMethod ?? "cod",
        customerAddress: "12 Independence Avenue",
      }),
    },
  );
}

/** The same shop with Valmont Pay switched on beside cash on delivery. */
const onlineDraft = {
  ...draft,
  brief: {
    ...draft.brief,
    payments: { ...draft.brief.payments, methods: ["cod", "valmont_pay"] },
  },
};

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("checkout customer account linking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "/pay/simulated",
      live: false,
    });
    mocks.internalGetDraftForCheckout.mockResolvedValue(draft);
    mocks.getCustomerSession.mockResolvedValue({
      account,
      token: "session-token",
      expiresAt: "2026-09-25T00:00:00.000Z",
    });
    mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
    mocks.computeTotals.mockReturnValue({
      subtotal: 25,
      deliveryFee: 0,
      total: 25,
    });
    mocks.create.mockResolvedValue(createdOrder);
    mocks.notifyMerchantNewOrder.mockResolvedValue({
      email: "skipped",
      whatsapp: "skipped",
    });
  });

  it("stores the signed-in account email and links a blank-email checkout", async () => {
    const response = await POST(request(""), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: account.email,
        customerAccountId: account.id,
      }),
    );
  });

  it("links checkout when the submitted email matches the account", async () => {
    const response = await POST(request("AMA@EXAMPLE.COM"), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: account.email,
        customerAccountId: account.id,
      }),
    );
  });

  it("keeps a mismatched submitted email as a guest order", async () => {
    const response = await POST(request("different@example.com"), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: "different@example.com",
        customerAccountId: undefined,
      }),
    );
  });

  it("never reads a customer session on a website with accounts off", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue(guestOnlyDraft);

    const response = await POST(request(""), params());

    expect(response.status).toBe(200);
    expect(mocks.getCustomerSession).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ customerAccountId: undefined }),
    );
  });
});

describe("checkout payment rail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.internalGetDraftForCheckout.mockResolvedValue(onlineDraft);
    mocks.getCustomerSession.mockResolvedValue(null);
    mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
    mocks.computeTotals.mockReturnValue({
      subtotal: 25,
      deliveryFee: 0,
      total: 25,
    });
    mocks.create.mockResolvedValue({ ...createdOrder, status: "pending" });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "/pay/simulated",
      live: false,
    });
    mocks.notifyMerchantNewOrder.mockResolvedValue({
      email: "skipped",
      whatsapp: "skipped",
    });
  });

  it("stamps an online order with the test rail while the simulator is active", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });

    const response = await POST(
      request("", { paymentMethod: "valmont_pay" }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: "test" }),
    );
  });

  it("stamps an online order as live once Valmont Pay is fully configured", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "https://pay.example/l/abc",
      live: true,
    });

    const response = await POST(
      request("", { paymentMethod: "valmont_pay" }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: "live" }),
    );
  });

  it("keeps cash-on-delivery orders live even while online payment is in test mode", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });

    const response = await POST(request(""), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: "cod", paymentMode: "live" }),
    );
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
  });

  it("refuses online payment — before creating an order — when Live is selected but incomplete", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: false,
      mode: "live",
      reason: "webhook secret missing",
    });

    const response = await POST(
      request("", { paymentMethod: "valmont_pay" }),
      params(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining(
        "Online payment is temporarily unavailable",
      ),
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
    expect(mocks.notifyMerchantNewOrder).not.toHaveBeenCalled();
  });

  it("still accepts cash on delivery while Live is selected but incomplete", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: false,
      mode: "live",
    });

    const response = await POST(request(""), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: "cod", paymentMode: "live" }),
    );
  });

  it("builds the merchant link and Valmont Pay callback from APP_URL, not the request host", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });

    const response = await POST(
      request("", {
        paymentMethod: "valmont_pay",
        url: `http://0.0.0.0:3000/api/studio/drafts/${draftId}/checkout`,
        host: "attacker.example",
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.notifyMerchantNewOrder).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://shop.example" }),
    );
    const call = mocks.createPaymentLink.mock.calls[0]?.[0] as {
      callbackUrl: string;
    };
    expect(call.callbackUrl).toMatch(
      /^https:\/\/shop\.example\/api\/payments\/webhook\?access_code=[0-9a-f]{32}$/,
    );
  });
});

describe("checkout data-bundles Ghana mobile validation", () => {
  const bundleDraft = {
    ...draft,
    brief: {
      ...draft.brief,
      category: "data-bundles",
      businessName: "Ghana Bundles Shop",
      items: [
        {
          id: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          category: "mtn",
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
      ],
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        delivery: {
          enabled: false,
          fee: 0,
          minimumOrder: 0,
          freeDeliveryAbove: 0,
        },
      },
    },
  };

  function bundleRequest(
    recipientPhone: string,
    customerPhone?: string,
    paymentMethod = "valmont_pay",
  ) {
    return new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [{ itemId: "bundle-00", quantity: 1 }],
          customerName: "Kwame Buyer",
          recipientPhone,
          customerPhone: customerPhone ?? "",
          paymentMethod,
        }),
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "/pay/simulated",
      live: false,
    });
    mocks.internalGetDraftForCheckout.mockResolvedValue(bundleDraft);
    mocks.getCustomerSession.mockResolvedValue(null);
    mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
    mocks.computeTotals.mockReturnValue({
      subtotal: 10,
      deliveryFee: 0,
      total: 10,
    });
    mocks.create.mockResolvedValue({ ...createdOrder, status: "pending" });
    mocks.notifyMerchantNewOrder.mockResolvedValue({
      email: "skipped",
      whatsapp: "skipped",
    });
  });

  it("accepts +233 24 000 0001 and normalizes to 0240000001 with payment link", async () => {
    const response = await POST(bundleRequest("+233 24 000 0001"), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPhone: "0240000001",
        customerPhone: "0240000001",
      }),
    );
    expect(mocks.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ customerPhone: "0240000001" }),
    );
  });

  it("stores buyer number separately when given", async () => {
    const response = await POST(
      bundleRequest("0240000001", "0200000002"),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPhone: "0240000001",
        customerPhone: "0200000002",
      }),
    );
  });

  it("falls back customerPhone to recipient when buyer blank", async () => {
    const response = await POST(bundleRequest("0240000001", ""), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPhone: "0240000001",
        customerPhone: "0240000001",
      }),
    );
  });

  it.each(["030 123 4567", "+44 7700 900123", "02412345"])(
    "rejects %s with 400 and never creates order",
    async (badPhone) => {
      const response = await POST(bundleRequest(badPhone), params());

      expect(response.status).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.createPaymentLink).not.toHaveBeenCalled();
    },
  );

  it("rejects missing recipient phone with 400", async () => {
    const response = await POST(bundleRequest(""), params());

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects cod on bundle shop with 400", async () => {
    const response = await POST(
      bundleRequest("0240000001", "", "cod"),
      params(),
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("accepts landline 0301234567 for non-bundle shop (unchanged)", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue(draft);
    const req = new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [{ itemId: "item-1", quantity: 1 }],
          customerName: "Ama Mensah",
          customerPhone: "0301234567",
          paymentMethod: "cod",
          customerAddress: "12 Independence Avenue",
        }),
      },
    );
    const response = await POST(req, params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalled();
  });
});
