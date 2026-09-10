import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { shopOrderLineLabel } from "@/lib/shop-admin/order-view";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { planAllows, planOf } from "@/lib/studio/plans";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

/**
 * What one ledger row is called. Credits and deductions keep their 7a
 * wording; Stage 7b's order-bound rows name the order and link to it.
 */
function entryLabel(kind: string, amount: number): string {
  if (kind === "purchase") return "Purchase";
  if (kind === "refund") return "Refund";
  return amount >= 0 ? "Credit added" : "Credit removed";
}

export default async function ShopAgentStatementPage({
  params,
}: {
  params: Promise<{ id: string; agentId: string }>;
}) {
  const { id, agentId } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(
    id,
    `${base}/agents/${encodeURIComponent(agentId)}`,
  );
  if (session.admin.role !== "owner") notFound();
  const draft = await publicGetDraft(id);
  if (!draft || draft.brief.category !== "data-bundles") notFound();
  if (!planAllows(planOf(draft.brief), "wallets")) notFound();
  const store = getShopAgentStore();
  const agent = await store.getById(agentId);
  if (!agent || agent.draftId !== id) notFound();
  const entries = await store.listEntries(agentId, 100);
  const admins = await getShopAdminStore().listForDraft(id);
  const adminNames = new Map(admins.map((admin) => [admin.id, admin.name]));
  // Stage 7b — the agent's own orders, shown to the owner under the
  // statement; owner-scoped AND pinned to this website like every order
  // read on this side.
  const agentOrders = await getOrdersStore().listForOwner(draft.ownerId, {
    draftId: id,
    agentId,
    limit: 50,
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Link
        href={`${base}/agents`}
        className="text-sm font-semibold text-copper-700 hover:underline"
      >
        ← Agents
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">
            {agent.name}&apos;s statement
          </h1>
          <p className="mt-1 text-sm text-slate">{agent.email}</p>
        </div>
        <p className="text-lg font-bold text-navy">
          {formatMoney(agent.balance)}
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-slate">No wallet changes yet.</p>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border border-line bg-white">
          <div className="hidden grid-cols-5 gap-3 border-b border-line bg-ivory-50 px-4 py-3 text-xs font-semibold text-slate sm:grid">
            <span>When</span>
            <span>Change</span>
            <span>Balance after</span>
            <span>Note</span>
            <span>Done by</span>
          </div>
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0 sm:grid-cols-5 sm:gap-3"
                data-testid="shop-agent-entry-row"
              >
                <span className="text-xs text-slate">
                  {formatAccra(entry.createdAt)}
                </span>
                <span
                  className={
                    entry.amount >= 0
                      ? "font-semibold text-emerald-700"
                      : "font-semibold text-red-700"
                  }
                >
                  {entryLabel(entry.kind, entry.amount)}{" "}
                  {formatMoney(entry.amount)}
                </span>
                <span>{formatMoney(entry.balanceAfter)}</span>
                <span className="text-slate">
                  {entry.orderId &&
                  (entry.kind === "purchase" || entry.kind === "refund") ? (
                    <Link
                      href={`${base}/orders/${encodeURIComponent(entry.orderId)}`}
                      className="font-semibold text-copper-700 hover:underline"
                      data-testid="shop-agent-entry-order-link"
                    >
                      {entry.kind === "purchase" ? "Purchase" : "Refund"} -
                      Order {entry.orderId.slice(0, 8)}
                    </Link>
                  ) : (
                    entry.note || "—"
                  )}
                </span>
                <span>
                  {adminNames.get(entry.createdBy) || entry.createdBy}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-bold text-navy">Orders</h2>
        <p className="mt-1 text-sm text-slate">
          Bundles {agent.name} bought from the wallet, newest first.
        </p>
        {agentOrders.length === 0 ? (
          <p
            className="mt-4 rounded-xl border border-line bg-white p-4 text-sm text-slate"
            data-testid="shop-agent-orders-empty"
          >
            No orders from this agent yet.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2">
            {agentOrders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`${base}/orders/${encodeURIComponent(order.id)}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white p-3 hover:border-copper"
                  data-testid="shop-agent-order-row"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-navy">
                      {order.lines.map(shopOrderLineLabel).join(", ")}
                    </p>
                    <p className="text-xs text-slate-600">
                      {formatAccra(order.createdAt)}
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
                    <span className="text-sm font-semibold">
                      {formatMoney(order.total, order.currency)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
