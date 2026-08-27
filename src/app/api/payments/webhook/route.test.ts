import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/payments/webhook/route";

const mocks = vi.hoisted(() => ({
  getByAccessCode: vi.fn(),
  markPaid: vi.fn(),
  markFailed: vi.fn(),
  getOrdersStore: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  notifyCustomerOrderStatus: vi.fn(),
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: mocks.getOrdersStore,
}));

vi.mock("@/lib/studio/valmont-pay", () => ({
  verifyWebhookSignature: mocks.verifyWebhookSignature,
}));

vi.mock("@/lib/customer-order-notifications", () => ({
  notifyCustomerOrderStatus: mocks.notifyCustomerOrderStatus,
}));

const accessCode = "webhook-access-code";
const pendingOrder = {
  id: "11111111-2222-4333-8444-555555555555",
  status: "pending",
  customerEmail: "ama@example.com",
};

function request(body: unknown) {
  return new NextRequest(
    `http://localhost/api/payments/webhook?access_code=${accessCode}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("payment webhook customer notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrdersStore.mockReturnValue(mocks);
    mocks.verifyWebhookSignature.mockResolvedValue(true);
    mocks.getByAccessCode.mockResolvedValue(pendingOrder);
    mocks.markPaid.mockResolvedValue({
      ...pendingOrder,
      status: "paid",
    });
    mocks.markFailed.mockResolvedValue({
      ...pendingOrder,
      status: "payment_failed",
    });
    mocks.notifyCustomerOrderStatus.mockResolvedValue("sent");
  });

  it("notifies after a payment success changes the order status", async () => {
    const response = await POST(request({ event: "payment.success" }));

    expect(response.status).toBe(200);
    expect(mocks.markPaid).toHaveBeenCalledWith(accessCode, undefined);
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith({
      order: { ...pendingOrder, status: "paid" },
      origin: "http://localhost",
    });
  });

  it("notifies after a payment failure changes the order status", async () => {
    const response = await POST(request({ status: "failed" }));

    expect(response.status).toBe(200);
    expect(mocks.markFailed).toHaveBeenCalledWith(accessCode);
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith({
      order: { ...pendingOrder, status: "payment_failed" },
      origin: "http://localhost",
    });
  });

  it("does not notify when a repeated webhook leaves the status unchanged", async () => {
    mocks.getByAccessCode.mockResolvedValueOnce({
      ...pendingOrder,
      status: "paid",
    });
    mocks.markPaid.mockResolvedValueOnce({ ...pendingOrder, status: "paid" });

    const response = await POST(request({ status: "paid" }));

    expect(response.status).toBe(200);
    expect(mocks.notifyCustomerOrderStatus).not.toHaveBeenCalled();
  });

  it("rejects an unsigned webhook before touching the order", async () => {
    mocks.verifyWebhookSignature.mockResolvedValueOnce(false);

    const response = await POST(request({ status: "paid" }));

    expect(response.status).toBe(401);
    expect(mocks.getByAccessCode).not.toHaveBeenCalled();
    expect(mocks.notifyCustomerOrderStatus).not.toHaveBeenCalled();
  });
});
