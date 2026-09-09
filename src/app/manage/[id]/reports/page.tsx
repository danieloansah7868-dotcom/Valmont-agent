import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { can } from "@/lib/shop-admin/permissions";
import {
  aggregateShopReport,
  loadDeliveriesForReport,
  resolveShopReportRange,
  SHOP_REPORT_RANGE_LABELS,
  SHOP_REPORT_RANGES,
  type ShopReportMarginRow,
} from "@/lib/shop-admin/reports";
import {
  publicGetDraft,
  publicGetDraftOwnerId,
} from "@/lib/studio/draft-public";
import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import { formatMoney } from "@/lib/studio/money";
import { getOrdersStore } from "@/lib/studio/orders";
import { planAllows, planOf } from "@/lib/studio/plans";

export const dynamic = "force-dynamic";

/**
 * The shop's Sales and margin report (Stage 6d, Command Center only).
 *
 * A server-rendered aggregate of THIS website's own orders and delivery
 * rows: how many paid live orders, how much money they collected, what the
 * supplier charged for the delivered top-ups whose cost is known, and the
 * margin that leaves. Aggregates only — no customer names, no phone
 * numbers, no order ids anywhere on the page, and no client JavaScript
 * beyond the plain range links. The money definitions live in
 * `src/lib/shop-admin/reports.ts` and are pinned by its unit tests.
 */
export default async function ShopReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(id, `${base}/reports`);
  if (!can(session.admin, "reports.view")) notFound();

  const draft = await publicGetDraft(id);
  if (!draft || draft.brief.category !== "data-bundles") notFound();
  const plan = planOf(draft.brief);
  if (!planAllows(plan, "reports")) notFound();

  const query = await searchParams;
  const rawRange = typeof query.range === "string" ? query.range : null;
  const { range, createdAfter } = resolveShopReportRange(rawRange);

  // This website only: the owner id pins the read, and every order is
  // filtered by draftId, so a sibling website's numbers can never appear.
  const ownerId = await publicGetDraftOwnerId(id);
  if (!ownerId) notFound();
  const orders = await getOrdersStore().listForOwner(ownerId, {
    limit: 2000,
    filter: "all",
    draftId: id,
    createdAfter,
  });
  const deliveries = await loadDeliveriesForReport(
    orders.map((order) => order.id),
  );
  const report = aggregateShopReport(orders, deliveries);

  const showEmpty = report.orders === 0 && report.testOrdersExcluded === 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Sales &amp; margin</h1>
          <p className="mt-1 text-sm text-slate">
            What your shop collected, what the supplier charged, and what is
            left over — for this website only.
          </p>
        </div>
        <nav aria-label="Report period" className="flex flex-wrap gap-1">
          {SHOP_REPORT_RANGES.map((candidate) => {
            const active = candidate === range;
            return (
              <Link
                key={candidate}
                href={`${base}/reports?range=${candidate}`}
                aria-current={active ? "page" : undefined}
                data-testid="shop-reports-range"
                data-active={active ? "true" : "false"}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                  active
                    ? "bg-navy text-white"
                    : "bg-white text-navy ring-1 ring-line hover:bg-ivory-100"
                }`}
              >
                {SHOP_REPORT_RANGE_LABELS[candidate]}
              </Link>
            );
          })}
        </nav>
      </div>

      {showEmpty && (
        <p
          className="mt-5 rounded-xl border border-line bg-white p-4 text-sm text-slate-600"
          data-testid="shop-reports-empty"
        >
          No paid orders in this period.
        </p>
      )}

      {report.testOrdersExcluded > 0 && (
        <p
          className="mt-5 rounded-xl border border-line bg-white p-3 text-xs text-slate-600"
          data-testid="shop-reports-test-note"
        >
          {report.testOrdersExcluded} test order
          {report.testOrdersExcluded === 1 ? "" : "s"} excluded.
        </p>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-white p-4">
          <dt className="text-xs font-semibold tracking-wide text-slate uppercase">
            Orders
          </dt>
          <dd
            className="mt-1 text-2xl font-bold text-navy"
            data-testid="shop-reports-orders"
          >
            {report.orders}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <dt className="text-xs font-semibold tracking-wide text-slate uppercase">
            Money collected
          </dt>
          <dd
            className="mt-1 text-2xl font-bold text-navy"
            data-testid="shop-reports-revenue"
          >
            {formatMoney(report.moneyCollected)}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <dt className="text-xs font-semibold tracking-wide text-slate uppercase">
            Supplier cost
          </dt>
          <dd
            className="mt-1 text-2xl font-bold text-navy"
            data-testid="shop-reports-cost"
          >
            {formatMoney(report.supplierCost)}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <dt className="text-xs font-semibold tracking-wide text-slate uppercase">
            Margin
          </dt>
          <dd
            className="mt-1 text-2xl font-bold text-navy"
            data-testid="shop-reports-margin"
          >
            {formatMoney(report.margin)}
            <span className="ml-1 text-sm font-semibold text-slate-600">
              ({report.marginPercent.toFixed(2)}%)
            </span>
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-4 sm:col-span-2">
          <dt className="text-xs font-semibold tracking-wide text-slate uppercase">
            Top-ups
          </dt>
          <dd
            className="mt-1 text-sm font-semibold text-navy"
            data-testid="shop-reports-topups"
          >
            Delivered {report.deliveredTopUps} · Failed {report.failedTopUps} ·{" "}
            In flight {report.inFlightTopUps}
          </dd>
        </div>
      </dl>

      <p
        className="mt-3 text-xs text-slate-600"
        data-testid="shop-reports-cost-coverage"
      >
        Cost known for {report.costedTopUps} of {report.deliveredTopUps}{" "}
        delivered top-ups.
        {report.costedTopUps < report.deliveredTopUps &&
          " Top-ups sent by hand or in test mode have no supplier cost recorded."}
      </p>

      <MarginTable
        title="By network"
        rows={report.perNetwork.map((row) => ({
          ...row,
          label: bundleNetworkLabel(row.network),
        }))}
        testId="shop-reports-network-row"
        emptyLabel="No delivered top-ups in this period."
      />

      <MarginTable
        title="By bundle"
        rows={report.perBundle.map((row) => ({
          ...row,
          // The catalogue item name ("MTN 1GB") is the group's display name;
          // the group itself is itemName + network + dataMb (see reports.ts).
          label:
            row.itemName ||
            `${bundleNetworkLabel(row.network)} ${formatDataMb(row.dataMb ?? 0)}`,
        }))}
        testId="shop-reports-bundle-row"
        emptyLabel="No delivered top-ups in this period."
      />
    </div>
  );
}

/** One money table: per-network or per-bundle rows, nothing but aggregates. */
function MarginTable({
  title,
  rows,
  testId,
  emptyLabel,
}: {
  title: string;
  rows: Array<
    ShopReportMarginRow & {
      label: string;
    }
  >;
  testId: string;
  emptyLabel: string;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-navy">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">{emptyLabel}</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-line text-xs tracking-wide text-slate uppercase">
              <tr>
                <th className="px-3 py-2 font-semibold">
                  {title === "By network" ? "Network" : "Bundle"}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  Delivered
                </th>
                <th className="px-3 py-2 text-right font-semibold">Revenue</th>
                <th className="px-3 py-2 text-right font-semibold">
                  Supplier cost
                </th>
                <th className="px-3 py-2 text-right font-semibold">Margin</th>
                <th className="px-3 py-2 text-right font-semibold">
                  Cost known
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.label}
                  data-testid={testId}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-3 py-2 font-semibold text-navy">
                    {row.label}
                  </td>
                  <td className="px-3 py-2 text-right">{row.deliveredUnits}</td>
                  <td className="px-3 py-2 text-right">
                    {formatMoney(row.revenue)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatMoney(row.cost)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatMoney(row.margin)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.costedUnits} of {row.deliveredUnits}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
