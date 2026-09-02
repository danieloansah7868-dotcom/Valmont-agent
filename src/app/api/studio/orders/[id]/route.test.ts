import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/studio/orders/[id]/route";
import { resetRateLimitForTests } from "@/lib/security";
import { ConflictError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  getForOwner: vi.fn(),
  updateStatus: vi.fn(),
  requireApiSessionUser: vi.fn(),
  notifyCustomerOrderStatus: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireApiSessionUser: mocks.requireApiSessionUser };
});

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => ({
    getForOwner: mocks.getForOwner,
    updateStatus: mocks.updateStatus,
  }),
}));

vi.mock("@/lib/customer-order-notifications", () => ({
  notifyCustomerOrderStatus: mocks.notifyCustomerOrderStatus,
}));

const csrf = "studio-order-route-csrf-token-123456";
const orderId = "11111111-2222-4333-8444-555555555555";
const existing = {
  id: orderId,
  ownerId: "owner-1",
  status: "paid",
  customerEmail: "ama@example.com",
};
const updated = {
  ...existing,
  status: "preparing",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function request(status: string) {
  return new NextRequest(`http://localhost/api/studio/orders/${orderId}`, {
    method: "PATCH",
    headers: {
      cookie: `valmont_csrf=${csrf}`,
      "content-type": "application/json",
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify({ status }),
  });
}

function params() {
  return { params: Promise.resolve({ id: orderId }) };
}

describe("Studio order status HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitForTests();
    vi.unstubAllEnvs();
    vi.stubEnv("APP_URL", "https://shop.example");
    mocks.requireApiSessionUser.mockResolvedValue({
      id: "user-1",
      login: "merchant",
      name: "Merchant",
    });
    mocks.getForOwner.mockResolvedValue(existing);
    mocks.updateStatus.mockResolvedValue(updated);
    mocks.notifyCustomerOrderStatus.mockResolvedValue("sent");
  });

  it("notifies the customer after an owner-authorized status change", async () => {
    const response = await PATCH(request("preparing"), params());

    expect(response.status).toBe(200);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      orderId,
      "preparing",
    );
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith({
      order: updated,
      origin: "https://shop.example",
    });
  });

  it("builds customer links from APP_URL, never from the request host", async () => {
    const response = await PATCH(
      new NextRequest(`http://0.0.0.0:3000/api/studio/orders/${orderId}`, {
        method: "PATCH",
        headers: {
          cookie: `valmont_csrf=${csrf}`,
          "content-type": "application/json",
          "x-valmont-csrf": csrf,
          host: "attacker.example",
        },
        body: JSON.stringify({ status: "preparing" }),
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.notifyCustomerOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://shop.example" }),
    );
  });

  it("returns the store's typed 409 when the transition is not allowed", async () => {
    class OrderTransitionError extends ConflictError {}
    mocks.updateStatus.mockRejectedValueOnce(
      new OrderTransitionError("This order cannot move from paid to refunded."),
    );

    const response = await PATCH(request("refunded"), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This order cannot move from paid to refunded.",
    });
    expect(mocks.notifyCustomerOrderStatus).not.toHaveBeenCalled();
  });

  it("does not send a duplicate notification for a same-status retry", async () => {
    mocks.getForOwner.mockResolvedValueOnce({
      ...existing,
      status: "preparing",
    });
    mocks.updateStatus.mockResolvedValueOnce({
      ...updated,
      status: "preparing",
    });

    const response = await PATCH(request("preparing"), params());

    expect(response.status).toBe(200);
    expect(mocks.notifyCustomerOrderStatus).not.toHaveBeenCalled();
  });

  it("keeps a notification failure from failing the status update", async () => {
    mocks.notifyCustomerOrderStatus.mockRejectedValueOnce(
      new Error("provider down"),
    );

    const response = await PATCH(request("preparing"), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "preparing",
    });
  });

  it("does not update an order outside the merchant's owner scope", async () => {
    mocks.getForOwner.mockResolvedValueOnce(null);

    const response = await PATCH(request("preparing"), params());

    expect(response.status).toBe(404);
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.notifyCustomerOrderStatus).not.toHaveBeenCalled();
  });
});
