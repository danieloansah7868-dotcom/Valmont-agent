"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiPatch, ApiError } from "@/lib/client-api";
import type { ShopCatalogueItemView } from "@/lib/shop-admin/bundle-view";

/**
 * Stage 6c — the shop's bundle manager.
 *
 * One row per bundle: a price input with Save, and a Pause / Resume toggle.
 * On a Starter shop the toggle is replaced by the plain sentence "Pause is
 * part of Auto-Dispatch Pro." — the same rule the API enforces with the
 * standard package refusal, shown before anyone tries.
 *
 * Every write is a one-field PATCH to `/api/manage/[id]/bundles/[itemId]`;
 * the server re-validates the whole brief and answers with the catalogue
 * projection, never the brief.
 */

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "We could not complete that request. Please try again.";
}

function BundleRow({
  draftId,
  item,
  canPause,
}: {
  draftId: string;
  item: ShopCatalogueItemView;
  canPause: boolean;
}) {
  const router = useRouter();
  const [price, setPrice] = useState(
    item.price !== null ? String(item.price) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await apiPatch(
        `/api/manage/${encodeURIComponent(draftId)}/bundles/${encodeURIComponent(
          item.id,
        )}`,
        body,
      );
      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const label =
    item.network !== null && item.dataMb !== null
      ? `${item.network.toUpperCase()} ${item.dataMb >= 1024 ? `${item.dataMb / 1024}GB` : `${item.dataMb}MB`}`
      : item.name;

  return (
    <li
      className="rounded-xl border border-line bg-white p-4"
      data-testid="shop-bundle-row"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy">
            {label}
            {item.paused && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                Paused
              </span>
            )}
          </p>
          <p className="text-xs text-slate-600">
            {item.name}
            {item.validity ? ` · ${item.validity}` : ""}
          </p>
        </div>
        {canPause ? (
          <button
            type="button"
            className="btn-quiet text-xs"
            disabled={busy}
            data-testid="shop-bundle-pause"
            onClick={() => void patch({ paused: !item.paused })}
          >
            {item.paused ? "Resume" : "Pause"}
          </button>
        ) : (
          <span className="text-xs text-slate-600">
            Pause is part of Auto-Dispatch Pro.
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-600">
          Price (GHS)
          <input
            type="text"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value);
              setSaved(false);
            }}
            placeholder="10"
            className="ml-2 w-24 rounded-lg border border-line px-2 py-1.5 text-sm text-navy"
            data-testid="shop-bundle-price"
          />
        </label>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={busy || price.trim() === ""}
          data-testid="shop-bundle-save"
          onClick={() => void patch({ price: price.trim() })}
        >
          Save
        </button>
        {busy && <span className="text-xs text-slate-600">Saving…</span>}
        {saved && !busy && (
          <span className="text-xs font-semibold text-emerald-700">Saved</span>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function BundleManager({
  draftId,
  items,
  canPause,
}: {
  draftId: string;
  items: ShopCatalogueItemView[];
  canPause: boolean;
}) {
  if (items.length === 0) {
    return (
      <p
        className="mt-5 text-sm text-slate-600"
        data-testid="shop-bundles-empty"
      >
        This website has no bundles in its catalogue yet.
      </p>
    );
  }
  return (
    <ul className="mt-5 grid gap-3">
      {items.map((item) => (
        <BundleRow
          key={item.id}
          draftId={draftId}
          item={item}
          canPause={canPause}
        />
      ))}
    </ul>
  );
}
