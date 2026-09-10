/**
 * Stage 7b R7 — the public checkout never grows an "agent_wallet" rail.
 *
 * "agent_wallet" is deliberately NOT in PAYMENT_METHODS: it is not
 * selectable in Studio → Payments, it is refused by the public checkout
 * exactly like any other unknown method (400, generic message, no order, no
 * payment link), and a caller-supplied agentId never lands in an order the
 * public route creates. This file pins the boundary from the checkout side;
 * the new agent route tests prove where wallet checkout actually lives.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/studio/drafts/[id]/checkout/route";
import {
  PAYMENT_METHODS,
  isPaymentMethodId,
} from "@/lib/studio/site-brief/schema";

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
const bundleDraft = {
  id: draftId,
  ownerId: "owner-1",
  brief: {
    businessName: "Bundle Shop",
    category: "data-bundles",
    currency: "GHS",
    items: [
      {
        id: "bundle-00",
        name: "MTN 1GB",
        price: 10,
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
const shopDraft = {
  ...bundleDraft,
  brief: {
    ...bundleDraft.brief,
    category: "shop",
    items: [{ id: "item-1", name: "Rice", price: 25 }],
    payments: { ...bundleDraft.brief.payments, methods: ["cod", "momo"] },
  },
};

function request(paymentMethod: string, extras: Record<string, unknown> = {}) {
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
        paymentMethod,
        ...extras,
      }),
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
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
  mocks.create.mockResolvedValue({
    id: "22222222-3333-4444-8555-666666666666",
    status: "pending",
  });
  mocks.notifyMerchantNewOrder.mockResolvedValue({
    email: "skipped",
    whatsapp: "skipped",
  });
});

describe("agent_wallet has no place in the public checkout", () => {
  it("PAYMENT_METHODS is byte-for-byte the pre-Stage-7b list it always was", () => {
    expect(PAYMENT_METHODS.map((method) => method.id)).toEqual([
      "valmont_pay",
      "momo",
      "card",
      "bank",
      "cod",
    ]);
    expect(isPaymentMethodId("agent_wallet")).toBe(false);
    expect(
      PAYMENT_METHODS.find(
        (method) => (method.id as string) === "agent_wallet",
      ),
    ).toBeUndefined();
  });

  it("a bundle shop refuses agent_wallet like any other unknown method — 400, no order, no link", async () => {
    const response = await POST(request("agent_wallet"), params());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "That payment method is not available for this shop.",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
    expect(mocks.notifyMerchantNewOrder).not.toHaveBeenCalled();
  });

  it("a non-bundle shop refuses agent_wallet the same way", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue(shopDraft);
    const req = new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [{ itemId: "item-1", quantity: 1 }],
          customerName: "Ama Mensah",
          customerPhone: "+233240000000",
          customerAddress: "12 Independence Avenue",
          paymentMethod: "agent_wallet",
        }),
      },
    );
    const response = await POST(req, params());
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
  });

  it("a caller-supplied agentId never lands in a public order", async () => {
    const response = await POST(
      request("valmont_pay", { agentId: "agent-forged-by-client" }),
      params(),
    );
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const created = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created.agentId).toBeUndefined();
    expect(created.paymentMethod).toBe("valmont_pay");
  });
});
