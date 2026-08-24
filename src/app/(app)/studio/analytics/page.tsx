import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import { summariseOrders } from "@/lib/studio/analytics";
import { formatMoney } from "@/lib/studio/valmont-pay";

export const dynamic = "force-dynamic";

export default async function StudioAnalyticsPage() {
  const user = await requireSessionUser();
  const orders = await getOrdersStore().listForOwner(canonicalUserId(user), {
    limit: 5_000,
    filter: "all",
  });
  const analytics = summariseOrders(orders);

  return (
    <main className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <Link
        href="/studio"
        className="text-sm font-semibold text-brandblue underline"
      >
        ← Back to Website Studio
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-navy">Sales analytics</h1>
      <p className="mt-2 text-sm text-slate-600">
        Sales from paid and fulfilled orders across all of your Studio
        businesses.
      </p>
      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          ["Paid sales", formatMoney(analytics.paidRevenue)],
          ["Paid orders", String(analytics.paidOrders)],
          ["Average order", formatMoney(analytics.averageOrderValue)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-line bg-white p-4"
          >
            <p className="text-xs font-semibold text-slate-600">{label}</p>
            <p className="mt-1 text-2xl font-bold text-navy">{value}</p>
          </div>
        ))}
      </section>
      <section className="mt-6 grid gap-5 lg:grid-cols-2">
        <AnalyticsList
          title="Top items"
          empty="No paid items yet."
          rows={analytics.topItems.map(
            (item) =>
              `${item.name} · ${item.quantity} sold · ${formatMoney(item.revenue)}`,
          )}
        />
        <AnalyticsList
          title="Payment methods"
          empty="No paid orders yet."
          rows={analytics.paymentMethods.map(
            (item) =>
              `${item.method} · ${item.orders} orders · ${formatMoney(item.revenue)}`,
          )}
        />
        <AnalyticsList
          title="Busiest order times"
          empty="No order times yet."
          rows={analytics.busiestHours.map(
            (item) =>
              `${String(item.hour).padStart(2, "0")}:00 · ${item.orders} orders`,
          )}
        />
      </section>
    </main>
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
