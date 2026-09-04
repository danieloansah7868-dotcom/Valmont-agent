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
  bundleDeliveryAvailability: vi.fn(),
  // Stage 5: the live-money guard now asks about THIS website's own TechChief
  // connection, so the per-draft resolver is mocked too. Without it the route
  // would reach the real integration store and write to `.data/` during tests.
  bundleDeliveryAvailabilityForDraft: vi.fn(),
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

vi.mock("@/lib/studio/bundle-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio/bundle-delivery")>()),
  bundleDeliveryAvailability: mocks.bundleDeliveryAvailability,
  bundleDeliveryAvailabilityForDraft: mocks.bundleDeliveryAvailabilityForDraft,
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
    mocks.bundleDeliveryAvailability.mockReturnValue({
      provider: "simulator",
      live: false,
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
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

/**
 * The customerPhone field went optional so a bundle shop can leave the buyer
 * contact blank. Every other shop type must keep the rule it always had: a
 * phone number is required and at least 6 characters.
 */
describe("checkout non-bundle phone floor", () => {
  function shopRequest(customerPhone: string) {
    return new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [{ itemId: "item-1", quantity: 1 }],
          customerName: "Ama Mensah",
          customerPhone,
          paymentMethod: "cod",
          customerAddress: "12 Independence Avenue",
        }),
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.internalGetDraftForCheckout.mockResolvedValue(draft);
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: false,
      mode: "live",
    });
  });

  it("rejects a too-short number with 400 and never creates an order", async () => {
    const response = await POST(shopRequest("12345"), params());

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("still rejects a blank number with 400", async () => {
    const response = await POST(shopRequest(""), params());

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["0301234567", "+233240000000", "123456"])(
    "accepts %s with 200",
    async (phone) => {
      const response = await POST(shopRequest(phone), params());

      expect(response.status).toBe(200);
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ customerPhone: phone }),
      );
    },
  );
});

/**
 * Bundle buyers are often in the diaspora paying for family in Ghana, so the
 * buyer's own contact number may be from any country. The recipient — the
 * number the bundle is actually delivered to — stays Ghana-mobile-only.
 */
describe("checkout bundle buyer contact accepts any country", () => {
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

  function bundleRequest(body: Record<string, unknown>) {
    return new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [{ itemId: "bundle-00", quantity: 1 }],
          customerName: "Ama Diaspora",
          paymentMethod: "valmont_pay",
          ...body,
        }),
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.internalGetDraftForCheckout.mockResolvedValue(bundleDraft);
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });
    // These run in payment mode "test", so the Stage 4 live-money guard is
    // never reached; the default keeps any future mode change honest.
    mocks.bundleDeliveryAvailability.mockReturnValue({
      provider: "simulator",
      live: false,
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
    });
  });

  it("accepts a UK number as the BUYER contact with 200", async () => {
    const response = await POST(
      bundleRequest({
        recipientPhone: "0240000001",
        customerPhone: "+44 7700 900123",
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPhone: "0240000001",
        customerPhone: "+44 7700 900123",
      }),
    );
  });

  it("rejects the same UK number as the RECIPIENT with 400", async () => {
    const response = await POST(
      bundleRequest({ recipientPhone: "+44 7700 900123" }),
      params(),
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("normalises a Ghana mobile buyer to 0240000001", async () => {
    const response = await POST(
      bundleRequest({
        recipientPhone: "0240000001",
        customerPhone: "+233240000001",
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ customerPhone: "0240000001" }),
    );
  });

  it("rejects a too-short buyer contact with 400", async () => {
    const response = await POST(
      bundleRequest({ recipientPhone: "0240000001", customerPhone: "12345" }),
      params(),
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

/**
 * Stage 4 live-money guard: a data-bundles order paid with REAL money must
 * be deliverable automatically; until a live delivery provider is connected
 * (Stage 5) such a checkout is refused with 409 before any order row exists.
 * Test-mode checkout is unaffected: the simulated payment pairs with the
 * simulated delivery engine.
 */
describe("bundle checkout live-money guard", () => {
  const bundleDraft = {
    ...draft,
    brief: {
      ...draft.brief,
      category: "data-bundles",
      businessName: "Guard Bundles Shop",
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

  function guardRequest() {
    return new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [{ itemId: "bundle-00", quantity: 1 }],
          customerName: "Kwame Buyer",
          recipientPhone: "0240000001",
          customerPhone: "0200000002",
          paymentMethod: "valmont_pay",
        }),
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.internalGetDraftForCheckout.mockResolvedValue(bundleDraft);
    mocks.getCustomerSession.mockResolvedValue(null);
    mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
    mocks.computeTotals.mockReturnValue({
      subtotal: 10,
      deliveryFee: 0,
      total: 10,
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
    // Nothing connected today can deliver for real (Stage 5 stub pending).
    mocks.bundleDeliveryAvailability.mockReturnValue({
      provider: "simulator",
      live: false,
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
    });
  });

  it("refuses a live-money bundle checkout with 409 before any order row exists", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });

    const response = await POST(guardRequest(), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "This shop cannot send bundles automatically yet. Please contact the shop.",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
    expect(mocks.notifyMerchantNewOrder).not.toHaveBeenCalled();
  });

  it("accepts the same checkout in test mode and creates the order", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });

    const response = await POST(guardRequest(), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: "test",
        recipientPhone: "0240000001",
      }),
    );
    const body = await response.json();
    expect(body).toMatchObject({ orderId: createdOrder.id, status: "pending" });
  });

  it("still refuses online checkout when the payment rail itself is misconfigured", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: false,
      mode: "live",
      reason: "Live mode is selected but keys are missing.",
    });

    const response = await POST(guardRequest(), params());

    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // --- Stage 5: the guard is now per website -------------------------------

  it("accepts a live-money bundle checkout once this website's TechChief key is verified", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    // The shop connected its own TechChief account, so it can really deliver.
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "techchief",
      live: true,
    });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "https://pay.example/checkout",
      live: true,
    });

    const response = await POST(guardRequest(), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: "live" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      orderId: createdOrder.id,
      status: "pending",
      live: true,
    });
  });

  it("asks about the shop's own connection, never the server-wide default", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "techchief",
      live: true,
    });

    await POST(guardRequest(), params());

    expect(mocks.bundleDeliveryAvailabilityForDraft).toHaveBeenCalledWith(
      draftId,
    );
    // One client's key must never unlock live sales for another website, so
    // the environment-level answer is no longer consulted here at all.
    expect(mocks.bundleDeliveryAvailability).not.toHaveBeenCalled();
  });

  it("a connection that is saved but not verified still refuses live money", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
    });

    const response = await POST(guardRequest(), params());

    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

/**
 * Stage 4b — basket caps on a data-bundles website.
 *
 * Every unit in a bundle basket becomes one real top-up through the shop's own
 * TechChief key, so an unbounded basket is an unbounded bill. These pin the
 * server-side half of the rule (the storefront clamping is courtesy): the exact
 * 400 sentence, that it fires before any order row exists, that the boundary
 * values 10 and 20 are still accepted, and — the part that protects every
 * other client — that a website which is not a bundle shop is untouched.
 */
describe("bundle checkout order caps", () => {
  const capDraft = {
    ...draft,
    brief: {
      ...draft.brief,
      category: "data-bundles",
      businessName: "Capped Bundles Shop",
      items: [
        {
          id: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          category: "mtn",
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
        {
          id: "bundle-01",
          name: "Telecel 1GB",
          price: 9,
          category: "telecel",
          bundle: { network: "telecel", dataMb: 1024, validity: "7 days" },
        },
        {
          id: "bundle-02",
          name: "AirtelTigo 1GB",
          price: 8,
          category: "airteltigo",
          bundle: { network: "airteltigo", dataMb: 1024, validity: "7 days" },
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

  const CAP_MESSAGE =
    "You can order up to 10 of one bundle and 20 bundles per order.";

  function capRequest(lines: Array<{ itemId: string; quantity: number }>) {
    return new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines,
          customerName: "Kwame Buyer",
          recipientPhone: "0240000001",
          customerPhone: "0200000002",
          paymentMethod: "valmont_pay",
        }),
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.internalGetDraftForCheckout.mockResolvedValue(capDraft);
    mocks.getCustomerSession.mockResolvedValue(null);
    mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
    mocks.computeTotals.mockReturnValue({
      subtotal: 20,
      deliveryFee: 0,
      total: 20,
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
    // Test mode, so the Stage 5 live-money guard is not what these cases hit.
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "test",
    });
    mocks.bundleDeliveryAvailability.mockReturnValue({
      provider: "simulator",
      live: false,
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
    });
  });

  it("refuses more than the per-line cap with 400 and the exact sentence", async () => {
    const response = await POST(
      capRequest([{ itemId: "bundle-00", quantity: 11 }]),
      params(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: CAP_MESSAGE });
  });

  it("refuses a basket over the per-order cap even when no single line is too big", async () => {
    const response = await POST(
      capRequest([
        { itemId: "bundle-00", quantity: 7 },
        { itemId: "bundle-01", quantity: 7 },
        { itemId: "bundle-02", quantity: 7 },
      ]),
      params(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: CAP_MESSAGE });
  });

  it("creates nothing at all when it refuses", async () => {
    const response = await POST(
      capRequest([{ itemId: "bundle-00", quantity: 21 }]),
      params(),
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
    expect(mocks.notifyMerchantNewOrder).not.toHaveBeenCalled();
    // Refused before the payment rail is even asked about.
    expect(mocks.bundleDeliveryAvailabilityForDraft).not.toHaveBeenCalled();
  });

  it("accepts exactly the per-line cap", async () => {
    const response = await POST(
      capRequest([{ itemId: "bundle-00", quantity: 10 }]),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [expect.objectContaining({ quantity: 10 })],
      }),
    );
  });

  it("accepts exactly the per-order cap spread over two lines", async () => {
    const response = await POST(
      capRequest([
        { itemId: "bundle-00", quantity: 10 },
        { itemId: "bundle-01", quantity: 10 },
      ]),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("leaves a website that is not a bundle shop completely alone", async () => {
    // The default fixture is a food shop: 999 of one line is a big catering
    // order, not 999 provider calls, and must stay allowed.
    mocks.internalGetDraftForCheckout.mockResolvedValue(draft);

    const response = await POST(
      new NextRequest(
        `http://localhost/api/studio/drafts/${draftId}/checkout`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lines: [{ itemId: "item-1", quantity: 999 }],
            customerName: "Ama Mensah",
            customerPhone: "+233240000000",
            customerAddress: "12 Independence Avenue",
            paymentMethod: "cod",
          }),
        },
      ),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [expect.objectContaining({ quantity: 999 })],
      }),
    );
  });
});
