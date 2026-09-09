import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import {
  ConflictError,
  NotFoundError,
  ShopPermissionError,
} from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { pinShopOrder } from "@/lib/shop-admin/order-access";
import { shopDeliveryView } from "@/lib/shop-admin/order-view";
import { can } from "@/lib/shop-admin/permissions";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import {
  bundleDeliveryAvailabilityForDraft,
  retryBundleDeliveryFailures,
} from "@/lib/studio/bundle-delivery";
import {
  SHOP_ORDER_DELIVERY_RATE_LIMIT_OPERATION,
  SHOP_ORDER_DELIVERY_RATE_LIMIT_PER_HOUR,
  SHOP_RETRY_MANUAL_MESSAGE,
} from "@/lib/studio/manual-delivery";

/**
 * Stage 6c — the shop's Retry for failed top-ups.
 *
 * Same library function the Studio owner's Retry uses (`retryBundleDeliveryFailures`),
 * re-dispatching only the rows at "failed". The order is pinned to this
 * website first, because the engine is owner-scoped, not shop-scoped.
 *
 * A Starter Shop is refused before the engine is ever asked: its rows wait
 * for hands, not providers, so retrying would only fabricate failures. The
 * shared hourly bucket with "Check status" (40 per website) keeps a group of
 * staff from spending the shop's TechChief allowance by reflex. The body is
 * read and ignored — the client always sends an empty JSON object.
 */

const BODY_LIMIT_BYTES = 16_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    assertCsrf(request);
    const { id, orderId } = await params;
    const session = await requireShopAdminApi(request, id);
    if (!can(session.admin, "orders.fulfil")) throw new ShopPermissionError();
    assertHourlyRateLimit(
      SHOP_ORDER_DELIVERY_RATE_LIMIT_OPERATION,
      id,
      SHOP_ORDER_DELIVERY_RATE_LIMIT_PER_HOUR,
    );
    await readBoundedJson(request, BODY_LIMIT_BYTES);

    // Pin before any engine call: a sibling website's order is a 404 here.
    const order = await pinShopOrder(id, orderId);

    // A Starter Shop never retries: manual rows are marked, not sent.
    const availability = await bundleDeliveryAvailabilityForDraft(id);
    if (availability.manual) {
      throw new ConflictError(SHOP_RETRY_MANUAL_MESSAGE);
    }

    const result = await retryBundleDeliveryFailures(order.ownerId, order.id);
    if (!result) throw new NotFoundError();
    // The projection drops the agency owner id from every row.
    return NextResponse.json({
      deliveries: result.deliveries.map(shopDeliveryView),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
