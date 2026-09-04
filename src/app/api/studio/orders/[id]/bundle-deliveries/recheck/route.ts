import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { assertCsrf } from "@/lib/security";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { canonicalUserId } from "@/lib/user-identity";
import { recheckBundleDeliveriesForOrder } from "@/lib/studio/bundle-delivery";
import { getOrdersStore } from "@/lib/studio/orders";

/**
 * Owner-only "Check status now" (Stage 5).
 *
 * Runs the same reconciliation pass the order page runs on load — create any
 * missing rows, flush anything stuck at "pending", ask the provider about
 * anything "processing" — but on the owner's explicit request. It exists
 * because a real provider's answer costs a slice of the shop's 60/hour
 * TechChief allowance: the owner decides when that is worth spending, while
 * the throttle inside the provider (one poll per row per 10 minutes) makes a
 * double-click or an impatient refresh cost nothing.
 *
 * Ownership is proven with an owner-scoped order read BEFORE the engine runs,
 * because `recheckBundleDeliveriesForOrder` itself takes only an order id and
 * never throws — without this check any signed-in account could read another
 * shop's delivery rows, full recipient numbers included. A cross-tenant or
 * made-up id is the same 404 the retry button returns, and the rate limit is
 * the retry button's too.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const user = await requireApiSessionUser();
    const ownerId = canonicalUserId(user);
    assertOwnerRateLimit("studio-order-delivery", ownerId, 40);
    const { id } = await params;

    const order = await getOrdersStore().getForOwner(ownerId, id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const deliveries = await recheckBundleDeliveriesForOrder(order.id);
    return NextResponse.json({
      deliveries,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
