import Link from "next/link";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { publicGetDraftOwnerId } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import {
  ORDER_FILTERS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type OrderFilterId,
} from "@/lib/studio/order-status";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";
import { shopOrderLineLabel } from "@/lib/shop-admin/order-view";
import { PaymentModeBadge } from "@/components/studio/payment-mode-badge";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

/**
 * The shop's orders, newest first, for whoever is signed in to *this* shop
 * (Stage 6b). Read only: Stage 6c adds the delivery actions.
 *
 * Every read goes through the owner-scoped orders store *and* is pinned to
 * this website's id, so a shop can never see a sibling website that the same
 * agency user happens to own.
 */
export default async function ShopOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { id } = await params;
  const { filter: rawFilter } = await searchParams;
  const base = `/manage/${encodeURIComponent(id)}`;
  await requireShopAdminSession(id, base);

  const filter = ORDER_FILTERS.some((entry) => entry.id === rawFilter)
    ? (rawFilter as OrderFilterId)
    : "all";
  const ownerId = await publicGetDraftOwnerId(id);
  const store = getOrdersStore();
  const all = ownerId
    ? await store.listForOwner(ownerId, {
        limit: PAGE_SIZE,
        filter: "all",
        draftId: id,
      })
    : [];
  const orders =
    filter === "all"
      ? all
      : ownerId
        ? await store.listForOwner(ownerId, {
            limit: PAGE_SIZE,
            filter,
            draftId: id,
          })
        : [];

  const counts = Object.fromEntries(
    ORDER_FILTERS.map((entry) => [
      entry.id,
      entry.id === "all"
        ? all.length
        : all.filter((order) => entry.statuses.includes(order.status)).length,
    ]),
  ) as Record<OrderFilterId, number>;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Orders</h1>
          <p className="mt-1 text-sm text-slate">
            Newest first. Open an order to see who to send the bundle to.
          </p>
        </div>
      </div>

      <div
        className="mt-5 flex gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Filter orders"
      >
        {ORDER_FILTERS.map((entry) => {
          const active = entry.id === filter;
          return (
            <Link
              key={entry.id}
              href={entry.id === "all" ? base : `${base}?filter=${entry.id}`}
              role="tab"
              aria-selected={active}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                active
                  ? "bg-navy text-ivory"
                  : "bg-ivory-100 text-navy hover:bg-ivory-200"
              }`}
            >
              {entry.label}
              <span className="ml-1.5 text-xs opacity-80">
                {counts[entry.id] ?? 0}
              </span>
            </Link>
          );
        })}
      </div>

      {orders.length === 0 ? (
        <p
          className="mt-6 text-sm text-slate-600"
          data-testid="shop-orders-empty"
        >
          No orders in this list yet.
        </p>
      ) : (
        <ul className="mt-5 grid gap-2" data-testid="shop-orders-list">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`${base}/orders/${encodeURIComponent(order.id)}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white p-3 hover:border-copper"
                data-testid="shop-order-row"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-navy">
                    {order.customerName}
                    <span className="font-normal text-slate-500">
                      {" "}
                      · {order.id.slice(0, 8)}
                    </span>
                  </p>
                  <p className="text-xs text-slate-600">
                    {formatAccra(order.createdAt)}
                    {order.recipientPhone ? ` · ${order.recipientPhone}` : ""}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-slate-600">
                    {order.lines.map(shopOrderLineLabel).join(", ")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <PaymentModeBadge mode={order.paymentMode} />
                  {order.paymentMethod === "agent_wallet" && (
                    <span
                      className="rounded-full border border-copper-300 bg-copper-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-copper-700 uppercase"
                      title="Bought by an agent, paid from the agent's wallet"
                      data-testid="shop-order-agent-badge"
                    >
                      Agent
                    </span>
                  )}
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
    </div>
  );
}
