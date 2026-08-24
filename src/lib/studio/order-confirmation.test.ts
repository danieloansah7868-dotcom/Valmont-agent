import { describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { orderConfirmationDestination } from "./order-confirmation";

const merchant: SessionUser = {
  id: "123",
  login: "merchant",
  name: "Merchant",
};

const order = {
  ownerId: canonicalUserId(merchant),
  draftId: "my shop/draft",
};

describe("orderConfirmationDestination", () => {
  it("sends the signed-in merchant who owns the order straight to Studio", () => {
    expect(orderConfirmationDestination(order, merchant)).toEqual({
      href: "/studio",
      label: "Go to Studio",
      isOwner: true,
    });
  });

  it("sends a customer back to the order's shop", () => {
    expect(orderConfirmationDestination(order, null)).toEqual({
      href: "/s/my%20shop%2Fdraft",
      label: "Back to shop",
      isOwner: false,
    });
  });

  it("does not treat a different signed-in user as the order owner", () => {
    const customer: SessionUser = {
      id: "456",
      login: "customer",
      name: "Customer",
    };

    expect(orderConfirmationDestination(order, customer)).toMatchObject({
      href: "/s/my%20shop%2Fdraft",
      label: "Back to shop",
      isOwner: false,
    });
  });
});
