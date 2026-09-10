/**
 * Stage 7b — idempotent settlement for agent wallet orders.
 *
 * An agent buy has a small crash window: the wallet is debited (`purchase`,
 * which writes its ledger entry and the new balance in one transaction) and
 * the order is then marked paid. A process dying between the two would leave
 * money taken from a wallet with an order stuck at "pending" forever — the
 * fail-closed payments webhook knows nothing about it, because no payment
 * link was ever created (R7).
 *
 * {@link settleAgentOrder} closes that window from three directions — the buy
 * route itself (right after the debit), the agent's order page, and the
 * owner's order page: when an order is wallet-paid, still unsettled
 * (`pending` or `payment_failed`), AND has its purchase entry, the wallet
 * demonstrably paid for it, so the order moves to paid through the ONLY
 * channel allowed to do that (OrdersStore.markPaid → paidAt is set, R4) and
 * the normal delivery engine runs. Everything else is a no-op: public orders,
 * orders without a purchase entry (a refused buy — nothing was charged),
 * orders already paid, cancelled or refunded. It is safe to call on every
 * page load: markPaid is a pending/payment_failed → paid transition only and
 * the delivery engine is idempotent (invariant I2).
 */
import { dispatchBundleDeliveriesForOrder } from "@/lib/studio/bundle-delivery";
import { getOrdersStore, type OrderRecord } from "@/lib/studio/orders";
import { getShopAgentStore } from "./store";

export const AGENT_WALLET_PAYMENT_METHOD = "agent_wallet" as const;

export async function settleAgentOrder(
  order: OrderRecord,
): Promise<OrderRecord> {
  if (order.paymentMethod !== AGENT_WALLET_PAYMENT_METHOD) return order;
  if (order.status !== "pending" && order.status !== "payment_failed") {
    return order;
  }
  if (!order.agentId) return order;
  const entry = await getShopAgentStore().getEntryForOrder(
    order.id,
    "purchase",
  );
  if (!entry) return order;
  const paid = await getOrdersStore().markPaid(
    order.accessCode,
    `wallet:${entry.id}`,
  );
  if (!paid || paid.status !== "paid") return paid ?? order;
  try {
    // Awaited on purpose — the caller (buy route or page) should see the
    // real delivery state; a delivery problem is recorded on the rows and
    // must never unsettle a paid order (invariant I4).
    await dispatchBundleDeliveriesForOrder(paid.id);
  } catch {
    /* the owner has Retry and Refund to wallet; never fail the page */
  }
  return paid;
}
