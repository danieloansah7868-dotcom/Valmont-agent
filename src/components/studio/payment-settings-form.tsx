"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, csrfToken } from "@/lib/client-api";
import type {
  PaymentMode,
  PaymentSettingsStatus,
  SettingSource,
} from "@/lib/studio/payment-settings";

/**
 * The interactive part of Studio → Settings → Payments.
 *
 * Deliberately simple for a non-technical owner: two big mode cards, three
 * paste boxes that only ever say SET / NOT SET, a Remove button per saved
 * value, and one Save button. Switching to Live requires ticking an explicit
 * "I understand real money" box.
 */

const SOURCE_LABELS: Record<SettingSource, string> = {
  "settings-page": "saved on this page",
  environment: "set in the server settings file (.env.local)",
  none: "",
};

function StatusBadge({ set, source }: { set: boolean; source: SettingSource }) {
  if (!set) {
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
        NOT SET
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
        SET
      </span>
      <span className="text-xs text-slate-500">{SOURCE_LABELS[source]}</span>
    </span>
  );
}

interface SecretFieldProps {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  set: boolean;
  source: SettingSource;
  onRemove: () => void;
  disabled: boolean;
  testId: string;
}

function SecretField({
  id,
  label,
  help,
  value,
  onChange,
  set,
  source,
  onRemove,
  disabled,
  testId,
}: SecretFieldProps) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-navy">
          {label}
        </label>
        <StatusBadge set={set} source={source} />
      </div>
      <p className="mt-1 text-xs text-slate-600">{help}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            set
              ? "Saved — paste a new value here to replace it"
              : "Paste it here"
          }
          disabled={disabled}
          data-testid={testId}
          className="min-h-11 w-full max-w-md rounded-md border border-line bg-white px-3 text-sm"
        />
        {set && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            data-testid={`${testId}-remove`}
            className="btn-secondary min-h-11 px-4 text-sm"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export function PaymentSettingsForm({
  initialStatus,
}: {
  initialStatus: PaymentSettingsStatus & { warning?: string };
}) {
  const router = useRouter();
  const [mode, setMode] = useState<PaymentMode>(initialStatus.mode);
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clearApiUrl, setClearApiUrl] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearWebhookSecret, setClearWebhookSecret] = useState(false);
  const [understandLive, setUnderstandLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(
    initialStatus.warning ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  if (!initialStatus.canManage) {
    return (
      <section
        className="mt-6 rounded-xl border border-line bg-white p-5"
        data-testid="read-only-notice"
      >
        <h2 className="text-lg font-semibold text-navy">
          Who can change these settings
        </h2>
        <p className="mt-2 text-sm text-slate">
          Only the payment manager account may change payment settings. You can
          look, but the boxes stay locked. If this is your business, sign in
          with the GitHub account that manages Valmont Pay.
        </p>
      </section>
    );
  }

  const switchingToLive = mode === "live" && initialStatus.mode !== "live";
  const urlReady =
    (initialStatus.apiUrlSet && !clearApiUrl) || apiUrl.trim().length > 0;
  const keyReady =
    (initialStatus.apiKeySet && !clearApiKey) || apiKey.trim().length > 0;
  const liveNeedsKeys = mode === "live" && !(urlReady && keyReady);

  async function save() {
    setBusy(true);
    setMessage(null);
    setWarning(null);
    setError(null);
    try {
      const body: Record<string, unknown> = { mode };
      if (apiUrl.trim()) body.apiUrl = apiUrl.trim();
      else if (clearApiUrl) body.apiUrl = null;
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      else if (clearApiKey) body.apiKey = null;
      if (webhookSecret.trim()) body.webhookSecret = webhookSecret.trim();
      else if (clearWebhookSecret) body.webhookSecret = null;

      const response = await fetch("/api/studio/settings/payments", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-valmont-csrf": csrfToken(),
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as PaymentSettingsStatus & {
        error?: string;
        warning?: string;
      };
      if (!response.ok) {
        throw new ApiError(response.status, data.error ?? "Request failed");
      }
      setMessage(
        data.liveActive
          ? "Saved. Payments are now LIVE — real money."
          : "Saved. Payments stay in Test mode — pretend money only.",
      );
      setWarning(data.warning ?? null);
      setApiUrl("");
      setApiKey("");
      setWebhookSecret("");
      setClearApiUrl(false);
      setClearApiKey(false);
      setClearWebhookSecret(false);
      setUnderstandLive(false);
      // Re-render the server parts (banner, badges) with the fresh status.
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Something went wrong while saving. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mt-6 rounded-xl border border-line bg-white p-5"
      aria-labelledby="your-valmont-pay-details"
    >
      <h2
        id="your-valmont-pay-details"
        className="text-lg font-semibold text-navy"
      >
        Your Valmont Pay details
      </h2>

      {/* Mode cards */}
      <div
        className="mt-4 grid gap-3 sm:grid-cols-2"
        role="radiogroup"
        aria-label="Payment mode"
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "test"}
          onClick={() => setMode("test")}
          data-testid="mode-test"
          className={`rounded-xl border p-4 text-left ${
            mode === "test"
              ? "border-navy bg-ivory ring-2 ring-navy"
              : "border-line bg-white"
          }`}
        >
          <p className="text-sm font-bold text-navy">Test mode</p>
          <p className="mt-1 text-xs text-slate-600">
            Pretend payments only. The safest choice while you practise.
          </p>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "live"}
          onClick={() => setMode("live")}
          data-testid="mode-live"
          className={`rounded-xl border p-4 text-left ${
            mode === "live"
              ? "border-red-500 bg-red-50 ring-2 ring-red-500"
              : "border-line bg-white"
          }`}
        >
          <p className="text-sm font-bold text-red-700">Live mode</p>
          <p className="mt-1 text-xs text-slate-600">
            Real Mobile Money and card payments from real customers.
          </p>
        </button>
      </div>

      {mode === "live" && (
        <div
          className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4"
          data-testid="live-warning"
        >
          <p className="text-sm font-bold text-red-800">
            ⚠ Live mode charges real money.
          </p>
          <p className="mt-1 text-sm text-red-800">
            Every customer who checks out will be asked to pay real MTN MoMo,
            Telecel Cash, AirtelTigo, card or bank transfer. Only switch this on
            when your Valmont Pay details below are all SET and you have
            finished testing.
          </p>
          {switchingToLive && (
            <label className="mt-3 flex items-start gap-2 text-sm text-red-900">
              <input
                type="checkbox"
                checked={understandLive}
                onChange={(event) => setUnderstandLive(event.target.checked)}
                data-testid="live-understand"
                className="mt-0.5 size-4"
              />
              I understand customers will be charged real money.
            </label>
          )}
        </div>
      )}

      {/* Secret fields */}
      <div className="mt-5 grid gap-5">
        <SecretField
          id="valmont-api-url"
          label="Valmont Pay API website address"
          help="Starts with https:// — Valmont Pay gives you this for your account."
          value={apiUrl}
          onChange={(v) => {
            setApiUrl(v);
            setClearApiUrl(false);
          }}
          set={initialStatus.apiUrlSet && !clearApiUrl}
          source={initialStatus.apiUrlSource}
          onRemove={() => setClearApiUrl(true)}
          disabled={busy}
          testId="field-api-url"
        />
        {clearApiUrl && (
          <p className="-mt-3 text-xs font-semibold text-red-700">
            Will be removed when you press Save. Start typing to keep it
            instead.
          </p>
        )}
        <SecretField
          id="valmont-api-key"
          label="Valmont Pay secret key"
          help="A long secret code from Valmont Pay. Treat it like a password."
          value={apiKey}
          onChange={(v) => {
            setApiKey(v);
            setClearApiKey(false);
          }}
          set={initialStatus.apiKeySet && !clearApiKey}
          source={initialStatus.apiKeySource}
          onRemove={() => setClearApiKey(true)}
          disabled={busy}
          testId="field-api-key"
        />
        {clearApiKey && (
          <p className="-mt-3 text-xs font-semibold text-red-700">
            Will be removed when you press Save. Start typing to keep it
            instead.
          </p>
        )}
        <SecretField
          id="valmont-webhook-secret"
          label="Webhook signing secret"
          help="Used to prove a payment confirmation really came from Valmont Pay. Live mode refuses unsigned confirmations, so set this before going live."
          value={webhookSecret}
          onChange={(v) => {
            setWebhookSecret(v);
            setClearWebhookSecret(false);
          }}
          set={initialStatus.webhookSecretSet && !clearWebhookSecret}
          source={initialStatus.webhookSecretSource}
          onRemove={() => setClearWebhookSecret(true)}
          disabled={busy}
          testId="field-webhook-secret"
        />
        {clearWebhookSecret && (
          <p className="-mt-3 text-xs font-semibold text-red-700">
            Will be removed when you press Save. Start typing to keep it
            instead.
          </p>
        )}
      </div>

      {mode === "live" &&
        !(initialStatus.webhookSecretSet && !clearWebhookSecret) &&
        !webhookSecret.trim() && (
          <p className="mt-4 rounded-md bg-amber-50 p-2 text-xs font-semibold text-amber-900">
            Yellow note: Live mode also needs the webhook signing secret.
            Without it, real payment confirmations will be refused and orders
            will not be marked Paid.
          </p>
        )}

      {message && (
        <p
          className="mt-4 rounded-md bg-green-50 p-2 text-sm font-semibold text-green-800"
          role="status"
          data-testid="save-success"
        >
          {message}
        </p>
      )}
      {warning && (
        <p
          className="mt-3 rounded-md bg-amber-50 p-2 text-sm font-semibold text-amber-900"
          data-testid="save-warning"
        >
          {warning}
        </p>
      )}
      {error && (
        <p
          className="mt-4 rounded-md bg-red-50 p-2 text-sm font-semibold text-red-700"
          role="alert"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || (switchingToLive && !understandLive)}
        data-testid="save-payment-settings"
        className="btn-primary mt-5 min-h-11 w-full justify-center px-5 sm:w-auto"
      >
        {busy ? "Saving…" : "Save payment settings"}
      </button>
      {liveNeedsKeys && (
        <p className="mt-2 text-xs text-slate-600">
          Tip: Live mode will only take real payments once a valid https:// API
          website address and the secret key both show SET.
        </p>
      )}
    </section>
  );
}
