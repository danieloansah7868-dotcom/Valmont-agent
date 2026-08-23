import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore } from "@/lib/studio/orders";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { formatAccra } from "@/lib/studio/format";
import { PAYMENT_METHODS } from "@/lib/studio/site-brief/schema";
import { OrderActions } from "@/components/studio/order-actions";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSessionUser();
  const { id } = await params;
  const order = await getOrdersStore().getForOwner(canonicalUserId(user), id);
  if (!order) notFound();

  const methodLabel =
    PAYMENT_METHODS.find((method) => method.id === order.paymentMethod)
      ?.label ?? order.paymentMethod;

  return (
    <div className="mx-auto w-full max-w-[720px] p-4 sm:p-6">
      <Link href="/studio/orders" className="text-sm font-semibold underline">
        All orders
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
        >
          {STATUS_LABELS[order.status]}
        </span>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Customer</h2>
        <dl className="mt-2 grid gap-1 text-sm">
          <div>
            <dt className="inline font-semibold">Name: </dt>
            <dd className="inline">{order.customerName}</dd>
          </div>
          <div>
            <dt className="inline font-semibold">Phone: </dt>
            <dd className="inline">
              <a href={`tel:${order.customerPhone}`} className="underline">
                {order.customerPhone}
              </a>
            </dd>
          </div>
          {order.customerEmail && (
            <div>
              <dt className="inline font-semibold">Email: </dt>
              <dd className="inline">
                <a href={`mailto:${order.customerEmail}`} className="underline">
                  {order.customerEmail}
                </a>
              </dd>
            </div>
          )}
          {order.customerAddress && (
            <div>
              <dt className="inline font-semibold">Address: </dt>
              <dd className="inline">{order.customerAddress}</dd>
            </div>
          )}
          {order.merchantNote && (
            <div>
              <dt className="inline font-semibold">Note: </dt>
              <dd className="inline">{order.merchantNote}</dd>
            </div>
          )}
          <div>
            <dt className="inline font-semibold">Payment: </dt>
            <dd className="inline">{methodLabel}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Items</h2>
        <ul className="mt-3 grid gap-3">
          {order.lines.map((line) => (
            <li key={line.itemId} className="flex items-center gap-3 text-sm">
              {line.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={line.image}
                  alt=""
                  className="size-12 rounded-lg object-cover"
                />
              ) : null}
              <span className="min-w-0 flex-1">
                {line.name} × {line.quantity}
              </span>
              <span className="font-semibold">
                {formatMoney(line.price * line.quantity, order.currency)}
              </span>
            </li>
          ))}
          {order.deliveryFee > 0 && (
            <li className="flex justify-between text-sm">
              <span>Delivery</span>
              <span>{formatMoney(order.deliveryFee, order.currency)}</span>
            </li>
          )}
          <li className="flex justify-between border-t border-line pt-2 text-base font-bold">
            <span>Total</span>
            <span>{formatMoney(order.total, order.currency)}</span>
          </li>
        </ul>
      </section>

      {order.statusHistory.length > 0 && (
        <section className="mt-4 rounded-xl border border-line bg-white p-4">
          <h2 className="text-sm font-semibold text-navy">Timeline</h2>
          <ol className="mt-2 grid gap-1 text-sm">
            {order.statusHistory.map((event, index) => (
              <li key={`${event.status}-${event.at}-${index}`}>
                <span className="font-semibold">
                  {STATUS_LABELS[event.status]}
                </span>
                <span className="text-slate-600">
                  {" "}
                  · {formatAccra(event.at)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Update this order</h2>
        <div className="mt-3">
          <OrderActions order={order} />
        </div>
      </section>
    </div>
  );
}
