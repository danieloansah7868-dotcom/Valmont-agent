import { NotFoundError } from "@/lib/api-errors";
import { publicGetDraftOwnerId } from "@/lib/studio/draft-public";
import { getOrdersStore, type OrderRecord } from "@/lib/studio/orders";

/**
 * Stage 6c — pins an order to a shop-admin website.
 *
 * Every shop route that touches an order resolves it the same way Stage 6b's
 * read pages do: the website's agency owner id first, then an owner-scoped
 * order read, then `order.draftId === draftId`. An order that belongs to a
 * sibling website of the same agency user is therefore a 404, the same as an
 * order that does not exist.
 *
 * The pin MUST happen before any engine call: `retryBundleDeliveryFailures`
 * and `recheckBundleDeliveriesForOrder` are owner-scoped or order-scoped, not
 * shop-scoped, so without this check a shop admin of one website could move
 * another website's rows.
 */
export async function pinShopOrder(
  draftId: string,
  orderId: string,
): Promise<OrderRecord> {
  const ownerId = await publicGetDraftOwnerId(draftId);
  if (!ownerId) throw new NotFoundError();
  const order = await getOrdersStore().getForOwner(ownerId, orderId);
  if (!order || order.draftId !== draftId) throw new NotFoundError();
  return order;
}
