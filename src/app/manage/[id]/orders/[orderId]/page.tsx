import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { shopOrderLineLabel } from "@/lib/shop-admin/order-view";
import { publicGetDraftOwnerId } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";
import { PAYMENT_METHODS } from "@/lib/studio/site-brief/schema";
import {
  deliveryStatusLabel,
  getBundleDeliveriesStore,
  type DeliveryStatus,
} from "@/lib/studio/bundle-delivery";
import { bundleNetworkLabel, formatDataMb } from "@/lib/studio/bundles";
import { PaymentModeBadge } from "@/components/studio/payment-mode-badge";

export const dynamic = "force-dynamic";

const DELIVERY_BADGE_CLASS: Record<DeliveryStatus, string> = {
  pending: "bg-amber-100 text-amber-900",
  processing: "bg-blue-100 text-blue-900",
  delivered: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

/**
 * One order as the shop sees it (Stage 6b, read only). The recipient number
 * is shown in full — this is the person who has to send the bundle — which
 * is exactly why the page sits behind a shop login while the customer's own
 * `/account/orders/[id]` keeps it masked.
 *
 * The order is read through the owner-scoped store and then pinned to this
 * website: an order that belongs to a sibling website of the same agency
 * user is a 404 here, the same as an order that does not exist.
 */
export default async function ShopOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string; orderId: string }>;
}) {
  const { id, orderId } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  await requireShopAdminSession(
    id,
    `${base}/orders/${encodeURIComponent(orderId)}`,
  );

  const ownerId = await publicGetDraftOwnerId(id);
  if (!ownerId) notFound();
  const order = await getOrdersStore().getForOwner(ownerId, orderId);
  if (!order || order.draftId !== id) notFound();

  const deliveries = order.recipientPhone
    ? await getBundleDeliveriesStore().listForOrder(order.id)
    : [];
  const unitsPerLine = new Map<number, number>();
  for (const delivery of deliveries) {
    unitsPerLine.set(
      delivery.lineIndex,
      (unitsPerLine.get(delivery.lineIndex) ?? 0) + 1,
    );
  }
  const methodLabel =
    PAYMENT_METHODS.find((method) => method.id === order.paymentMethod)
      ?.label ?? order.paymentMethod;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-6 sm:px-6">
      <Link href={base} className="text-sm font-semibold underline">
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
            data-testid="shop-order-status"
          >
            {STATUS_LABELS[order.status]}
          </span>
        </div>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Customer</h2>
        <dl className="mt-2 grid gap-1 text-sm">
          <div>
            <dt className="inline font-semibold">Name: </dt>
            <dd className="inline">{order.customerName}</dd>
          </div>
          {order.recipientPhone && (
            <div>
              <dt className="inline font-semibold">Send to: </dt>
              <dd className="inline">
                <a
                  href={`tel:${order.recipientPhone}`}
                  className="underline"
                  data-testid="shop-order-recipient"
                >
                  {order.recipientPhone}
                </a>
              </dd>
            </div>
          )}
          <div>
            <dt className="inline font-semibold">Buyer&apos;s phone: </dt>
            <dd className="inline">
              <a href={`tel:${order.customerPhone}`} className="underline">
                {order.customerPhone}
              </a>
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Payment: </dt>
            <dd className="inline">{methodLabel}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold text-navy">Bundles</h2>
        <ul className="mt-3 grid gap-2">
          {order.lines.map((line) => (
            <li
              key={line.itemId}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1">{shopOrderLineLabel(line)}</span>
              <span className="font-semibold">
                {formatMoney(line.price * line.quantity, order.currency)}
              </span>
            </li>
          ))}
          <li className="flex justify-between border-t border-line pt-2 text-base font-bold">
            <span>Total</span>
            <span data-testid="shop-order-total">
              {formatMoney(order.total, order.currency)}
            </span>
          </li>
        </ul>
      </section>

      {deliveries.length > 0 && (
        <section
          className="mt-4 rounded-xl border border-line bg-white p-4"
          data-testid="shop-delivery-panel"
        >
          <h2 className="text-sm font-semibold text-navy">Delivery</h2>
          <ul className="mt-3 grid gap-2">
            {deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="rounded-lg border border-line p-3 text-sm"
                data-testid={`shop-delivery-${delivery.status}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {bundleNetworkLabel(delivery.network)}{" "}
                    {formatDataMb(delivery.dataMb)}
                    {(unitsPerLine.get(delivery.lineIndex) ?? 1) > 1 && (
                      <span className="font-normal text-slate-600">
                        {" "}
                        — unit {delivery.unitIndex + 1} of{" "}
                        {unitsPerLine.get(delivery.lineIndex)}
                      </span>
                    )}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      DELIVERY_BADGE_CLASS[delivery.status] ??
                      "bg-slate-200 text-slate-700"
                    }`}
                  >
                    {deliveryStatusLabel(delivery)}
                  </span>
                </div>
                <dl className="mt-1 grid gap-0.5 text-xs text-slate-600">
                  <div>
                    <dt className="inline font-semibold">To: </dt>
                    <dd className="inline">{delivery.recipientPhone}</dd>
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
                </dl>
              </li>
            ))}
          </ul>
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
    </div>
  );
}
