import { redirect } from "next/navigation";
import Link from "next/link";
import { getOrdersStore } from "@/lib/studio/orders";
import {
  formatMoney,
  isLiveConfigured,
  paymentUrlFor,
} from "@/lib/studio/valmont-pay";
import { PaySimulator } from "@/components/studio/pay-simulator";

export const dynamic = "force-dynamic";

/**
 * The hosted payment page for an order.
 *
 * - In live mode, this redirects to the real Valmont Pay page.
 * - In test mode, it shows the local simulator so the flow is fully usable.
 * - Either way, an already-paid order shows a short receipt instead.
 */
export default async function PayPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const order = await getOrdersStore().getByAccessCode(code);

  if (!order) {
    return (
      <main className="mx-auto w-full max-w-[560px] p-6">
        <h1 className="text-xl font-bold text-navy">Payment link not found</h1>
        <p className="mt-2 text-sm text-slate">
          This payment link is invalid or has expired.
        </p>
      </main>
    );
  }

  const amountLabel = formatMoney(order.total, order.currency);

  if (order.status === "paid") {
    return (
      <main className="mx-auto w-full max-w-[560px] p-6">
        <h1 className="text-xl font-bold text-navy">Payment received</h1>
        <p className="mt-2 text-sm text-slate">
          Thank you. Your payment of {amountLabel} has been received.
        </p>
        <Link
          href={`/orders/${order.id}/confirmed`}
          className="btn-primary mt-5 inline-flex"
        >
          View your order
        </Link>
      </main>
    );
  }

  // Live mode: hand off to the real hosted Valmont Pay page.
  if (await isLiveConfigured()) {
    redirect(await paymentUrlFor(order.accessCode));
  }

  return (
    <main className="mx-auto w-full max-w-[560px] p-6">
      <h1 className="text-xl font-bold text-navy">Pay for your order</h1>
      <p className="mt-1 text-sm text-slate">Order {order.id.slice(0, 8)}</p>

      <ul className="mt-4 grid gap-1 rounded-lg border border-line bg-white p-4 text-sm">
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
          <span>{amountLabel}</span>
        </li>
      </ul>

      <div className="mt-5">
        <PaySimulator
          accessCode={order.accessCode}
          orderId={order.id}
          amountLabel={amountLabel}
        />
      </div>
    </main>
  );
}
