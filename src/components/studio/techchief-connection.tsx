"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiMutation, apiPut, ApiError } from "@/lib/client-api";
import {
  bundleDeliveryDependency,
  computeLiveSalesReadiness,
} from "@/lib/studio/site-brief/readiness";

/**
 * The "Bundle delivery" card on a data-bundles draft (Stage 5).
 *
 * This is where a shop owner connects **their own** TechChief account: they
 * paste the API key from their own developer dashboard, so their own wallet
 * pays for their own customers' top-ups and this deployment never holds a
 * client's float.
 *
 * The card is built around one promise — the key is stored encrypted and never
 * shown again. That is why the input is a password field, why the connected
 * state shows only the nine-character prefix ("TCHX-AB12•••"), and why there
 * is no "edit key" affordance: to change it you paste a new one, and to see it
 * again you go to TechChief. Nothing in this file ever receives the key back
 * from the server, because the API never sends it.
 */

interface UnmatchedItemView {
  itemId: string;
  name: string;
  network: string | null;
  dataMb: number | null;
  reason: string;
}

export interface TechChiefConnectionView {
  connected: boolean;
  status: string | null;
  keyPrefix: string | null;
  webhookSecretSet: boolean;
  walletBalance: number | null;
  lowBalance: boolean;
  accountStatus: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  bundlesSyncedAt: string | null;
  bundleCount: number;
  unmatchedItems: UnmatchedItemView[];
  webhookUrl: string | null;
  webhookUrlIsHttps: boolean;
  requestsThisHour: number;
  requestsPerHour: number;
}

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `GHS ${value.toFixed(2)}`;
}

function Mono({ children }: { children: string }) {
  return (
    <span className="rounded bg-slate-200 px-1 font-mono break-all select-all">
      {children}
    </span>
  );
}

export function TechChiefConnectionCard({ draftId }: { draftId: string }) {
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<TechChiefConnectionView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const url = `/api/studio/drafts/${draftId}/integrations/techchief`;

  /** Reads the connection. No state is touched, so it is safe to call anywhere. */
  const fetchView =
    useCallback(async (): Promise<TechChiefConnectionView | null> => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Failed to load");
        return (await response.json()) as TechChiefConnectionView;
      } catch (cause) {
        console.error(cause);
        return null;
      }
    }, [url]);

  /** Re-reads after an action failed, so a revoked key shows without a reload. */
  const load = useCallback(async () => {
    const next = await fetchView();
    if (next) setView(next);
  }, [fetchView]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      const next = await fetchView();
      if (cancelled) return;
      if (next) setView(next);
      setLoading(false);
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, [fetchView]);

  function messageOf(cause: unknown, fallback: string): string {
    return cause instanceof ApiError ? cause.message : fallback;
  }

  async function run(
    action: string,
    work: () => Promise<TechChiefConnectionView | null | void>,
    successMessage?: string,
  ) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      if (result) setView(result);
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (cause) {
      setError(messageOf(cause, "That did not work. Try again."));
      // A failed probe still tells the truth about the connection, so refresh
      // it: a revoked key must show as an error without a page reload.
      await load();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    const key = apiKey.trim();
    if (!key) {
      setError("Paste your TechChief API key first.");
      return;
    }
    const saved = await run(
      "save",
      () =>
        apiPut<TechChiefConnectionView>(url, {
          apiKey: key,
          ...(webhookSecret.trim()
            ? { webhookSecret: webhookSecret.trim() }
            : {}),
        }),
      "TechChief accepted this key. Your shop can now send bundles automatically.",
    );
    if (saved) {
      setApiKey("");
      setWebhookSecret("");
    }
  }

  async function onTest() {
    await run(
      "test",
      async () => {
        const result = await apiMutation<{
          connection: TechChiefConnectionView;
        }>(`${url}/test`, {});
        return result.connection;
      },
      "Balance checked.",
    );
  }

  async function onSync() {
    await run(
      "sync",
      async () => {
        const result = await apiMutation<{
          connection: TechChiefConnectionView;
        }>(`${url}/sync-bundles`, {});
        return result.connection;
      },
      "TechChief price list updated.",
    );
  }

  async function onRemove() {
    const removed = await run("remove", async () => {
      await apiDelete(url);
      return null;
    });
    if (removed) {
      setConfirmingRemove(false);
      setView(null);
      setNotice(
        "TechChief key removed. Live bundle sales are off until you add one again.",
      );
      await load();
    }
  }

  if (loading) {
    return (
      <section
        id="bundle-delivery-card"
        data-testid="techchief-card"
        className="mt-4 h-40 scroll-mt-24 animate-pulse rounded-xl border border-line bg-white p-4"
      />
    );
  }

  const connected = Boolean(view?.connected);
  const verified = view?.status === "verified";
  const readiness = computeLiveSalesReadiness([
    bundleDeliveryDependency(true, { status: view?.status ?? null }),
  ]);
  const unmatched = view?.unmatchedItems ?? [];

  return (
    <section
      id="bundle-delivery-card"
      data-testid="techchief-card"
      className="mt-4 scroll-mt-24 rounded-xl border border-line bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-navy">Bundle delivery</h2>
        {connected && (
          <span
            data-testid="techchief-status"
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              verified
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            {verified
              ? `Connected · ${money(view?.walletBalance ?? null)}`
              : view?.status === "error"
                ? "Key problem"
                : "Not verified"}
          </span>
        )}
        {connected && view?.lowBalance && (
          <span
            data-testid="techchief-low-balance"
            className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700"
          >
            Low balance
          </span>
        )}
      </div>

      {!connected ? (
        <div className="mt-3 grid gap-3">
          <p className="text-xs text-slate-600">
            Paste the API key from your TechChief developer dashboard. It is
            stored encrypted and never shown again. Top-ups for this website are
            paid from your own TechChief wallet, so keep it topped up.
          </p>
          <div className="grid gap-2">
            <label htmlFor="techchief-key" className="sr-only">
              TechChief API key
            </label>
            <input
              id="techchief-key"
              data-testid="techchief-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="TCHX-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="rounded-lg border border-line px-3 py-1.5 font-mono text-sm"
            />
            <label htmlFor="techchief-webhook-secret" className="sr-only">
              Webhook secret (optional)
            </label>
            <input
              id="techchief-webhook-secret"
              data-testid="techchief-webhook-secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Webhook secret from TechChief (optional)"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              className="rounded-lg border border-line px-3 py-1.5 font-mono text-sm"
            />
          </div>
          <p className="text-[10px] text-slate-500">
            The webhook secret is what lets TechChief prove a delivery callback
            really came from them. Set one in their dashboard and paste it here;
            without it every callback is double-checked against TechChief first,
            which is slower and uses more of your hourly allowance.
          </p>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 text-xs text-slate-700">
          <dl className="grid gap-1">
            <div>
              <dt className="inline font-semibold">Key: </dt>
              <dd
                className="inline font-mono"
                data-testid="techchief-key-prefix"
              >
                {view?.keyPrefix}•••
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold">Wallet: </dt>
              <dd className="inline" data-testid="techchief-balance">
                {money(view?.walletBalance ?? null)}
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold">Account: </dt>
              <dd className="inline">{view?.accountStatus ?? "unknown"}</dd>
            </div>
            {view?.lastCheckedAt && (
              <div>
                <dt className="inline font-semibold">Last checked: </dt>
                <dd className="inline">
                  {new Date(view.lastCheckedAt).toLocaleString()}
                </dd>
              </div>
            )}
          </dl>

          {view?.lastError && (
            <p className="text-red-700" data-testid="techchief-error">
              {view.lastError}
            </p>
          )}

          <div className="rounded bg-slate-50 p-3">
            <p className="font-semibold">Bundles</p>
            <p className="mt-1" data-testid="techchief-bundles">
              {view?.bundleCount ?? 0} TechChief bundles
              {unmatched.length > 0 &&
                ` · ${unmatched.length} of your items have no match: ${unmatched
                  .slice(0, 4)
                  .map((item) => item.name)
                  .join(", ")}`}
              {unmatched.length > 4 && ` and ${unmatched.length - 4} more`}
              {view?.bundlesSyncedAt
                ? ` · synced ${new Date(view.bundlesSyncedAt).toLocaleDateString()}`
                : " · not synced yet"}
            </p>
            {unmatched.length > 0 && (
              <p className="mt-1 text-[10px] text-amber-700">
                TechChief sells by bundle, not by size. An item with no match
                cannot be sent automatically — sync the list again, or change
                the item to a network and size TechChief sells. Sub-1GB bundles
                (500MB) are not sold by TechChief at all.
              </p>
            )}
          </div>

          <div className="rounded bg-slate-50 p-3">
            <p className="font-semibold">Delivery callbacks</p>
            {view?.webhookUrl ? (
              <>
                <p className="mt-1">
                  Paste this into your TechChief dashboard so they can tell us
                  the moment a top-up lands:
                </p>
                <p className="mt-1">
                  <Mono>{view.webhookUrl}</Mono>
                </p>
              </>
            ) : (
              <p className="mt-1 text-amber-700">
                This server has no public https address yet (APP_URL), so
                TechChief cannot call back. Deliveries are still tracked — we
                ask TechChief for the status instead — but set APP_URL to your
                https domain for instant updates.
              </p>
            )}
            <p
              className="mt-2 text-[10px] text-slate-500"
              data-testid="techchief-budget"
            >
              TechChief allows {view?.requestsPerHour ?? 60} requests an hour on
              your key, shared between orders and status checks. About{" "}
              {view?.requestsThisHour ?? 0} used in the last hour. We keep the
              last ten for orders, so a busy shop should ask TechChief to raise
              the limit.
            </p>
          </div>

          {confirmingRemove && (
            <p className="rounded bg-amber-50 p-2 text-amber-800">
              Remove this key? Live bundle sales stop for this website until you
              add one again, and paid top-ups that have not been sent yet stay
              waiting.
            </p>
          )}
        </div>
      )}

      {error && (
        <p
          className="mt-3 text-xs text-red-600"
          role="alert"
          data-testid="techchief-action-error"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          className="mt-3 text-xs text-emerald-700"
          data-testid="techchief-notice"
        >
          {notice}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!connected ? (
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={busy !== null}
            data-testid="techchief-save"
            className="btn-primary px-3 py-1 text-xs"
          >
            {busy === "save" ? "Testing…" : "Save & test"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void onTest()}
              disabled={busy !== null}
              data-testid="techchief-test"
              className="btn-secondary px-3 py-1 text-xs"
            >
              {busy === "test" ? "Checking…" : "Check balance"}
            </button>
            <button
              type="button"
              onClick={() => void onSync()}
              disabled={busy !== null}
              data-testid="techchief-sync"
              className="btn-secondary px-3 py-1 text-xs"
            >
              {busy === "sync" ? "Syncing…" : "Sync bundles"}
            </button>
            {confirmingRemove ? (
              <>
                <button
                  type="button"
                  onClick={() => void onRemove()}
                  disabled={busy !== null}
                  data-testid="techchief-remove-confirm"
                  className="btn-primary bg-red-600 px-3 py-1 text-xs"
                >
                  {busy === "remove" ? "Removing…" : "Yes, remove the key"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busy !== null}
                  className="btn-secondary px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setConfirmingRemove(true);
                  setError(null);
                }}
                disabled={busy !== null}
                data-testid="techchief-remove"
                className="btn-secondary px-3 py-1 text-xs text-red-700"
              >
                Remove key
              </button>
            )}
          </>
        )}
      </div>

      <p
        className={`mt-3 text-[10px] ${
          readiness.readyForLiveSales ? "text-emerald-700" : "text-amber-700"
        }`}
        data-testid="techchief-readiness"
      >
        {readiness.readyForLiveSales
          ? "Ready for live sales: paid top-ups are sent automatically from your TechChief wallet."
          : readiness.blockers[0].hint}
      </p>
    </section>
  );
}
