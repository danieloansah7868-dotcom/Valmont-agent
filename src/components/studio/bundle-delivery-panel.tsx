"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiMutation } from "@/lib/client-api";

/**
 * The Retry action of the owner's "Bundle delivery" panel (Stage 4). Shown
 * only when the order has failed top-ups; a click asks the server to
 * re-dispatch exactly those rows and then re-renders the page. Delivered and
 * in-flight rows are not retryable, so there is no way to double-send one.
 */
export function BundleDeliveryRetryButton({
  orderId,
  failedCount,
}: {
  orderId: string;
  failedCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (failedCount === 0) return null;

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await apiMutation(
        `/api/studio/orders/${orderId}/bundle-deliveries/retry`,
        {},
      );
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not retry the top-ups.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={() => void retry()}
        data-testid="retry-bundle-deliveries"
      >
        {busy
          ? "Retrying…"
          : `Retry failed top-up${failedCount === 1 ? "" : "s"} (${failedCount})`}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
