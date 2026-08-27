import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import {
  ACCRA_TIME_ZONE,
  ANALYTICS_DATE_RANGES,
  analyticsRangeEndExclusive,
  analyticsRangeStart,
  filterAnalyticsOrders,
  isAnalyticsDateRange,
  summariseOrders,
  type AnalyticsDateRange,
} from "@/lib/studio/analytics";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { PAYMENT_METHODS } from "@/lib/studio/site-brief/schema";

export const dynamic = "force-dynamic";

const ORDER_LIMIT = 5_000;

export default async function StudioAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ website?: string; range?: string }>;
}) {
  const user = await requireSessionUser();
  const { website: requestedWebsiteId, range: requestedRange } =
    await searchParams;
  const dateRange: AnalyticsDateRange = isAnalyticsDateRange(requestedRange)
    ? requestedRange
    : "all";
  const ownerId = canonicalUserId(user);
  const now = new Date();
  const rangeStart = analyticsRangeStart(dateRange, now);
  const rangeEndExclusive = analyticsRangeEndExclusive(now);
  const drafts = await getStudioDraftStore().list(user);
  const websites = drafts
    .map((draft) => ({ id: draft.id, name: draft.brief.businessName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectedWebsite = websites.find(
    (website) => website.id === requestedWebsiteId,
  );

  const orders = await getOrdersStore().listForOwner(ownerId, {
    limit: ORDER_LIMIT,
    filter: "all",
    draftId: selectedWebsite?.id,
    createdAfter: rangeStart ? `${rangeStart}T00:00:00.000Z` : undefined,
    createdBefore: rangeStart ? (rangeEndExclusive ?? undefined) : undefined,
  });
  const analytics = summariseOrders(
    filterAnalyticsOrders(orders, {
      draftId: selectedWebsite?.id,
      dateRange,
      now,
    }),
  );

  return (
    <main className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/studio"
            className="text-sm font-semibold text-brandblue underline"
          >
            ← Back to Website Studio
          </Link>
          <h1 className="mt-4 text-2xl font-bold text-navy">Sales analytics</h1>
          <p className="mt-2 max-w-[680px] text-sm text-slate-600">
            Understand what is selling across your online-shop websites. These
            figures use settled orders only, with full refunds deducted from net
            sales.
          </p>
        </div>
        <span className="rounded-full bg-ivory-100 px-3 py-1.5 text-xs font-semibold text-slate-700">
          Times shown in Accra
        </span>
      </div>

      <form
        method="get"
        className="mt-6 grid gap-3 rounded-xl border border-line bg-white p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div>
          <label
            htmlFor="analytics-website"
            className="text-xs font-semibold text-slate-700"
          >
            Website
          </label>
          <select
            id="analytics-website"
            name="website"
            defaultValue={selectedWebsite?.id ?? ""}
            className="mt-1.5 min-h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-navy"
          >
            <option value="">All websites</option>
            {websites.map((website) => (
              <option key={website.id} value={website.id}>
                {website.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="analytics-range"
            className="text-xs font-semibold text-slate-700"
          >
            Period
          </label>
          <select
            id="analytics-range"
            name="range"
            defaultValue={dateRange}
            className="mt-1.5 min-h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-navy"
          >
            {ANALYTICS_DATE_RANGES.map((range) => (
              <option key={range.id} value={range.id}>
                {range.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary min-h-10 px-4 text-sm">
            Apply filters
          </button>
          {(selectedWebsite || dateRange !== "all") && (
            <Link href="/studio/analytics" className="btn-quiet min-h-10 px-3">
              Clear
            </Link>
          )}
        </div>
      </form>

      <p className="mt-3 text-xs text-slate-500">
        {selectedWebsite
          ? `Showing ${selectedWebsite.name}`
          : "Showing all of your online-shop websites"}
        {dateRange !== "all"
          ? ` · ${ANALYTICS_DATE_RANGES.find((range) => range.id === dateRange)?.label}`
          : " · all time"}
        {` · based on up to ${ORDER_LIMIT.toLocaleString("en-GH")} orders in this view`}
      </p>

      <section
        className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Sales summary"
      >
        <MetricCard
          label="Net sales"
          value={formatMoney(analytics.paidRevenue)}
          detail={`Gross ${formatMoney(analytics.grossRevenue)}`}
        />
        <MetricCard
          label="Paid orders"
          value={String(analytics.paidOrders)}
          detail="Settled orders"
        />
        <MetricCard
          label="Average order"
          value={formatMoney(analytics.averageOrderValue)}
          detail="Net sales ÷ paid orders"
        />
        <MetricCard
          label="Refunded"
          value={formatMoney(analytics.refundedRevenue)}
          detail={`${analytics.refundedOrders} full-refund ${analytics.refundedOrders === 1 ? "order" : "orders"}`}
        />
      </section>

      <section className="mt-6 grid gap-5 lg:grid-cols-2">
        <AnalyticsList
          title="Top items"
          empty="No settled items in this view yet."
          rows={analytics.topItems.map(
            (item) =>
              `${item.name} · ${item.quantity} sold · ${formatMoney(item.revenue)}`,
          )}
        />
        <AnalyticsList
          title="Payment methods"
          empty="No settled payment methods in this view yet."
          rows={analytics.paymentMethods.map(
            (item) =>
              `${paymentMethodLabel(item.method)} · ${item.orders} ${item.orders === 1 ? "order" : "orders"} · ${formatMoney(item.revenue)}`,
          )}
        />
        <AnalyticsList
          title="Busiest order times"
          empty="No settled order times in this view yet."
          rows={analytics.busiestHours.map(
            (item) =>
              `${formatHour(item.hour)} · ${item.orders} ${item.orders === 1 ? "order" : "orders"}`,
          )}
        />
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="font-semibold text-navy">How to read this</h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Net sales exclude pending, failed, cash-on-delivery awaiting
            collection, cancelled, and refunded orders. Full refunds are assumed
            because the current order record does not store partial refund
            amounts.
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Your data stays owner-scoped. Filter by website when you want to
            look at one client project rather than the whole workspace.
          </p>
        </section>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-bold text-navy">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function AnalyticsList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: string[];
}) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="font-semibold text-navy">{title}</h2>
      {rows.length ? (
        <ul className="mt-3 grid gap-2 text-sm text-slate-700">
          {rows.slice(0, 8).map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-600">{empty}</p>
      )}
    </section>
  );
}

function paymentMethodLabel(method: string): string {
  return (
    PAYMENT_METHODS.find((entry) => entry.id === method)?.label ??
    method.replaceAll("_", " ")
  );
}

function formatHour(hour: number): string {
  const nextHour = (hour + 1) % 24;
  const current = String(hour).padStart(2, "0");
  const next = String(nextHour).padStart(2, "0");
  return `${current}:00–${next}:00 ${ACCRA_TIME_ZONE.replace("Africa/", "")}`;
}
