/**
 * Stage 5 — the owner's "Check status now" route.
 *
 * Same guards as the Retry button, and one more that matters: the engine's
 * recheck function takes an order id and never throws, so ownership has to be
 * proven before it runs or any signed-in account could read another shop's
 * delivery rows — full recipient numbers included.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/studio/orders/[id]/bundle-deliveries/recheck/route";
import { resetRateLimitForTests } from "@/lib/security";

const mocks = vi.hoisted(() => ({
  requireApiSessionUser: vi.fn(),
  recheckBundleDeliveriesForOrder: vi.fn(),
  getForOwner: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireApiSessionUser: mocks.requireApiSessionUser };
});

vi.mock("@/lib/studio/bundle-delivery", () => ({
  recheckBundleDeliveriesForOrder: mocks.recheckBundleDeliveriesForOrder,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => ({ getForOwner: mocks.getForOwner }),
}));

const csrf = "bundle-delivery-recheck-csrf-token-123";
const orderId = "11111111-2222-4333-8444-555555555555";
const processingDelivery = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  orderId,
  status: "processing",
  attempts: 1,
  providerRef: "DEV-A1B2C3D4",
};

function request(headers: Record<string, string> = {}) {
  return new NextRequest(
    `http://localhost/api/studio/orders/${orderId}/bundle-deliveries/recheck`,
    {
      method: "POST",
      headers: {
        cookie: `valmont_csrf=${csrf}`,
        "content-type": "application/json",
        "x-valmont-csrf": csrf,
        ...headers,
      },
      body: JSON.stringify({}),
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: orderId }) };
}

describe("bundle delivery recheck HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitForTests();
    mocks.requireApiSessionUser.mockResolvedValue({
      id: "user-1",
      login: "merchant",
      name: "Merchant",
    });
    mocks.getForOwner.mockResolvedValue({ id: orderId, draftId: "draft-1" });
    mocks.recheckBundleDeliveriesForOrder.mockResolvedValue([
      processingDelivery,
    ]);
  });

  it("rechecks the owner's own order and returns the fresh rows", async () => {
    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    // Ownership is proven with an owner-scoped read before the engine runs.
    expect(mocks.getForOwner).toHaveBeenCalledWith(expect.any(String), orderId);
    expect(mocks.recheckBundleDeliveriesForOrder).toHaveBeenCalledWith(orderId);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.deliveries).toEqual([processingDelivery]);
    expect(typeof body.checkedAt).toBe("string");
  });

  it("answers 404 for a cross-tenant order and never runs the engine", async () => {
    mocks.getForOwner.mockResolvedValueOnce(null);

    const response = await POST(request(), params());

    expect(response.status).toBe(404);
    expect(mocks.recheckBundleDeliveriesForOrder).not.toHaveBeenCalled();
  });

  it("refuses a request without the CSRF header", async () => {
    const response = await POST(
      new NextRequest(
        `http://localhost/api/studio/orders/${orderId}/bundle-deliveries/recheck`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      params(),
    );

    expect(response.status).toBe(403);
    expect(mocks.getForOwner).not.toHaveBeenCalled();
    expect(mocks.recheckBundleDeliveriesForOrder).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request", async () => {
    const response = await POST(
      request({ origin: "https://evil.example" }),
      params(),
    );

    expect(response.status).toBe(403);
    expect(mocks.recheckBundleDeliveriesForOrder).not.toHaveBeenCalled();
  });

  it("answers 401 when nobody is signed in", async () => {
    const { NotConnectedError } = await import("@/lib/api-errors");
    mocks.requireApiSessionUser.mockRejectedValueOnce(new NotConnectedError());

    const response = await POST(request(), params());

    expect(response.status).toBe(401);
    expect(mocks.recheckBundleDeliveriesForOrder).not.toHaveBeenCalled();
  });

  it("rate limits an owner who hammers the button", async () => {
    let limited = 0;
    // The route allows 40 rechecks a minute per owner.
    for (let index = 0; index < 50; index += 1) {
      const response = await POST(request(), params());
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
