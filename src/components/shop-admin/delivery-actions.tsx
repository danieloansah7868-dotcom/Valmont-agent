"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiMutation, ApiError } from "@/lib/client-api";

/**
 * Stage 6c — the shop's delivery actions.
 *
 * Two islands, both POSTing the way the 6b Team page does (`apiMutation`
 * with the CSRF header, `ApiError` for the wording the server chose):
 *
 *  - `DeliveryRowActions` sits inside one delivery row and offers the manual
 *    marks. The optional note belongs to "Mark failed" only.
 *  - `DeliveryOrderActions` sits under the delivery list and offers Retry
 *    (not on a Starter shop — there is nothing automatic to retry) and
 *    Check status (only while a row is in flight).
 *
 * The server page decides which buttons exist; the components only render
 * what they are handed, and after a success they refresh the page so the
 * server-rendered rows tell the truth.
 */

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

export function DeliveryRowActions({
  draftId,
  orderId,
  deliveryId,
  canMarkDelivered,
  canMarkFailed,
}: {
  draftId: string;
  orderId: string;
  deliveryId: string;
  canMarkDelivered: boolean;
  canMarkFailed: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!canMarkDelivered && !canMarkFailed) return null;

  async function mark(status: "delivered" | "failed") {
    setBusy(true);
    setError("");
    try {
      await apiMutation(
        `/api/manage/${encodeURIComponent(draftId)}/orders/${encodeURIComponent(
          orderId,
        )}/deliveries/${encodeURIComponent(deliveryId)}/mark`,
        {
          status,
          ...(status === "failed" && note.trim() ? { note: note.trim() } : {}),
        },
      );
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      {canMarkFailed && (
        <label className="block text-xs text-slate-600">
          Note (optional)
          <input
            type="text"
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why it could not be sent"
            className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-sm text-navy"
            data-testid={`shop-mark-failed-note-${deliveryId}`}
          />
        </label>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canMarkDelivered && (
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={busy}
            data-testid="shop-mark-delivered"
            onClick={() => void mark("delivered")}
          >
            Mark delivered
          </button>
        )}
        {canMarkFailed && (
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy}
            data-testid="shop-mark-failed"
            onClick={() => void mark("failed")}
          >
            Mark failed
          </button>
        )}
        {busy && <span className="text-xs text-slate-600">Saving…</span>}
      </div>
      {error && (
        <p className="mt-1 text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function DeliveryOrderActions({
  draftId,
  orderId,
  canRetry,
  canRecheck,
}: {
  draftId: string;
  orderId: string;
  canRetry: boolean;
  canRecheck: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "retry" | "recheck">("");
  const [error, setError] = useState("");

  if (!canRetry && !canRecheck) return null;

  async function run(kind: "retry" | "recheck") {
    setBusy(kind);
    setError("");
    try {
      await apiMutation(
        `/api/manage/${encodeURIComponent(draftId)}/orders/${encodeURIComponent(
          orderId,
        )}/deliveries/${kind === "retry" ? "retry" : "recheck"}`,
        {},
      );
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {canRetry && (
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy !== ""}
            data-testid="shop-retry-deliveries"
            onClick={() => void run("retry")}
          >
            Retry failed top-ups
          </button>
        )}
        {canRecheck && (
          <button
            type="button"
            className="btn-quiet text-xs"
            disabled={busy !== ""}
            data-testid="shop-recheck-deliveries"
            onClick={() => void run("recheck")}
          >
            Check status now
          </button>
        )}
        {busy !== "" && (
          <span className="text-xs text-slate-600">
            {busy === "retry" ? "Retrying…" : "Checking…"}
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1 text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
