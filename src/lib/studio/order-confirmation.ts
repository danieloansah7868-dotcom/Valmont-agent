import type { SessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";

/**
 * Returns the appropriate next step after viewing an order confirmation.
 * Merchants return directly to their Studio; customers return to the shop
 * that received their order.
 */
export function orderConfirmationDestination(
  order: { ownerId: string; draftId: string },
  viewer: SessionUser | null,
): { href: string; label: "Go to Studio" | "Back to shop"; isOwner: boolean } {
  const isOwner = viewer !== null && canonicalUserId(viewer) === order.ownerId;

  if (isOwner) {
    return { href: "/studio", label: "Go to Studio", isOwner };
  }

  return {
    href: `/s/${encodeURIComponent(order.draftId)}`,
    label: "Back to shop",
    isOwner,
  };
}
