"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/** Longest we wait for the webhook call before declaring it stuck. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * After the payment is recorded we soft-navigate to the confirmation page;
 * if that render stalls (the Phase 4 "Rendering… / Recording…" hang) this
 * timer forces a full browser navigation instead. The shopper is never left
 * staring at a stuck button.
 */
const HARD_NAV_FALLBACK_MS = 2_500;

/**
 * The test-mode payment page. It stands in for the hosted Valmont Pay page
 * when the Studio is in Test mode, so the whole checkout flow can be
 * exercised with no real money. Its two buttons call the same webhook Valmont
 * Pay would call, then send the shopper to the order confirmation page.
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
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  const confirmationHref = `/orders/${orderId}/confirmed`;

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  function navigateWithFallback(href: string) {
    router.push(href);
    router.refresh();
    timers.current.push(
      window.setTimeout(() => {
        // Still here after the grace period? The soft navigation stalled —
        // hand the whole page over to the confirmation URL.
        window.location.assign(href);
      }, HARD_NAV_FALLBACK_MS),
    );
  }

  async function send(outcome: "success" | "failed") {
    setBusy(outcome === "success" ? "pay" : "cancel");
    setError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    timers.current.push(timeout);
    try {
      const response = await fetch(
        `/api/payments/webhook?access_code=${encodeURIComponent(accessCode)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: outcome }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error("The test payment could not be recorded.");
      }
      if (outcome === "success") {
        // Show the receipt panel FIRST, so even a stalled render leaves the
        // shopper with a working "View your order" link.
        setPaid(true);
      }
      navigateWithFallback(confirmationHref);
    } catch (cause) {
      const timedOut =
        cause instanceof DOMException && cause.name === "AbortError";
      setBusy(null);
      setError(
        timedOut
          ? "The website took too long to answer. The payment may still have been recorded — tap “View your order” below to check, or try again."
          : cause instanceof Error
            ? cause.message
            : "Something went wrong.",
      );
    }
  }

  if (paid) {
    return (
      <div
        className="rounded-xl border border-green-300 bg-green-50 p-5"
        data-testid="sim-paid"
      >
        <p className="text-lg font-bold text-green-800">Payment received</p>
        <p className="mt-1 text-sm text-green-900">
          Your test payment of {amountLabel} was recorded. Taking you to your
          order now…
        </p>
        <Link
          href={confirmationHref}
          className="btn-primary mt-4 inline-flex min-h-11 px-5"
        >
          View your order
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-white p-5">
      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
        Test mode — no real money moves. Connect a Valmont Pay account in Studio
        → Settings → Payments to take real payments.
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
        <div className="mt-3" role="alert">
          <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
          <Link
            href={confirmationHref}
            className="btn-secondary mt-2 inline-flex min-h-11 px-5"
          >
            View your order
          </Link>
        </div>
      )}

      {busy === "pay" && (
        <p className="mt-3 text-xs text-slate-500">
          Recording the payment — this should take a second or two. If nothing
          happens, refresh this page with Ctrl+Shift+R: the payment usually
          already went through.
        </p>
      )}
    </div>
  );
}
