import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderRecord } from "@/lib/studio/orders";

const mocks = vi.hoisted(() => ({
  customerEmailHtml: vi.fn(() => "<p>status</p>"),
  sendCustomerEmail: vi.fn(),
}));

vi.mock("@/lib/customer-email", () => ({
  customerEmailHtml: mocks.customerEmailHtml,
  sendCustomerEmail: mocks.sendCustomerEmail,
}));

import { notifyCustomerOrderStatus } from "@/lib/customer-order-notifications";

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: "access-code",
    status: "out_for_delivery",
    currency: "GHS",
    subtotal: 100,
    deliveryFee: 0,
    total: 100,
    lines: [{ itemId: "item-1", name: "Jollof", price: 100, quantity: 1 }],
    customerName: "Ama Mensah",
    customerPhone: "+233240000000",
    customerEmail: "ama@example.com",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    statusHistory: [],
    ...overrides,
  };
}

describe("customer order status notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendCustomerEmail.mockResolvedValue({ delivered: true });
  });

  it("skips orders without a checkout email", async () => {
    await expect(
      notifyCustomerOrderStatus({
        order: order({ customerEmail: undefined }),
        origin: "https://shop.example",
      }),
    ).resolves.toBe("skipped");
    expect(mocks.sendCustomerEmail).not.toHaveBeenCalled();
  });

  it("sends an authenticated tracking URL for a linked order", async () => {
    const result = await notifyCustomerOrderStatus({
      order: order({ customerAccountId: "account-1" }),
      origin: "https://shop.example/",
    });

    expect(result).toBe("sent");
    expect(mocks.sendCustomerEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ama@example.com",
        subject: "Order 11111111: Out for delivery",
        text: expect.stringContaining(
          "https://shop.example/account/orders/11111111-2222-4333-8444-555555555555",
        ),
      }),
    );
  });

  it("uses the public confirmation URL for a guest order", async () => {
    await notifyCustomerOrderStatus({
      order: order(),
      origin: "https://shop.example",
    });

    expect(mocks.sendCustomerEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "https://shop.example/orders/11111111-2222-4333-8444-555555555555/confirmed",
        ),
      }),
    );
  });

  it("does not fail the merchant update when delivery fails", async () => {
    mocks.sendCustomerEmail.mockRejectedValueOnce(new Error("provider down"));

    await expect(
      notifyCustomerOrderStatus({
        order: order(),
        origin: "https://shop.example",
      }),
    ).resolves.toBe("failed");
  });
});
