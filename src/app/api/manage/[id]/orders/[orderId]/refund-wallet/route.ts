import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import {
  AgentOrderNotRefundableError,
  NotFoundError,
  ShopOwnerOnlyError,
  WalletAlreadyRefundedError,
} from "@/lib/api-errors";
import { assertCsrf } from "@/lib/security";
import { requireShopAdminApi } from "@/lib/shop-admin/auth";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { assertShopAgentsAllowed } from "@/lib/shop-agent/gate";
import { AGENT_WALLET_PAYMENT_METHOD } from "@/lib/shop-agent/orders";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { canTransition } from "@/lib/studio/order-status";
import { getOrdersStore, OrderTransitionError } from "@/lib/studio/orders";

/**
 * POST /api/manage/[id]/orders/[orderId]/refund-wallet — the owner's
 * "Refund to wallet" button (Stage 7b, R8).
 *
 * Owner only: a member with every permission box ticked still gets 403 —
 * money movement never hides behind a team permission. The order must be a
 * wallet-paid agent order with its purchase entry (anything else is a
 * plain 409), the status must legally move to "refunded", and the wallet is
 * credited exactly once per order. The credit (with its `refund` ledger
 * entry) and the status move go through the one ledger method and
 * updateStatus respectively — nothing here writes balances by hand.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    assertCsrf(request);
    const { id, orderId } = await params;
    const session = await requireShopAdminApi(request, id);
    // Every member, whatever their boxes: only the shop owner moves money.
    if (session.admin.role !== "owner") throw new ShopOwnerOnlyError();
    const draft = await publicGetDraft(id);
    if (!draft) throw new NotFoundError();
    assertShopAgentsAllowed(draft.brief);
    assertHourlyRateLimit("agent-refund", session.admin.id, 30);

    // Pinned to THIS website: an order of a sibling website owned by the
    // same agency user is the same 404 an unknown id gets.
    const order = await getOrdersStore().getById(orderId);
    if (!order || order.draftId !== id) throw new NotFoundError();

    // Only wallet-paid agent orders carry something refundable. A public
    // MoMo/Valmont Pay order can never grow a wallet refund here.
    const store = getShopAgentStore();
    const purchase =
      order.paymentMethod === AGENT_WALLET_PAYMENT_METHOD && order.agentId
        ? await store.getEntryForOrder(order.id, "purchase")
        : null;
    if (!order.agentId || !purchase) throw new AgentOrderNotRefundableError();
    if (!canTransition(order.status, "refunded")) {
      throw new OrderTransitionError(order.status, "refunded");
    }

    // Step A — credit the wallet back. The ledger itself enforces
    // once-per-order (kind refund, order_id set, partial unique index); a
    // replay throws WalletAlreadyRefundedError and falls THROUGH to Step B,
    // which is precisely how a refund whose status move once crashed gets
    // completed instead of double-credited.
    let entry;
    try {
      entry = await store.refund({
        agentId: order.agentId,
        orderId: order.id,
        amountMinor: Math.round(Math.abs(purchase.amount) * 100),
        createdBy: session.admin.id,
        note: `Refund order ${order.id.slice(0, 8)}`,
      });
    } catch (error) {
      if (!(error instanceof WalletAlreadyRefundedError)) throw error;
      entry = await store.getEntryForOrder(order.id, "refund");
    }

    // Step B — the status moves through updateStatus like every other
    // transition (timestamp + history), never by hand.
    const refunded = await getOrdersStore().updateStatus(
      order.ownerId,
      order.id,
      "refunded",
    );

    // The shop's view: the order minus the agency owner id, and the ledger
    // entry the owner just caused (or the one that already existed).
    const { ownerId: _ownerId, ...orderView } = refunded ?? order;
    void _ownerId;
    return NextResponse.json({ order: orderView, entry });
  } catch (error) {
    return safeApiError(error);
  }
}
