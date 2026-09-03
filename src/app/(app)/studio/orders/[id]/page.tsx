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
import { PaymentModeBadge } from "@/components/studio/payment-mode-badge";
import {
  DELIVERY_STATUS_LABELS,
  recheckBundleDeliveriesForOrder,
  type DeliveryStatus,
} from "@/lib/studio/bundle-delivery";
import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import { BundleDeliveryRetryButton } from "@/components/studio/bundle-delivery-panel";

const DELIVERY_BADGE_CLASS: Record<DeliveryStatus, string> = {
  pending: "bg-amber-100 text-amber-900",
  processing: "bg-blue-100 text-blue-900",
  delivered: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

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

  // Stage 4: reconcile bundle top-ups on every page load (recovery after an
  // outage flushes rows stuck at "pending" and polls "processing" ones). The
  // engine never throws; only data-bundles orders ever produce rows, so this
  // stays empty — and the panel stays hidden — for every other website type.
  const bundleDeliveries = order.recipientPhone
    ? await recheckBundleDeliveriesForOrder(order.id)
    : [];
  const failedTopUps = bundleDeliveries.filter(
    (delivery) => delivery.status === "failed",
  ).length;

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
        <div className="flex items-center gap-2">
          <PaymentModeBadge mode={order.paymentMode} />
          <span
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              STATUS_BADGE_CLASS[order.status] ?? "bg-slate-200 text-slate-700"
            }`}
          >
            {STATUS_LABELS[order.status]}
          </span>
        </div>
      </div>
      {order.paymentMode === "test" && (
        <p
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
          data-testid="order-test-mode-notice"
        >
          This order was placed while payments were in test mode. The payment
          went through the local simulator, so no real money was received. It is
          excluded from sales analytics.
        </p>
      )}

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
          {order.recipientPhone && (
            <div>
              <dt className="inline font-semibold">Send to: </dt>
              <dd className="inline">
                <a href={`tel:${order.recipientPhone}`} className="underline">
                  {order.recipientPhone}
                </a>
              </dd>
            </div>
          )}
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

      {bundleDeliveries.length > 0 && (
        <section
          className="mt-4 rounded-xl border border-line bg-white p-4"
          data-testid="bundle-delivery-panel"
        >
          <h2 className="text-sm font-semibold text-navy">Bundle delivery</h2>
          <ul className="mt-3 grid gap-3">
            {bundleDeliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="rounded-lg border border-line p-3 text-sm"
                data-testid={`bundle-delivery-${delivery.status}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {bundleNetworkLabel(delivery.network)}{" "}
                    {formatDataMb(delivery.dataMb)} × {delivery.quantity}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      DELIVERY_BADGE_CLASS[delivery.status] ??
                      "bg-slate-200 text-slate-700"
                    }`}
                  >
                    {DELIVERY_STATUS_LABELS[delivery.status]}
                  </span>
                </div>
                <dl className="mt-1 grid gap-0.5 text-xs text-slate-600">
                  <div>
                    <dt className="inline font-semibold">To: </dt>
                    <dd className="inline">{delivery.recipientPhone}</dd>
                  </div>
                  {delivery.itemName && (
                    <div>
                      <dt className="inline font-semibold">Item: </dt>
                      <dd className="inline">{delivery.itemName}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline font-semibold">Attempts: </dt>
                    <dd className="inline">{delivery.attempts}</dd>
                  </div>
                  {delivery.providerRef && (
                    <div>
                      <dt className="inline font-semibold">Reference: </dt>
                      <dd className="inline font-mono">
                        {delivery.providerRef}
                      </dd>
                    </div>
                  )}
                  {delivery.deliveredAt && (
                    <div>
                      <dt className="inline font-semibold">Delivered: </dt>
                      <dd className="inline">
                        {formatAccra(delivery.deliveredAt)}
                      </dd>
                    </div>
                  )}
                  {delivery.status === "failed" && delivery.lastError && (
                    <div>
                      <dt className="inline font-semibold">Problem: </dt>
                      <dd className="inline text-red-700">
                        {delivery.lastError}
                      </dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
          <BundleDeliveryRetryButton
            orderId={order.id}
            failedCount={failedTopUps}
          />
        </section>
      )}

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
