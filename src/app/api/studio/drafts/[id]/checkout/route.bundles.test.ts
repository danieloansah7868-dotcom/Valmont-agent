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

const bundleDraft = {
  id: draftId,
  ownerId: "owner-1",
  brief: {
    businessName: "Data Hub Ghana",
    currency: "GHS",
    items: [],
    dataBundles: [
      {
        id: "bundle-1",
        network: "mtn",
        volume: "2GB",
        validityDays: 30,
        price: 15,
        name: "MTN 2GB - 30 days",
        active: true,
      },
      {
        id: "bundle-2",
        network: "telecel",
        volume: "5GB",
        validityDays: 30,
        price: 30,
        name: "Telecel 5GB - 30 days",
        active: true,
      },
      {
        id: "bundle-inactive",
        network: "mtn",
        volume: "1GB",
        validityDays: 30,
        price: 8,
        name: "MTN 1GB - 30 days",
        active: false,
      },
    ],
    payments: {
      enabled: true,
      methods: ["cod", "valmont_pay"],
      delivery: {
        enabled: false,
        fee: 0,
        minimumOrder: 0,
        freeDeliveryAbove: 0,
      },
    },
    features: { customerAccounts: false, dataBundles: true },
  },
};

const createdOrder = {
  id: "22222222-3333-4444-8555-666666666666",
  status: "cod_pending",
};

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost/api/studio/drafts/${draftId}/checkout`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("checkout with data bundles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "https://pay.example/l/abc",
      live: true,
    });
    mocks.internalGetDraftForCheckout.mockResolvedValue(bundleDraft);
    mocks.getCustomerSession.mockResolvedValue(null);
    mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
    mocks.computeTotals.mockReturnValue({
      subtotal: 15,
      deliveryFee: 0,
      total: 15,
    });
    mocks.create.mockResolvedValue(createdOrder);
    mocks.notifyMerchantNewOrder.mockResolvedValue({
      email: "skipped",
      whatsapp: "skipped",
    });
  });

  it("accepts a bundle with recipient phone", async () => {
    const request = makeRequest({
      lines: [{ itemId: "bundle-1", quantity: 1 }],
      customerName: "Kwame Asante",
      customerPhone: "+233240000000",
      paymentMethod: "cod",
      bundleRecipientPhone: "0241234567",
    });

    const response = await POST(request, params());
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({
            itemId: "bundle-1",
            price: 15,
            bundleMeta: expect.objectContaining({
              network: "mtn",
              volume: "2GB",
              recipientPhone: "0241234567",
            }),
          }),
        ]),
      }),
    );
  });

  it("rejects bundle without recipient phone", async () => {
    const request = makeRequest({
      lines: [{ itemId: "bundle-1", quantity: 1 }],
      customerName: "Kwame Asante",
      customerPhone: "+233240000000",
      paymentMethod: "cod",
    });

    const response = await POST(request, params());
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects invalid recipient phone", async () => {
    const request = makeRequest({
      lines: [{ itemId: "bundle-1", quantity: 1 }],
      customerName: "Kwame Asante",
      customerPhone: "+233240000000",
      paymentMethod: "cod",
      bundleRecipientPhone: "123",
    });

    const response = await POST(request, params());
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects inactive bundle", async () => {
    const request = makeRequest({
      lines: [{ itemId: "bundle-inactive", quantity: 1 }],
      customerName: "Kwame Asante",
      customerPhone: "+233240000000",
      paymentMethod: "cod",
      bundleRecipientPhone: "0241234567",
    });

    const response = await POST(request, params());
    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects bundle when feature is off", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue({
      ...bundleDraft,
      brief: {
        ...bundleDraft.brief,
        features: { customerAccounts: false, dataBundles: false },
      },
    });

    const request = makeRequest({
      lines: [{ itemId: "bundle-1", quantity: 1 }],
      customerName: "Kwame Asante",
      customerPhone: "+233240000000",
      paymentMethod: "cod",
      bundleRecipientPhone: "0241234567",
    });

    const response = await POST(request, params());
    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("mixes items and bundles in one order", async () => {
    const draftWithItems = {
      ...bundleDraft,
      brief: {
        ...bundleDraft.brief,
        items: [{ id: "item-1", name: "Jollof", price: 25 }],
      },
    };
    mocks.internalGetDraftForCheckout.mockResolvedValue(draftWithItems);
    mocks.computeTotals.mockReturnValue({
      subtotal: 40,
      deliveryFee: 0,
      total: 40,
    });

    const request = makeRequest({
      lines: [
        { itemId: "item-1", quantity: 1 },
        { itemId: "bundle-1", quantity: 1 },
      ],
      customerName: "Kwame Asante",
      customerPhone: "+233240000000",
      paymentMethod: "cod",
      bundleRecipientPhone: "0241234567",
    });

    const response = await POST(request, params());
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ itemId: "item-1" }),
          expect.objectContaining({
            itemId: "bundle-1",
            bundleMeta: expect.any(Object),
          }),
        ]),
      }),
    );
  });
});
