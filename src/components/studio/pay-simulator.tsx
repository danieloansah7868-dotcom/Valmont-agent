"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/** Longest we wait for the webhook call before checking the saved order. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a delayed webhook gets to finish saving the order. */
const STATUS_POLL_TIMEOUT_MS = 12_000;
/** Each status request has its own shorter network timeout. */
const STATUS_REQUEST_TIMEOUT_MS = 2_500;
const STATUS_POLL_INTERVAL_MS = 750;
/**
 * After the payment is recorded we soft-navigate to the confirmation page;
 * if that render stalls (the Phase 4 "Rendering… / Recording…" hang) this
 * timer forces a full browser navigation instead. The shopper is never left
 * staring at a stuck button.
 */
const HARD_NAV_FALLBACK_MS = 2_500;

type BusyAction = "pay" | "cancel" | "checking";

type SavedPaymentStatus = "paid" | "payment_failed" | "pending" | null;

function isAbortError(cause: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      cause instanceof DOMException &&
      cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

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
  const [busy, setBusy] = useState<BusyAction | null>(null);
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

  async function readSavedStatus(): Promise<SavedPaymentStatus> {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      STATUS_REQUEST_TIMEOUT_MS,
    );
    timers.current.push(timeout);
    try {
      const response = await fetch(
        `/api/payments/status/${encodeURIComponent(accessCode)}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { status?: unknown };
      return data.status === "paid" ||
        data.status === "payment_failed" ||
        data.status === "pending"
        ? data.status
        : null;
    } catch {
      // A status check is best effort. The View your order link remains
      // available even if this browser cannot reach the status endpoint.
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function pollForSavedPayment(): Promise<SavedPaymentStatus> {
    const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await readSavedStatus();
      if (status === "paid" || status === "payment_failed") return status;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        timers.current.push(
          window.setTimeout(
            resolve,
            Math.min(STATUS_POLL_INTERVAL_MS, remaining),
          ),
        );
      });
    }
    return null;
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
        navigateWithFallback(confirmationHref);
      } else {
        navigateWithFallback(confirmationHref);
      }
    } catch (cause) {
      if (outcome === "success") {
        // The webhook may have committed the order even when its response was
        // delayed or lost. Check the database before showing an error, which
        // removes the Phase 4 "Recording…" ambiguity in the common case.
        setBusy("checking");
        const savedStatus = await pollForSavedPayment();
        if (savedStatus === "paid") {
          setPaid(true);
          navigateWithFallback(confirmationHref);
          return;
        }
        setBusy(null);
        setError(
          savedStatus === "payment_failed"
            ? "The test payment was not completed. No real money moved. Use “View your order” below to check the order."
            : isAbortError(cause)
              ? "The website took too long to answer. The payment may still have been recorded — use “View your order” below to check, or try again."
              : "We could not confirm the test payment. It may still have been recorded — use “View your order” below to check.",
        );
        return;
      }

      setBusy(null);
      setError(
        isAbortError(cause)
          ? "The website took too long to answer. Use “View your order” below to check the order, or try again."
          : cause instanceof Error
            ? cause.message
            : "Something went wrong.",
      );
    } finally {
      window.clearTimeout(timeout);
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
          {busy === "pay"
            ? "Recording…"
            : busy === "checking"
              ? "Checking payment…"
              : "Complete test payment"}
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

      {busy && !error && (
        <Link
          href={confirmationHref}
          className="mt-3 inline-block text-sm font-semibold text-navy underline"
        >
          View your order
        </Link>
      )}

      {busy === "pay" && (
        <p className="mt-3 text-xs text-slate-500">
          Recording the payment — this should take a second or two. If nothing
          happens, we will check whether it was saved. You can also use View
          your order below.
        </p>
      )}
      {busy === "checking" && (
        <p className="mt-3 text-xs text-slate-500">
          The payment response was slow. Checking whether the order was saved…
        </p>
      )}
    </div>
  );
}
