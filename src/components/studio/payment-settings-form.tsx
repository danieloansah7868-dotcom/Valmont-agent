"use client";

import { useState, type FormEvent } from "react";
import { csrfToken } from "@/lib/client-api";

type Status = {
  mode: "test" | "live";
  apiUrlSet: boolean;
  apiKeySet: boolean;
  webhookSecretSet: boolean;
  liveReady: boolean;
  liveActive: boolean;
};

export function PaymentSettingsForm({ initial }: { initial: Status }) {
  const [status, setStatus] = useState(initial);
  const [mode, setMode] = useState<"test" | "live">(initial.mode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      mode === "live" &&
      !confirm("Switch on Live mode? Customers can be charged real money.")
    )
      return;
    setBusy(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/studio/payment-settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-valmont-csrf": csrfToken(),
        },
        body: JSON.stringify({
          mode,
          apiUrl: form.get("apiUrl") || undefined,
          apiKey: form.get("apiKey") || undefined,
          webhookSecret: form.get("webhookSecret") || undefined,
        }),
      });
      const data = (await response.json()) as Status & { error?: string };
      if (!response.ok)
        throw new Error(
          data.error || "The payment settings could not be saved.",
        );
      setStatus(data);
      event.currentTarget.reset();
      setMessage(
        data.liveActive
          ? "Saved. Live payments are ON."
          : "Saved. Test mode is ON; no real money will move.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  const indicator = (set: boolean) => (
    <span
      className={`rounded-full px-2 py-1 text-xs font-bold ${set ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}
    >
      {set ? "SET" : "NOT SET"}
    </span>
  );

  return (
    <form onSubmit={save} className="mt-5 grid gap-5">
      <fieldset className="grid gap-3 rounded-xl border border-line bg-white p-4">
        <legend className="px-1 font-semibold text-navy">Payment mode</legend>
        <label className="flex cursor-pointer gap-3">
          <input
            type="radio"
            checked={mode === "test"}
            onChange={() => setMode("test")}
          />
          <span>
            <strong>Test mode</strong>
            <span className="block text-sm text-slate-600">
              Uses the local payment simulator. No real money moves.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer gap-3">
          <input
            type="radio"
            checked={mode === "live"}
            onChange={() => setMode("live")}
          />
          <span>
            <strong>Live mode</strong>
            <span className="block text-sm font-semibold text-red-700">
              Warning: customers will be charged real Mobile Money, card or bank
              payments.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold text-navy">Details from Valmont Pay</h2>
        <p className="mt-1 text-sm text-slate-600">
          Ask Valmont Pay for your API address, secret API key and webhook
          signing secret. Paste each one below. Saved secrets are encrypted and
          are never shown again.
        </p>
        <div className="mt-4 grid gap-4">
          <label className="grid gap-1 text-sm">
            <span className="flex items-center justify-between gap-2 font-semibold">
              API address {indicator(status.apiUrlSet)}
            </span>
            <input
              name="apiUrl"
              type="url"
              placeholder={
                status.apiUrlSet
                  ? "Already saved — leave blank to keep it"
                  : "https://…"
              }
              className="rounded-lg border border-line p-3"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="flex items-center justify-between gap-2 font-semibold">
              API key {indicator(status.apiKeySet)}
            </span>
            <input
              name="apiKey"
              type="password"
              placeholder={
                status.apiKeySet
                  ? "Already saved — leave blank to keep it"
                  : "Paste secret API key"
              }
              className="rounded-lg border border-line p-3"
              autoComplete="new-password"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="flex items-center justify-between gap-2 font-semibold">
              Webhook signing secret {indicator(status.webhookSecretSet)}
            </span>
            <input
              name="webhookSecret"
              type="password"
              placeholder={
                status.webhookSecretSet
                  ? "Already saved — leave blank to keep it"
                  : "Paste webhook signing secret"
              }
              className="rounded-lg border border-line p-3"
              autoComplete="new-password"
            />
          </label>
        </div>
      </div>

      <div
        className={`rounded-xl p-4 text-sm font-semibold ${status.liveActive ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}
      >
        Current status:{" "}
        {status.liveActive
          ? "LIVE — real charges are enabled"
          : "TEST — no real money moves"}
      </div>
      {message && (
        <p role="status" className="text-sm font-semibold text-navy">
          {message}
        </p>
      )}
      <button
        disabled={busy}
        className="btn-primary min-h-11 w-full justify-center sm:w-auto"
      >
        {busy ? "Saving…" : "Save payment settings"}
      </button>
    </form>
  );
}
