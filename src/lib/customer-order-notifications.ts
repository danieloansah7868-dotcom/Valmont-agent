import { customerEmailHtml, sendCustomerEmail } from "./customer-email";
import type { OrderRecord } from "./studio/orders";
import { STATUS_LABELS, type OrderStatus } from "./studio/order-status";
import { formatMoney } from "./studio/valmont-pay";

export type CustomerOrderStatusNotificationResult =
  "sent" | "skipped" | "failed";

const STATUS_COPY: Partial<Record<OrderStatus, string>> = {
  paid: "Your payment has been received and the business will begin preparing your order.",
  cod_pending:
    "Your order is confirmed. Please have the total ready for cash on delivery.",
  preparing: "The business has started preparing your order.",
  out_for_delivery: "Your order is on its way.",
  delivered: "Your order has been marked as delivered.",
  fulfilled: "Your order has been completed.",
  cancelled: "Your order has been cancelled.",
  refunded: "Your order has been refunded.",
  payment_failed: "The payment attempt for your order was not completed.",
};

/**
 * Sends a transactional status update to the email captured at checkout.
 * Orders without an email remain fully usable, but there is no address to
 * notify. Delivery failures are reported to the caller without affecting the
 * merchant's successful status update.
 */
export async function notifyCustomerOrderStatus(input: {
  order: OrderRecord;
  origin: string;
}): Promise<CustomerOrderStatusNotificationResult> {
  const { order } = input;
  if (!order.customerEmail) return "skipped";

  const path = order.customerAccountId
    ? `/account/orders/${encodeURIComponent(order.id)}`
    : `/orders/${encodeURIComponent(order.id)}/confirmed`;

  try {
    const orderUrl = new URL(path, input.origin).toString();
    const label = STATUS_LABELS[order.status];
    const copy =
      STATUS_COPY[order.status] ?? `Your order status is now ${label}.`;
    const reference = order.id.slice(0, 8);
    const total = formatMoney(order.total, order.currency);
    const delivery = await sendCustomerEmail({
      to: order.customerEmail,
      name: order.customerName,
      subject: `Order ${reference}: ${label}`,
      text: [
        `Your Valmont order ${reference} is now ${label}.`,
        copy,
        `Total: ${total}`,
        `View order status: ${orderUrl}`,
      ].join("\n"),
      html: customerEmailHtml(
        `Order ${reference}: ${label}`,
        order.customerName,
        `${copy} Total: ${total}.`,
        "View order status",
        orderUrl,
      ),
      developmentLink: orderUrl,
    });
    return delivery.delivered ? "sent" : "skipped";
  } catch {
    return "failed";
  }
}
