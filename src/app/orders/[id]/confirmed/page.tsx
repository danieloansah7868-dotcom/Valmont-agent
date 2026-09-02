import Link from "next/link";
import { ClaimOrderButton } from "@/components/customer-account-forms";
import { getCustomerSession } from "@/lib/customer-auth";
import { getSessionUser } from "@/lib/auth";
import { orderConfirmationDestination } from "@/lib/studio/order-confirmation";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import { customerAccountsEnabled } from "@/lib/studio/site-brief/schema";
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
  // Account prompts appear only on websites where the owner enabled customer
  // accounts; other orders keep a pure guest confirmation page.
  const draft = await publicGetDraft(order.draftId).catch(() => null);
  const accountsEnabled = draft ? customerAccountsEnabled(draft.brief) : false;
  const customerSession = accountsEnabled
    ? await getCustomerSession().catch(() => null)
    : null;
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
        {order.recipientPhone && (
          <p className="mt-2 text-sm">
            <span className="font-semibold">Send to: </span>
            {order.recipientPhone}
          </p>
        )}
        {order.customerPhone && (
          <p className="mt-1 text-sm">
            <span className="font-semibold">Contact: </span>
            {order.customerPhone}
          </p>
        )}

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

      {accountsEnabled && !order.customerAccountId ? (
        <div className="mt-6 rounded-lg border border-brandblue-200 bg-brandblue-50 p-4">
          <p className="text-sm font-semibold text-navy">
            {order.customerEmail
              ? "Want this order in your account?"
              : "Guest order account linking unavailable"}
          </p>
          {order.customerEmail ? (
            <>
              <p className="mt-1 text-sm leading-6 text-slate">
                Customer accounts are optional. Link this order now to track it
                alongside future purchases.
              </p>
              {customerSession ? (
                <ClaimOrderButton accessCode={order.accessCode} />
              ) : (
                <Link
                  href={`/account/register?claim=${encodeURIComponent(order.accessCode)}`}
                  className="btn-primary mt-3 inline-flex"
                >
                  Create an account and link order
                </Link>
              )}
            </>
          ) : (
            <p className="mt-1 text-sm leading-6 text-slate">
              This order was checked out without an email address, so it cannot
              be linked securely to a customer account.
            </p>
          )}
        </div>
      ) : null}

      {accountsEnabled &&
      order.customerAccountId &&
      customerSession?.account.id === order.customerAccountId ? (
        <Link
          href={`/account/orders/${encodeURIComponent(order.id)}`}
          className="btn-secondary mt-6 inline-flex"
        >
          Track this order in your account
        </Link>
      ) : null}

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
