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
  },
};
const createdOrder = {
  id: "22222222-3333-4444-8555-666666666666",
  status: "cod_pending",
};

function request(customerEmail?: string) {
  return new NextRequest(
    `http://localhost/api/studio/drafts/${draftId}/checkout`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lines: [{ itemId: "item-1", quantity: 1 }],
        customerName: "Ama Mensah",
        customerPhone: "+233240000000",
        customerEmail,
        paymentMethod: "cod",
        customerAddress: "12 Independence Avenue",
      }),
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("checkout customer account linking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
