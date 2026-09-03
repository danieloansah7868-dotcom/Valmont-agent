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
  dispatchBundleDeliveriesForOrder: vi.fn(),
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: mocks.getOrdersStore,
}));

vi.mock("@/lib/studio/valmont-pay", () => ({
  verifyWebhookSignature: mocks.verifyWebhookSignature,
}));

vi.mock("@/lib/studio/bundle-delivery", () => ({
  dispatchBundleDeliveriesForOrder: mocks.dispatchBundleDeliveriesForOrder,
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
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
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
    mocks.dispatchBundleDeliveriesForOrder.mockResolvedValue([]);
  });

  it("fires the bundle delivery engine after a successful payment, fire-and-forget", async () => {
    const response = await POST(request({ event: "payment.success" }));

    expect(response.status).toBe(200);
    expect(mocks.markPaid).toHaveBeenCalledWith(accessCode, undefined);
    expect(mocks.dispatchBundleDeliveriesForOrder).toHaveBeenCalledWith(
      pendingOrder.id,
    );
  });

  it("keeps the webhook at 200 when the delivery dispatch rejects", async () => {
    mocks.dispatchBundleDeliveriesForOrder.mockRejectedValueOnce(
      new Error("delivery provider is down"),
    );

    const response = await POST(request({ status: "success" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "paid",
    });
  });

  it("does not fire delivery for a failed payment or a duplicate success webhook", async () => {
    const failed = await POST(request({ status: "failed" }));
    expect(failed.status).toBe(200);
    expect(mocks.dispatchBundleDeliveriesForOrder).not.toHaveBeenCalled();

    mocks.getByAccessCode.mockResolvedValueOnce({
      ...pendingOrder,
      status: "paid",
    });
    mocks.markPaid.mockResolvedValueOnce({ ...pendingOrder, status: "paid" });
    const duplicate = await POST(request({ status: "paid" }));
    expect(duplicate.status).toBe(200);
    expect(mocks.dispatchBundleDeliveriesForOrder).not.toHaveBeenCalled();
  });

  it("notifies after a payment success changes the order status", async () => {
    const response = await POST(request({ event: "payment.success" }));

    expect(response.status).toBe(200);
    expect(mocks.markPaid).toHaveBeenCalledWith(accessCode, undefined);
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith({
      order: { ...pendingOrder, status: "paid" },
      origin: "https://shop.example",
    });
  });

  it("notifies after a payment failure changes the order status", async () => {
    const response = await POST(request({ status: "failed" }));

    expect(response.status).toBe(200);
    expect(mocks.markFailed).toHaveBeenCalledWith(accessCode);
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith({
      order: { ...pendingOrder, status: "payment_failed" },
      origin: "https://shop.example",
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

  it("links the customer to APP_URL even when the callback arrives on the bind address", async () => {
    const response = await POST(
      new NextRequest(
        `http://0.0.0.0:3000/api/payments/webhook?access_code=${accessCode}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "attacker.example",
          },
          body: JSON.stringify({ event: "payment.success" }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://shop.example" }),
    );
  });

  it("stops reading an oversized body and answers 413 before any verification", async () => {
    const response = await POST(request({ pad: "x".repeat(60_000) }));

    expect(response.status).toBe(413);
    expect(mocks.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(mocks.getByAccessCode).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed JSON body without leaking detail", async () => {
    const response = await POST(
      new NextRequest(
        `http://localhost/api/payments/webhook?access_code=${accessCode}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request",
    });
    expect(mocks.markPaid).not.toHaveBeenCalled();
  });

  it("rejects an unsigned webhook before touching the order", async () => {
    mocks.verifyWebhookSignature.mockResolvedValueOnce(false);

    const response = await POST(request({ status: "paid" }));

    expect(response.status).toBe(401);
    expect(mocks.getByAccessCode).not.toHaveBeenCalled();
    expect(mocks.notifyCustomerOrderStatus).not.toHaveBeenCalled();
  });
});
