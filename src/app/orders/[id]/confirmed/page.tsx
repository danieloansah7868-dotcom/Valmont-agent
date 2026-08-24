import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { orderConfirmationDestination } from "@/lib/studio/order-confirmation";
import { getOrdersStore } from "@/lib/studio/orders";
import { formatMoney, STATUS_LABELS } from "@/lib/studio/valmont-pay";

export const dynamic = "force-dynamic";

/**
 * The customer's order confirmation. Shown after checkout for every payment
 * method: a paid card/Valmont Pay order, a bank/Mobile Money order awaiting a
 * manual transfer, or a cash-on-delivery order. It only ever reflects the real
 * recorded status — nothing here claims a payment that has not happened.
 */
export default async function OrderConfirmedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await getOrdersStore().getById(id);

  if (!order) {
    return (
      <main className="mx-auto w-full max-w-[560px] p-6">
        <h1 className="text-xl font-bold text-navy">Order not found</h1>
        <p className="mt-2 text-sm text-slate">
          We could not find this order. Check the link and try again.
        </p>
      </main>
    );
  }

  const viewer = await getSessionUser();
  const destination = orderConfirmationDestination(order, viewer);
  const paid = order.status === "paid";
  const cod = order.status === "cod_pending";
  const failed = order.status === "payment_failed";
  const manual = order.status === "pending" && !failed;

  return (
    <main className="mx-auto w-full max-w-[560px] p-6">
      <h1 className="text-2xl font-bold text-navy">
        {failed ? "Payment not completed" : "Order placed!"}
      </h1>
      <p className="mt-1 text-sm text-slate">
        Order reference {order.id.slice(0, 8)}
      </p>

      <div className="mt-4 rounded-lg border border-line bg-white p-4">
        <p className="text-sm">
          <span className="font-semibold">Status: </span>
          {STATUS_LABELS[order.status]}
        </p>

        <ul className="mt-3 grid gap-1 text-sm">
          {order.lines.map((line) => (
            <li key={line.itemId} className="flex justify-between gap-4">
              <span>
                {line.name} × {line.quantity}
              </span>
              <span>
                {formatMoney(line.price * line.quantity, order.currency)}
              </span>
            </li>
          ))}
          {order.deliveryFee > 0 && (
            <li className="flex justify-between gap-4 border-t border-line pt-1">
              <span>Delivery</span>
              <span>{formatMoney(order.deliveryFee, order.currency)}</span>
            </li>
          )}
          <li className="flex justify-between gap-4 border-t border-line pt-1 font-semibold">
            <span>Total</span>
            <span>{formatMoney(order.total, order.currency)}</span>
          </li>
        </ul>
      </div>

      {paid && (
        <p className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-800">
          Your payment has been received. The business will be in touch about
          your order.
        </p>
      )}

      {cod && (
        <div className="mt-4 rounded-md bg-blue-50 p-3 text-sm text-blue-900">
          <p className="font-semibold">Cash on delivery</p>
          <p className="mt-1">
            Please have {formatMoney(order.total, order.currency)} ready to pay
            when your order arrives.
          </p>
        </div>
      )}

      {manual && (
        <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Complete your payment</p>
          {order.paymentMethod === "momo" && (
            <p className="mt-1">
              The business will send you Mobile Money payment details for{" "}
              {formatMoney(order.total, order.currency)}. Keep this reference:{" "}
              {order.id.slice(0, 8)}.
            </p>
          )}
          {order.paymentMethod === "bank" && (
            <p className="mt-1">
              The business will send you bank transfer details for{" "}
              {formatMoney(order.total, order.currency)}. Use reference{" "}
              {order.id.slice(0, 8)} on your transfer.
            </p>
          )}
          {order.paymentMethod !== "momo" && order.paymentMethod !== "bank" && (
            <p className="mt-1">
              Your order is awaiting payment of{" "}
              {formatMoney(order.total, order.currency)}.
            </p>
          )}
        </div>
      )}

      {failed && (
        <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
          Your payment did not go through. No money has been taken. You can try
          ordering again.
        </p>
      )}

      <p className="mt-6 text-xs text-slate-500">
        Contact the business directly if you have any questions about this
        order.
      </p>
      <Link
        href={destination.href}
        className={
          destination.isOwner
            ? "btn-primary mt-4 inline-flex"
            : "mt-2 inline-block text-sm underline"
        }
      >
        {destination.label}
      </Link>
    </main>
  );
}
