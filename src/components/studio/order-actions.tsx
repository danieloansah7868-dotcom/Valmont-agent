"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiPatch } from "@/lib/client-api";
import type { OrderRecord } from "@/lib/studio/orders";
import {
  ACTION_LABELS,
  allowedTransitions,
  type OrderStatus,
} from "@/lib/studio/order-status";

export function OrderActions({ order }: { order: OrderRecord }) {
  const router = useRouter();
  const [busy, setBusy] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const next = allowedTransitions(order.status);

  if (next.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        No further actions on this order.
      </p>
    );
  }

  async function apply(status: OrderStatus) {
    setBusy(status);
    setError(null);
    try {
      await apiPatch(`/api/studio/orders/${order.id}`, { status });
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update the order.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {next.map((status) => (
          <button
            key={status}
            type="button"
            disabled={busy !== null}
            onClick={() => void apply(status)}
            className={
              status === "cancelled" || status === "refunded"
                ? "btn-danger"
                : "btn-primary"
            }
            data-testid={`order-action-${status}`}
          >
            {busy === status ? "Updating…" : (ACTION_LABELS[status] ?? status)}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
