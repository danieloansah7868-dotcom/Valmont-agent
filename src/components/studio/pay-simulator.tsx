"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The test-mode payment page. It stands in for the hosted Valmont Pay page when
 * no Valmont Pay account is configured, so the whole checkout flow can be
 * exercised on a self-hosted machine. Its two buttons call the same webhook
 * Valmont Pay would call, then send the shopper to the order confirmation page.
 *
 * This is only ever rendered in test mode; live mode redirects to the real
 * hosted page instead.
 */
export function PaySimulator({
  accessCode,
  orderId,
  amountLabel,
}: {
  accessCode: string;
  orderId: string;
  amountLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"pay" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(outcome: "success" | "failed") {
    setBusy(outcome === "success" ? "pay" : "cancel");
    setError(null);
    try {
      const response = await fetch(
        `/api/payments/webhook?access_code=${encodeURIComponent(accessCode)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: outcome }),
        },
      );
      if (!response.ok) {
        throw new Error("The test payment could not be recorded.");
      }
      router.push(`/orders/${orderId}/confirmed`);
      router.refresh();
    } catch (cause) {
      setBusy(null);
      setError(
        cause instanceof Error ? cause.message : "Something went wrong.",
      );
    }
  }

  return (
    <div className="rounded-xl border border-line bg-white p-5">
      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
        Test mode — no real money moves. Connect a Valmont Pay account to take
        real payments.
      </p>
      <p className="mt-4 text-sm text-slate">Amount to pay</p>
      <p className="text-2xl font-bold text-navy">{amountLabel}</p>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void send("success")}
          disabled={busy !== null}
          data-testid="sim-pay"
          className="btn-primary min-h-11 px-5"
        >
          {busy === "pay" ? "Recording…" : "Complete test payment"}
        </button>
        <button
          type="button"
          onClick={() => void send("failed")}
          disabled={busy !== null}
          data-testid="sim-cancel"
          className="btn-secondary min-h-11 px-5"
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel payment"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
