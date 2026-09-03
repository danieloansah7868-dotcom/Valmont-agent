/**
 * Checkout HTTP route — Stage 4 live-money guard for bundle shops.
 *
 * A data-bundles order paid with REAL money must be deliverable
 * automatically; until a live delivery provider is connected (Stage 5) such
 * a checkout is refused with 409 before any order row exists. Test-mode
 * checkout is unaffected.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/studio/drafts/[id]/checkout/route";
import { resetRateLimitForTests } from "@/lib/security";

const mocks = vi.hoisted(() => ({
  internalGetDraftForCheckout: vi.fn(),
  create: vi.fn(),
  onlinePaymentAvailability: vi.fn(),
  createPaymentLink: vi.fn(),
  bundleDeliveryAvailability: vi.fn(),
  notifyMerchantNewOrder: vi.fn(),
  getCustomerSession: vi.fn(),
}));

vi.mock("@/lib/studio/draft-public", () => ({
  internalGetDraftForCheckout: mocks.internalGetDraftForCheckout,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => ({ create: mocks.create }),
}));

vi.mock("@/lib/studio/valmont-pay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/studio/valmont-pay")>();
  return {
    ...actual,
    onlinePaymentAvailability: mocks.onlinePaymentAvailability,
    createPaymentLink: mocks.createPaymentLink,
  };
});

vi.mock("@/lib/studio/bundle-delivery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/studio/bundle-delivery")>();
  return {
    ...actual,
    bundleDeliveryAvailability: mocks.bundleDeliveryAvailability,
  };
});

vi.mock("@/lib/studio/notifications", () => ({
  notifyMerchantNewOrder: mocks.notifyMerchantNewOrder,
}));

vi.mock("@/lib/customer-auth", () => ({
  getCustomerSession: mocks.getCustomerSession,
}));

const draftId = "draft-checkout-guard";
const bundleDraft = {
  id: draftId,
  ownerId: "owner-1",
  brief: {
    businessName: "Guard Bundles",
    category: "data-bundles",
    currency: "GHS",
    items: [
      {
        id: "b1",
        name: "MTN 1GB",
        price: 10,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    payments: {
      enabled: true,
      methods: ["valmont_pay"],
      valmontPay: { provisioned: false },
      delivery: { enabled: false, fee: 0, minimumOrder: 0 },
      notifications: {},
      staged: { enabled: false, stages: [] },
    },
    features: { customerAccounts: false },
  },
};

function request() {
  return new NextRequest(
    `http://localhost/api/studio/drafts/${draftId}/checkout`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lines: [{ itemId: "b1", quantity: 1 }],
        customerName: "Kwame Buyer",
        recipientPhone: "0240000001",
        customerPhone: "0200000002",
        paymentMethod: "valmont_pay",
      }),
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("bundle checkout live-money guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitForTests();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.internalGetDraftForCheckout.mockResolvedValue(bundleDraft);
    mocks.getCustomerSession.mockResolvedValue(null);
    mocks.bundleDeliveryAvailability.mockReturnValue({
      provider: "simulator",
      live: false,
    });
    mocks.create.mockResolvedValue({ id: "order-1", status: "pending" });
    mocks.createPaymentLink.mockResolvedValue({
      paymentLink: "/pay/code-1",
      live: false,
    });
    mocks.notifyMerchantNewOrder.mockResolvedValue({
      email: "skipped",
      whatsapp: "skipped",
    });
  });

  it("refuses a live-money bundle checkout with 409 before any order row exists", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });

    const response = await POST(request(), params());

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

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: "test",
        recipientPhone: "0240000001",
      }),
    );
    const body = await response.json();
    expect(body).toMatchObject({ orderId: "order-1", status: "pending" });
  });

  it("still refuses online checkout when the payment rail itself is misconfigured", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: false,
      mode: "live",
      reason: "Live mode is selected but keys are missing.",
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
