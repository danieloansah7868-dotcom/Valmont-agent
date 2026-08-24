import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import {
  ORDER_FILTERS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type OrderFilterId,
} from "@/lib/studio/order-status";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

/**
 * The optional shop-order tool for online-shop websites.
 *
 * Phase 5 item 3 moved the Studio dashboard to a client-project view, so this
 * page went back to being what it always was: one owner-scoped order list with
 * status filters. The combined "orders across your businesses" dashboard added
 * by the earlier item-3 attempt is gone — orders are not part of the website
 * dashboard.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const user = await requireSessionUser();
  const { filter: rawFilter } = await searchParams;
  const filter = ORDER_FILTERS.some((entry) => entry.id === rawFilter)
    ? (rawFilter as OrderFilterId)
    : "all";

  const store = getOrdersStore();
  const all = await store.listForOwner(canonicalUserId(user), {
    limit: 200,
    filter: "all",
  });
  const orders = await store.listForOwner(canonicalUserId(user), {
    limit: 200,
    filter,
  });

  const counts = Object.fromEntries(
    ORDER_FILTERS.map((entry) => [
      entry.id,
      entry.id === "all"
        ? all.length
        : all.filter((order) => entry.statuses.includes(order.status)).length,
    ]),
  ) as Record<OrderFilterId, number>;

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Shop orders</h1>
          <p className="mt-1 text-sm text-slate">
            Orders from your online-shop websites. Open an order to see the
            customer details and move it along.
          </p>
        </div>
        <Link href="/studio" className="btn-quiet">
          Back to Studio
        </Link>
      </div>

      <div
        className="mt-5 flex flex-wrap gap-2"
        role="tablist"
        aria-label="Filter orders"
      >
        {ORDER_FILTERS.map((entry) => {
          const active = entry.id === filter;
          return (
            <Link
              key={entry.id}
              href={
                entry.id === "all"
                  ? "/studio/orders"
                  : `/studio/orders?filter=${entry.id}`
              }
              role="tab"
              aria-selected={active}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
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
        <p className="mt-6 text-sm text-slate-600">
          No orders in this list yet.
        </p>
      ) : (
        <ul className="mt-5 grid gap-2" data-testid="orders-list">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/studio/orders/${order.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white p-3 hover:border-copper"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-navy">
                    {order.customerName} · {order.id.slice(0, 8)}
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
    </div>
  );
}
