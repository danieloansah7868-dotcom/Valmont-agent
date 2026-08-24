"use client";

import { useState } from "react";
import Link from "next/link";

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
  const [busy, setBusy] = useState<"pay" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(outcome: "success" | "failed") {
    setBusy(outcome === "success" ? "pay" : "cancel");
    setError(null);
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      let response: Response | null = null;
      try {
        response = await fetch(
          `/api/payments/webhook?access_code=${encodeURIComponent(accessCode)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: outcome }),
            signal: controller.signal,
          },
        );
      } finally {
        window.clearTimeout(timeout);
      }
      if (response && !response.ok)
        throw new Error("The test payment could not be recorded.");

      if (outcome === "success") {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const check = await fetch(
            `/api/payments/status/${encodeURIComponent(accessCode)}`,
            { cache: "no-store" },
          );
          if (
            check.ok &&
            ((await check.json()) as { status?: string }).status === "paid"
          )
            break;
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      }
      // A full navigation cannot be held up by a slow router/rendering state.
      // A hard navigation avoids the dev router getting stuck on “Rendering…”.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/orders/${orderId}/confirmed`);
    } catch (cause) {
      // The server may have saved an aborted request, so check once before showing an error.
      try {
        const check = await fetch(
          `/api/payments/status/${encodeURIComponent(accessCode)}`,
          { cache: "no-store" },
        );
        if (
          outcome === "success" &&
          check.ok &&
          ((await check.json()) as { status?: string }).status === "paid"
        ) {
          // A hard navigation avoids the dev router getting stuck on “Rendering…”.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/orders/${orderId}/confirmed`);
          return;
        }
      } catch {
        /* The always-visible order link remains available. */
      }
      setBusy(null);
      setError(
        cause instanceof Error && cause.name !== "AbortError"
          ? cause.message
          : "This is taking longer than expected. Your payment may already be recorded; use View your order below.",
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
      <Link
        href={`/orders/${orderId}/confirmed`}
        className="mt-4 inline-flex text-sm font-semibold text-brandblue underline"
      >
        View your order
      </Link>
    </div>
  );
}
