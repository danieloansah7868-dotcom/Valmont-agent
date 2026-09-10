import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShopAgentSession } from "@/lib/shop-agent/auth";
import { settleAgentOrder } from "@/lib/shop-agent/orders";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import {
  deliveryStatusLabel,
  recheckBundleDeliveriesForOrder,
} from "@/lib/studio/bundle-delivery";
import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";
import { getOrdersStore } from "@/lib/studio/orders";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { shopOrderLineLabel } from "@/lib/shop-admin/order-view";

export const dynamic = "force-dynamic";

const DELIVERY_BADGE_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  processing: "bg-blue-100 text-blue-900",
  delivered: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

/**
 * Stage 7b — one agent order. Scoped by agent_id in the store, so another
 * agent's order id is a plain 404 (R9). The page first settles (a crash
 * between the wallet debit and markPaid self-heals here) and then rechecks
 * the deliveries the way the guest confirmation page does — the engine's own
 * throttle protects the shop's TechChief budget. It is strictly read-only:
 * no Retry, Mark or Recheck buttons — those stay on the owner's side.
 */
export default async function AgentOrderPage({
  params,
}: {
  params: Promise<{ id: string; orderId: string }>;
}) {
  const { id, orderId } = await params;
  const session = await requireShopAgentSession(
    id,
    `/a/${encodeURIComponent(id)}/orders/${encodeURIComponent(orderId)}`,
  );
  const found = await getOrdersStore().getForAgent(session.agent.id, orderId);
  if (!found) notFound();
  const order = await settleAgentOrder(found);

  const store = getShopAgentStore();
  const purchaseEntry = await store.getEntryForOrder(order.id, "purchase");
  const refundEntry = await store.getEntryForOrder(order.id, "refund");
  const deliveries = order.recipientPhone
    ? await recheckBundleDeliveriesForOrder(order.id)
    : [];

  const home = `/a/${encodeURIComponent(id)}`;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-6 sm:px-6">
      <Link href={`${home}/orders`} className="text-sm font-semibold underline">
        All your orders
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">
            Order {order.id.slice(0, 8)}
          </h1>
          <p className="mt-1 text-sm text-slate">
            Placed {formatAccra(order.createdAt)}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${
            STATUS_BADGE_CLASS[order.status] ?? "bg-slate-200 text-slate-700"
          }`}
          data-testid="agent-order-status"
        >
          {STATUS_LABELS[order.status]}
        </span>
      </div>

      {order.status === "refunded" && (
        <p
          className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
          data-testid="agent-order-refunded"
        >
          Refunded to your wallet on{" "}
          {formatAccra(
            refundEntry?.createdAt ?? order.refundedAt ?? order.updatedAt,
          )}
          .
        </p>
      )}

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Bundles</h2>
        <ul className="mt-3 grid gap-2">
          {order.lines.map((line) => (
            <li
              key={line.itemId}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1">{shopOrderLineLabel(line)}</span>
              <span className="font-semibold">
                {formatMoney(line.price * line.quantity, order.currency)}
              </span>
            </li>
          ))}
          <li className="flex justify-between border-t border-line pt-2 text-base font-bold">
            <span>You paid</span>
            <span data-testid="agent-order-total">
              {formatMoney(order.total, order.currency)}
            </span>
          </li>
        </ul>
        <dl className="mt-3 grid gap-1 border-t border-line pt-3 text-sm">
          {order.recipientPhone && (
            <div>
              <dt className="inline font-semibold">Sent to: </dt>
              <dd className="inline" data-testid="agent-order-recipient">
                {order.recipientPhone}
              </dd>
            </div>
          )}
          {purchaseEntry && (
            <div>
              <dt className="inline font-semibold">Wallet balance after: </dt>
              <dd className="inline" data-testid="agent-order-balance-after">
                {formatMoney(purchaseEntry.balanceAfter)}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {deliveries.length > 0 && (
        <section className="mt-4 rounded-xl border border-line bg-white p-4">
          <h2 className="text-sm font-semibold text-navy">Delivery</h2>
          <ul className="mt-3 grid gap-2">
            {deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm"
                data-testid="agent-delivery-row"
              >
                <span className="font-semibold">
                  {bundleNetworkLabel(delivery.network)}{" "}
                  {formatDataMb(delivery.dataMb)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    DELIVERY_BADGE_CLASS[delivery.status] ??
                    "bg-slate-200 text-slate-700"
                  }`}
                  data-testid={`agent-delivery-${delivery.status}`}
                >
                  {deliveryStatusLabel(delivery)}
                </span>
              </li>
            ))}
          </ul>
          {deliveries.some((delivery) => delivery.status === "failed") && (
            <p className="mt-3 text-xs text-slate">
              A top-up hit a problem — the shop can retry it or refund the order
              to your wallet.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
