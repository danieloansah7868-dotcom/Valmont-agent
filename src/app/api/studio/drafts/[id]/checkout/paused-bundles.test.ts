/**
 * Stage 6c — checkout refuses a PAUSED bundle, exactly where the unknown-item
 * 409 lives: inside the re-pricing loop, BEFORE the totals, the payment rail
 * and any order row. The mocks mirror `plan-gating.test.ts` beside this file
 * (which stays green unedited); the one difference is the catalogue: one
 * live bundle and one paused bundle.
 */
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

/** A data-bundles shop: one live bundle, one paused by the shop (Stage 6c). */
const mixedDraft = {
  id: draftId,
  ownerId: "owner-1",
  brief: {
    businessName: "Adom Data Hub",
    category: "data-bundles",
    plan: "auto_dispatch",
    currency: "GHS",
    items: [
      {
        id: "bundle-live",
        name: "MTN 1GB",
        price: 10,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
      {
        id: "bundle-paused",
        name: "MTN 2GB",
        price: 15,
        paused: true,
        bundle: { network: "mtn", dataMb: 2048, validity: "30 days" },
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
    features: { customerAccounts: false },
  },
};

function request(itemId: string) {
  return new NextRequest(
    `http://localhost/api/studio/drafts/${draftId}/checkout`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lines: [{ itemId, quantity: 1 }],
        customerName: "Kwame Buyer",
        recipientPhone: "0240000001",
        customerPhone: "0200000002",
        paymentMethod: "valmont_pay",
        customerAddress: "12 Independence Avenue",
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
  mocks.assertApiRateLimit.mockReturnValue(undefined);
  mocks.assertSameOrigin.mockReturnValue(undefined);
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
    paymentLink: "/pay/test",
    live: false,
  });
  mocks.getCustomerSession.mockResolvedValue(null);
  mocks.getOrdersStore.mockReturnValue({ create: mocks.create });
  mocks.computeTotals.mockReturnValue({
    subtotal: 10,
    deliveryFee: 0,
    total: 10,
  });
  mocks.create.mockResolvedValue({
    id: "22222222-3332-4444-8555-666666666666",
    status: "pending",
  });
  mocks.notifyMerchantNewOrder.mockResolvedValue({
    email: "skipped",
    whatsapp: "skipped",
  });
  mocks.internalGetDraftForCheckout.mockResolvedValue(mixedDraft);
});

describe("Stage 6c — a paused bundle cannot be ordered", () => {
  it("answers 400 with the plain sentence and creates no order row", async () => {
    const response = await POST(request("bundle-paused"), params());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This bundle is currently unavailable.",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("the live bundle beside it still checks out — the pause is per item", async () => {
    const response = await POST(request("bundle-live"), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const order = mocks.create.mock.calls[0][0] as { lines: unknown[] };
    expect(order.lines).toHaveLength(1);
  });

  it("the refusal fires even for a basket that mixes a live and a paused item", async () => {
    const mixed = new NextRequest(
      `http://localhost/api/studio/drafts/${draftId}/checkout`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: [
            { itemId: "bundle-live", quantity: 1 },
            { itemId: "bundle-paused", quantity: 1 },
          ],
          customerName: "Kwame Buyer",
          recipientPhone: "0240000001",
          customerPhone: "0200000002",
          paymentMethod: "valmont_pay",
          customerAddress: "12 Independence Avenue",
        }),
      },
    );
    const response = await POST(mixed, params());

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("an item with paused false (explicitly resumed) is orderable", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue({
      ...mixedDraft,
      brief: {
        ...mixedDraft.brief,
        items: mixedDraft.brief.items.map((item) =>
          item.id === "bundle-paused" ? { ...item, paused: false } : item,
        ),
      },
    });
    const response = await POST(request("bundle-paused"), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
