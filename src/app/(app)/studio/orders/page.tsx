import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { BusinessSwitcher } from "@/components/studio/business-switcher";
import {
  ORDER_FILTERS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type OrderFilterId,
} from "@/lib/studio/order-status";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; business?: string }>;
}) {
  const user = await requireSessionUser();
  const { filter: rawFilter, business: requestedBusinessId } =
    await searchParams;
  const filter = ORDER_FILTERS.some((entry) => entry.id === rawFilter)
    ? (rawFilter as OrderFilterId)
    : "all";

  // The draft store is owner-scoped. Only ids returned here are accepted as a
  // business filter, so a guessed id can never select somebody else's data.
  const drafts = await getStudioDraftStore().list(user);
  const businesses = drafts.map((draft) => ({
    id: draft.id,
    name: draft.brief.businessName,
  }));
  const selectedBusiness = businesses.find(
    (business) => business.id === requestedBusinessId,
  );
  const businessNames = new Map(
    businesses.map((business) => [business.id, business.name]),
  );
  const ownerId = canonicalUserId(user);
  const store = getOrdersStore();
  const businessFilter = selectedBusiness
    ? { draftId: selectedBusiness.id }
    : {};
  const allOrders = await store.listForOwner(ownerId, {
    limit: 5_000,
    filter: "all",
    ...businessFilter,
  });
  const orders =
    filter === "all"
      ? allOrders
      : await store.listForOwner(ownerId, {
          limit: 5_000,
          filter,
          ...businessFilter,
        });

  const counts = Object.fromEntries(
    ORDER_FILTERS.map((entry) => [
      entry.id,
      entry.id === "all"
        ? allOrders.length
        : allOrders.filter((order) => entry.statuses.includes(order.status))
            .length,
    ]),
  ) as Record<OrderFilterId, number>;

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">
            Orders across your businesses
          </h1>
          <p className="mt-1 text-sm text-slate">
            {selectedBusiness
              ? `Showing orders for ${selectedBusiness.name}.`
              : businesses.length > 1
                ? `All orders from your ${businesses.length} businesses are together here.`
                : "Open an order to see the customer details and move it along."}
          </p>
        </div>
        <Link href="/studio" className="btn-quiet">
          Back to Studio
        </Link>
      </div>

      {businesses.length > 0 && (
        <div className="mt-5 rounded-xl border border-brandblue/20 bg-brandblue/5 p-4">
          <BusinessSwitcher
            businesses={businesses}
            selectedBusinessId={selectedBusiness?.id}
            basePath="/studio/orders"
            filter={filter}
          />
          <p className="mt-2 text-xs text-slate-600">
            Keep “All businesses” selected for one combined order list, or
            choose one business to focus on its orders.
          </p>
        </div>
      )}

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
              href={ordersHref(entry.id, selectedBusiness?.id)}
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
                  <p className="text-xs font-semibold text-brandblue">
                    {businessNames.get(order.draftId) ??
                      "Business no longer in Studio"}
                  </p>
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

function ordersHref(filter: OrderFilterId, businessId?: string): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (businessId) params.set("business", businessId);
  const query = params.toString();
  return query ? `/studio/orders?${query}` : "/studio/orders";
}
