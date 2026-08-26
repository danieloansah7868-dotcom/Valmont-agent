import Link from "next/link";
import { CustomerLogoutButton } from "@/components/customer-account-forms";
import { getCustomerSession } from "@/lib/customer-auth";
import { getOrdersStore, type OrderRecord } from "@/lib/studio/orders";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-GH", {
  dateStyle: "medium",
  timeZone: "Africa/Accra",
});

function OrderCard({ order }: { order: OrderRecord }) {
  return (
    <article className="rounded-xl border border-line bg-paper p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold tracking-[0.12em] text-slate uppercase">
            Order {order.id.slice(0, 8)}
          </p>
          <p className="mt-1 text-sm text-slate">
            {dateFormatter.format(new Date(order.createdAt))}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            STATUS_BADGE_CLASS[order.status] ?? "bg-slate-200 text-slate-700"
          }`}
        >
          {STATUS_LABELS[order.status]}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm text-navy">
          {order.lines.slice(0, 2).map((line) => (
            <p key={line.itemId}>
              {line.name} <span className="text-slate">× {line.quantity}</span>
            </p>
          ))}
          {order.lines.length > 2 ? (
            <p className="mt-1 text-xs text-slate">
              + {order.lines.length - 2} more item
              {order.lines.length - 2 === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-navy">
            {formatMoney(order.total, order.currency)}
          </p>
          <Link
            href={`/account/orders/${encodeURIComponent(order.id)}`}
            className="text-sm font-semibold text-copper-700 hover:underline"
          >
            Track order
          </Link>
        </div>
      </div>
    </article>
  );
}

export default async function CustomerAccountPage() {
  const session = await getCustomerSession();
  if (!session) redirect("/account/login?next=/account");
  const orders = await getOrdersStore().listForCustomer(session.account.id, 50);

  return (
    <section className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="flex flex-col justify-between gap-5 border-b border-line pb-8 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
            Customer account
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-navy">
            Hello, {session.account.name}
          </h1>
          <p className="mt-2 text-sm text-slate">{session.account.email}</p>
        </div>
        <CustomerLogoutButton />
      </div>

      <div className="mt-8 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-[-0.02em] text-navy">
            Your orders
          </h2>
          <p className="mt-1 text-sm text-slate">
            Orders you have claimed or placed after signing in appear here.
          </p>
        </div>
        <Link className="btn-primary shrink-0" href="/">
          Continue shopping
        </Link>
      </div>

      {orders.length > 0 ? (
        <div className="mt-5 grid gap-3">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      ) : (
        <div className="card mt-5 p-8 text-center">
          <h3 className="text-lg font-bold text-navy">No linked orders yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate">
            You can check out as a guest. After an order, use the account link
            on the confirmation page to keep it here.
          </p>
          <Link className="btn-secondary mt-5" href="/">
            Explore Valmont
          </Link>
        </div>
      )}
    </section>
  );
}
