import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/studio/orders/[id]/bundle-deliveries/retry/route";
import { resetRateLimitForTests } from "@/lib/security";

const mocks = vi.hoisted(() => ({
  requireApiSessionUser: vi.fn(),
  retryBundleDeliveryFailures: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireApiSessionUser: mocks.requireApiSessionUser };
});

vi.mock("@/lib/studio/bundle-delivery", () => ({
  retryBundleDeliveryFailures: mocks.retryBundleDeliveryFailures,
}));

const csrf = "bundle-delivery-retry-csrf-token-12345";
const orderId = "11111111-2222-4333-8444-555555555555";
const failedDelivery = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  orderId,
  status: "failed",
  attempts: 1,
};

function request() {
  return new NextRequest(
    `http://localhost/api/studio/orders/${orderId}/bundle-deliveries/retry`,
    {
      method: "POST",
      headers: {
        cookie: `valmont_csrf=${csrf}`,
        "content-type": "application/json",
        "x-valmont-csrf": csrf,
      },
      body: JSON.stringify({}),
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: orderId }) };
}

describe("bundle delivery retry HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitForTests();
    mocks.requireApiSessionUser.mockResolvedValue({
      id: "user-1",
      login: "merchant",
      name: "Merchant",
    });
    mocks.retryBundleDeliveryFailures.mockResolvedValue({
      order: { id: orderId },
      deliveries: [failedDelivery],
    });
  });

  it("retries failed top-ups for the session owner and returns the fresh rows", async () => {
    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(mocks.retryBundleDeliveryFailures).toHaveBeenCalledWith(
      expect.any(String),
      orderId,
    );
    await expect(response.json()).resolves.toEqual({
      deliveries: [failedDelivery],
    });
  });

  it("answers 404 for an unknown or cross-tenant order before revealing deliveries", async () => {
    mocks.retryBundleDeliveryFailures.mockResolvedValueOnce(null);

    const response = await POST(request(), params());

    expect(response.status).toBe(404);
  });

  it("surfaces the engine's typed 409 when the order is not paid", async () => {
    const { ConflictError } = await import("@/lib/api-errors");
    mocks.retryBundleDeliveryFailures.mockRejectedValueOnce(
      new ConflictError(
        'Bundle top-ups can only be retried on a paid order; this order is "pending".',
      ),
    );

    const response = await POST(request(), params());

    expect(response.status).toBe(409);
  });

  it("refuses requests without the CSRF header", async () => {
    const response = await POST(
      new NextRequest(
        `http://localhost/api/studio/orders/${orderId}/bundle-deliveries/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      params(),
    );

    expect(response.status).toBe(403);
    expect(mocks.retryBundleDeliveryFailures).not.toHaveBeenCalled();
  });
});
