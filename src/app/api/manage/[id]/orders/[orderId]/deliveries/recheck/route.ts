import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { ShopPermissionError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { pinShopOrder } from "@/lib/shop-admin/order-access";
import { shopDeliveryView } from "@/lib/shop-admin/order-view";
import { can } from "@/lib/shop-admin/permissions";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { recheckBundleDeliveriesForOrder } from "@/lib/studio/bundle-delivery";
import {
  SHOP_ORDER_DELIVERY_RATE_LIMIT_OPERATION,
  SHOP_ORDER_DELIVERY_RATE_LIMIT_PER_HOUR,
} from "@/lib/studio/manual-delivery";

/**
 * Stage 6c — the shop's "Check status now".
 *
 * Runs the same reconciliation pass the Studio owner's button runs
 * (`recheckBundleDeliveriesForOrder`), on the shop's explicit request. It
 * exists because a real provider's answer costs a slice of the website's
 * TechChief allowance — which is why the shop order PAGE never runs it on
 * load (a member refreshing must not spend the allowance) and why this route
 * shares its hourly bucket with Retry. The order is pinned to this website
 * before the engine runs. The body is read and ignored — the client always
 * sends an empty JSON object.
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

    const deliveries = await recheckBundleDeliveriesForOrder(order.id);
    return NextResponse.json({
      // The projection drops the agency owner id from every row.
      deliveries: deliveries.map(shopDeliveryView),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
