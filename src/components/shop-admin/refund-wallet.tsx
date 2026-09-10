"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiMutation, ApiError } from "@/lib/client-api";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

/**
 * Stage 7b — the owner's "Refund to wallet" action, sitting next to
 * DeliveryOrderActions (in its own file; delivery-actions.tsx is untouched).
 * The server page decides whether this button exists at all (owner only,
 * wallet-paid agent order, refundable status) — the component only asks for
 * a plain-text confirmation, posts, and lets the refreshed server-rendered
 * page tell the truth. Money is never computed here: the confirm sentence
 * arrives fully built from the ledger amounts.
 */
export function RefundToWalletButton({
  draftId,
  orderId,
  confirmText,
}: {
  draftId: string;
  orderId: string;
  confirmText: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refund() {
    if (busy) return;
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      await apiMutation(
        `/api/manage/${encodeURIComponent(draftId)}/orders/${encodeURIComponent(orderId)}/refund-wallet`,
        {},
      );
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={busy}
          data-testid="shop-refund-wallet"
          onClick={() => void refund()}
        >
          {busy ? "Refunding…" : "Refund to wallet"}
        </button>
        {busy && <span className="text-xs text-slate-600">Refunding…</span>}
      </div>
      {error && (
        <p className="mt-1 text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
