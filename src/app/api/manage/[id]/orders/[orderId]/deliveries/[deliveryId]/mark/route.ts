import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { NotFoundError, ShopPermissionError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { pinShopOrder } from "@/lib/shop-admin/order-access";
import { shopDeliveryView } from "@/lib/shop-admin/order-view";
import { can } from "@/lib/shop-admin/permissions";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import {
  markDeliveryDeliveredByShop,
  markDeliveryFailedByShop,
  SHOP_DELIVERY_MARK_RATE_LIMIT_OPERATION,
  SHOP_DELIVERY_MARK_RATE_LIMIT_PER_HOUR,
} from "@/lib/studio/manual-delivery";
import { getBundleDeliveriesStore } from "@/lib/studio/bundle-delivery";

/**
 * Stage 6c — mark one delivery row by hand (shop side).
 *
 * "Mark delivered" and "Mark failed" for the rows a human must finish: a
 * pending manual row (a Starter Shop's top-up, sent by hand), and — for
 * "Mark delivered" only — a failed row of any provider the shop has settled
 * out of band. The transition guards live inside the atomic UPDATE in
 * `manual-delivery.ts` (the `claimForDispatch` pattern), so a double-click or
 * two people acting at once moves the row exactly once; the loser gets the
 * matching plain-language 409. No merchant alert fires — the shop did this
 * itself. `orders.fulfil` required; the owner always has it.
 */

const BODY_LIMIT_BYTES = 16_000;

const markSchema = z.object({
  status: z.enum(["delivered", "failed"]),
  note: z.string().trim().max(200).optional(),
});

export async function POST(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      id: string;
      orderId: string;
      deliveryId: string;
    }>;
  },
) {
  try {
    assertCsrf(request);
    const { id, orderId, deliveryId } = await params;
    const session = await requireShopAdminApi(request, id);
    if (!can(session.admin, "orders.fulfil")) throw new ShopPermissionError();
    assertHourlyRateLimit(
      SHOP_DELIVERY_MARK_RATE_LIMIT_OPERATION,
      id,
      SHOP_DELIVERY_MARK_RATE_LIMIT_PER_HOUR,
    );
    const parsed = markSchema.parse(
      await readBoundedJson(request, BODY_LIMIT_BYTES),
    );

    // Pin the order to THIS website before anything is read or written: the
    // order of a sibling website with the same agency owner is a 404 here.
    const order = await pinShopOrder(id, orderId);

    // The row must belong to that order — a delivery id guessed (or read on
    // another shop's page) is worth nothing here.
    const row = await getBundleDeliveriesStore().getById(deliveryId);
    if (!row || row.orderId !== order.id) throw new NotFoundError();

    const updated =
      parsed.status === "delivered"
        ? await markDeliveryDeliveredByShop(deliveryId)
        : await markDeliveryFailedByShop(deliveryId, parsed.note ?? "");
    // Never the raw record: the projection drops the agency owner id.
    return NextResponse.json({ delivery: shopDeliveryView(updated) });
  } catch (error) {
    return safeApiError(error);
  }
}
