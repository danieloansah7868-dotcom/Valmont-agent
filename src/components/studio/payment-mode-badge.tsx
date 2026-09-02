import type { OrderPaymentMode } from "@/lib/studio/orders";

/**
 * Marks an order that went through the local payment simulator. Test orders
 * carry no real money, so the merchant must be able to tell them apart from
 * sales at a glance on every order view. Live orders get no badge: the
 * absence of a marker is the normal case and adding noise there would train
 * the eye to ignore the one that matters.
 */
export function PaymentModeBadge({
  mode,
  className = "",
}: {
  mode: OrderPaymentMode;
  className?: string;
}) {
  if (mode !== "test") return null;
  return (
    <span
      className={`rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-900 uppercase ${className}`}
      title="Placed through the local payment simulator. No real money moved."
      data-testid="order-test-mode-badge"
    >
      Test order
    </span>
  );
}
