/**
 * Stage 6a — the checkout live-money guard learns about packages.
 *
 * The 409 "This shop cannot send bundles automatically yet…" now applies only
 * when the website is supposed to send automatically (Auto-Dispatch Pro and
 * up): a Starter Shop sends by hand, so its live checkout is accepted with no
 * TechChief key at all. `bundleDeliveryAvailabilityForDraft` is mocked (never
 * the real integration store — no `.data/` writes in tests), exactly like the
 * Stage 5 tests in `route.test.ts`, which stay green unedited beside this
 * file and prove the non-Starter path is unchanged.
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

/** A data-bundles shop: Valmont Pay only, one priced bundle. */
const bundleDraft = {
  id: draftId,
  ownerId: "owner-1",
  brief: {
    businessName: "Adom Data Hub",
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
    features: { customerAccounts: false },
  },
};

/** The same shop, sold as Starter (manual delivery). */
const starterBundleDraft = {
  ...bundleDraft,
  brief: { ...bundleDraft.brief, plan: "starter" },
};

/** A food shop that happens to carry a plan — the plan must be ignored. */
const foodDraft = {
  ...bundleDraft,
  brief: {
    ...bundleDraft.brief,
    category: "restaurant",
    plan: "starter",
    payments: {
      ...bundleDraft.brief.payments,
      methods: ["valmont_pay"],
    },
  },
};

function request(paymentMethod = "valmont_pay") {
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
  // Live money: this is what puts the bundle-delivery guard in the path.
  mocks.onlinePaymentAvailability.mockResolvedValue({
    available: true,
    mode: "live",
  });
  mocks.bundleDeliveryAvailability.mockReturnValue({
    provider: "simulator",
    live: false,
  });
  mocks.createPaymentLink.mockResolvedValue({
    paymentLink: "/pay/live",
    live: true,
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
  mocks.internalGetDraftForCheckout.mockResolvedValue(bundleDraft);
});

describe("Stage 6a — the live-bundle 409 is package-aware", () => {
  it("a Starter shop accepts a LIVE bundle checkout with no key at all", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue(starterBundleDraft);
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "manual",
      live: false,
      manual: true,
      plan: "starter",
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: "live" }),
    );
    expect(mocks.createPaymentLink).toHaveBeenCalled();
  });

  it("an Auto-Dispatch Pro shop without a key is still refused with 409", async () => {
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
      manual: false,
      plan: "auto_dispatch",
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This shop cannot send bundles automatically yet. Please contact the shop.",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createPaymentLink).not.toHaveBeenCalled();
  });

  it("an Auto-Dispatch Pro shop with a verified key is accepted (live path unchanged)", async () => {
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "techchief",
      live: true,
      manual: false,
      plan: "auto_dispatch",
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: "live" }),
    );
  });

  it("a food shop with a Starter plan is unaffected — the guard is never even asked", async () => {
    mocks.internalGetDraftForCheckout.mockResolvedValue(foodDraft);

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: "live" }),
    );
    expect(mocks.bundleDeliveryAvailabilityForDraft).not.toHaveBeenCalled();
  });
});
