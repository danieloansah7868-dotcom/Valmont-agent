"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiMutation, ApiError } from "@/lib/client-api";

/**
 * Stage 6d — the Supplier page's "Refresh balance" island.
 *
 * POSTs an empty JSON object to the shop's own refresh route the way every
 * 6c action posts (`apiMutation` with the CSRF header, `ApiError` for the
 * wording the server chose), then refreshes the server-rendered page so the
 * new balance, the low flag and the "last checked" time tell the truth. The
 * server decides how often a refresh is allowed; this component only shows
 * the refusal sentence it chose.
 */

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

export function SupplierRefreshButton({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await apiMutation(
        `/api/manage/${encodeURIComponent(draftId)}/supplier/refresh`,
        {},
      );
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-primary text-xs"
        disabled={busy}
        data-testid="shop-supplier-refresh"
        onClick={() => void refresh()}
      >
        {busy ? "Checking…" : "Refresh balance"}
      </button>
      {busy && <span className="text-xs text-slate-600">Checking…</span>}
      {error && (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
