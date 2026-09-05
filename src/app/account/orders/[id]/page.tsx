import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/customer-auth";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import {
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  type OrderStatus,
} from "@/lib/studio/order-status";
import {
  customerAccountsEnabled,
  PAYMENT_METHODS,
} from "@/lib/studio/site-brief/schema";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { formatAccra } from "@/lib/studio/format";
import {
  getBundleDeliveriesStore,
  guestBundleDeliverySummary,
} from "@/lib/studio/bundle-delivery";

export const dynamic = "force-dynamic";

const STATUS_COPY: Partial<Record<OrderStatus, string>> = {
  pending: "Your order is waiting for payment details to be completed.",
  payment_failed:
    "The payment attempt was not completed. Please contact the business if you need help.",
  cod_pending:
    "Your order is confirmed. Please have the total ready for cash on delivery.",
  paid: "Your payment has been received. The business will prepare your order soon.",
  preparing: "The business is preparing your order.",
  out_for_delivery: "Your order is on its way.",
  delivered: "Your order has been marked as delivered.",
  fulfilled: "Your order has been completed.",
  cancelled: "This order has been cancelled.",
  refunded: "This order has been refunded.",
};

export default async function CustomerOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getCustomerSession();
  if (!session) {
    redirect(
      `/account/login?next=${encodeURIComponent(`/account/orders/${id}`)}`,
    );
  }

  const order = await getOrdersStore().getForCustomer(session.account.id, id);
  if (!order) notFound();
  // A website that never enabled customer accounts must not expose the order
  // through the account area, even for a previously linked order.
  const draft = await publicGetDraft(order.draftId).catch(() => null);
  if (!draft || !customerAccountsEnabled(draft.brief)) notFound();

  const methodLabel =
    PAYMENT_METHODS.find((method) => method.id === order.paymentMethod)
      ?.label ?? order.paymentMethod;
  const statusCopy =
    STATUS_COPY[order.status] ??
    `Your order status is ${STATUS_LABELS[order.status]}.`;

  // Stage 4b: a bundle order shows the same single masked aggregate line the
  // guest confirmation page shows — how much data, how many top-ups, how many
  // delivered — and nothing else. No provider reference, no attempt count and
  // no provider error text: those belong to the owner's Studio order page. The
  // rows are only READ here, never reconciled, so a customer refreshing this
  // page cannot spend the shop's hourly TechChief allowance. A website that is
  // not a bundle shop has no delivery rows at all, so the line never appears
  // for it.
  const bundleDeliveries =
    draft.brief.category === "data-bundles" && order.recipientPhone
      ? await getBundleDeliveriesStore().listForOrder(order.id)
      : [];
  const bundleDeliveryLine =
    guestBundleDeliverySummary(bundleDeliveries, order.recipientPhone)?.line ??
    null;

  return (
    <section className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/account"
          className="text-sm font-semibold text-copper-700 underline"
        >
          ← Back to your orders
        </Link>
        <Link href="/" className="btn-quiet">
          Continue shopping
        </Link>
      </div>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-xs font-bold tracking-[0.14em] text-slate uppercase">
            Customer order
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-navy">
            Order {order.id.slice(0, 8)}
          </h1>
          <p className="mt-2 text-sm text-slate">
            Placed {formatAccra(order.createdAt)} · Updated{" "}
            {formatAccra(order.updatedAt)}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
            STATUS_BADGE_CLASS[order.status] ?? "bg-slate-200 text-slate-700"
          }`}
        >
          {STATUS_LABELS[order.status]}
        </span>
      </div>

      <p className="mt-5 rounded-xl bg-brandblue-50 p-4 text-sm leading-6 text-navy">
        {statusCopy}
      </p>

      {bundleDeliveryLine ? (
        <p
          className="mt-3 rounded-xl border border-line bg-white p-4 text-sm leading-6 text-navy"
          data-testid="bundle-delivery-line"
        >
          {bundleDeliveryLine}
        </p>
      ) : null}

      <section className="mt-5 rounded-xl border border-line bg-white p-5">
        <h2 className="text-base font-semibold text-navy">Order timeline</h2>
        <ol
          className="mt-4 grid gap-4 border-l-2 border-brandblue-100 pl-5"
          aria-label="Order status timeline"
        >
          {order.statusHistory.map((event, index) => (
            <li
              key={`${event.status}-${event.at}-${index}`}
              className="relative"
            >
              <span
                className="absolute -left-[1.63rem] top-0.5 size-2.5 rounded-full bg-brandblue ring-4 ring-white"
                aria-hidden="true"
              />
              <p className="text-sm font-semibold text-navy">
                {STATUS_LABELS[event.status]}
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                {formatAccra(event.at)}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-5 rounded-xl border border-line bg-white p-5">
        <h2 className="text-base font-semibold text-navy">Items</h2>
        <ul className="mt-4 grid gap-3">
          {order.lines.map((line) => (
            <li
              key={line.itemId}
              className="flex items-center gap-3 border-b border-line pb-3 text-sm last:border-0 last:pb-0"
            >
              {line.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={line.image}
                  alt=""
                  className="size-12 rounded-lg object-cover"
                />
              ) : null}
              <span className="min-w-0 flex-1 text-navy">
                {line.name}{" "}
                <span className="text-slate">× {line.quantity}</span>
              </span>
              <span className="font-semibold text-navy">
                {formatMoney(line.price * line.quantity, order.currency)}
              </span>
            </li>
          ))}
          {order.deliveryFee > 0 ? (
            <li className="flex justify-between border-t border-line pt-3 text-sm">
              <span>Delivery</span>
              <span>{formatMoney(order.deliveryFee, order.currency)}</span>
            </li>
          ) : null}
          <li className="flex justify-between border-t border-line pt-3 text-base font-bold text-navy">
            <span>Total</span>
            <span>{formatMoney(order.total, order.currency)}</span>
          </li>
        </ul>
      </section>

      <section className="mt-5 rounded-xl border border-line bg-white p-5">
        <h2 className="text-base font-semibold text-navy">Delivery details</h2>
        <dl className="mt-3 grid gap-2 text-sm text-slate-700">
          <div>
            <dt className="inline font-semibold text-navy">Name: </dt>
            <dd className="inline">{order.customerName}</dd>
          </div>
          <div>
            <dt className="inline font-semibold text-navy">Phone: </dt>
            <dd className="inline">{order.customerPhone}</dd>
          </div>
          {order.recipientPhone ? (
            <div>
              <dt className="inline font-semibold text-navy">Send to: </dt>
              <dd className="inline">{order.recipientPhone}</dd>
            </div>
          ) : null}
          {order.customerAddress ? (
            <div>
              <dt className="inline font-semibold text-navy">Address: </dt>
              <dd className="inline">{order.customerAddress}</dd>
            </div>
          ) : null}
          <div>
            <dt className="inline font-semibold text-navy">Payment: </dt>
            <dd className="inline">{methodLabel}</dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
