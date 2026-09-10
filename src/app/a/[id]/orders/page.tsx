import Link from "next/link";
import { requireShopAgentSession } from "@/lib/shop-agent/auth";
import { getOrdersStore } from "@/lib/studio/orders";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { shopOrderLineLabel } from "@/lib/shop-admin/order-view";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

/**
 * Stage 7b — the agent's own orders, newest first. Scoped by agent_id in
 * the store itself (R9): nothing here can list another agent's orders.
 */
export default async function AgentOrdersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireShopAgentSession(
    id,
    `/a/${encodeURIComponent(id)}/orders`,
  );
  const orders = await getOrdersStore().listForAgent(session.agent.id, 50);
  const home = `/a/${encodeURIComponent(id)}`;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">Your orders</h1>
      <p className="mt-1 text-sm text-slate">
        Every bundle you bought from your wallet, newest first.
      </p>
      {orders.length === 0 ? (
        <p
          className="mt-6 rounded-xl border border-line bg-white p-4 text-sm text-slate"
          data-testid="agent-orders-empty"
        >
          No orders yet. Open a bundle on the home page and press Order now.
        </p>
      ) : (
        <ul className="mt-5 grid gap-2">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`${home}/orders/${encodeURIComponent(order.id)}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white p-3 hover:border-copper"
                data-testid="agent-order-row"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-navy">
                    {order.lines.map(shopOrderLineLabel).join(", ")}
                  </p>
                  <p className="text-xs text-slate-600">
                    {formatAccra(order.createdAt)}
                    {order.recipientPhone ? ` · ${order.recipientPhone}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      STATUS_BADGE_CLASS[order.status] ??
                      "bg-slate-200 text-slate-700"
                    }`}
                  >
                    {STATUS_LABELS[order.status]}
                  </span>
                  <span className="text-sm font-semibold text-navy">
                    {formatMoney(order.total, order.currency)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
