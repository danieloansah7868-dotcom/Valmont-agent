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

/**
 * The owner's "Check status now" action (Stage 5).
 *
 * With a real wholesaler every status poll costs the shop a slice of its hourly
 * TechChief allowance, so polling is throttled server-side to once per row per
 * ten minutes. This button is the owner's way of asking anyway — and because
 * the throttle is the provider's, clicking it twice in a row costs one call,
 * not two. Shown while any top-up is still in flight.
 */
export function BundleDeliveryRecheckButton({
  orderId,
  processingCount,
  lastChecked,
}: {
  orderId: string;
  processingCount: number;
  /** When a row was last asked about, rendered by the page. */
  lastChecked?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  if (processingCount === 0) return null;

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiMutation<{ checkedAt?: string }>(
        `/api/studio/orders/${orderId}/bundle-deliveries/recheck`,
        {},
      );
      setCheckedAt(result.checkedAt ?? new Date().toISOString());
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not check the top-up status.",
      );
    } finally {
      setBusy(false);
    }
  }

  const shown = checkedAt ?? lastChecked ?? null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() => void recheck()}
        data-testid="recheck-bundle-deliveries"
      >
        {busy
          ? "Checking…"
          : `Check status now${processingCount === 1 ? "" : ` (${processingCount} sending)`}`}
      </button>
      {shown && (
        <span
          className="text-xs text-slate-600"
          data-testid="delivery-last-checked"
        >
          Last checked {new Date(shown).toLocaleTimeString()}
        </span>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
