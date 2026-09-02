"use client";

import { useMemo, useState } from "react";
import {
  DATA_NETWORKS,
  autoBundleName,
  dataNetworkLabel,
  dataNetworkColors,
  normalizeVolume,
  type DataBundle,
  type DataNetworkId,
} from "@/lib/studio/data-bundles";

function newId() {
  return `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DataBundleEditor({
  bundles,
  onChange,
}: {
  bundles: DataBundle[];
  onChange: (next: DataBundle[]) => void;
}) {
  const [draft, setDraft] = useState<Partial<DataBundle>>({
    network: "mtn",
    volume: "2GB",
    validityDays: 30,
    price: 15,
    name: "",
    active: true,
  });
  const [editingId, setEditingId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, DataBundle[]>();
    for (const b of bundles) {
      const list = map.get(b.network) ?? [];
      list.push(b);
      map.set(b.network, list);
    }
    return map;
  }, [bundles]);

  function resetDraft() {
    setDraft({
      network: "mtn",
      volume: "2GB",
      validityDays: 30,
      price: 15,
      name: "",
      active: true,
    });
    setEditingId(null);
  }

  function addOrUpdate() {
    const network = (draft.network ?? "mtn") as DataNetworkId;
    const volumeRaw = (draft.volume ?? "").trim();
    const normalized = normalizeVolume(volumeRaw);
    if (!normalized) {
      alert("Volume must be like 1GB or 500MB");
      return;
    }
    const validity = Number(draft.validityDays ?? 30);
    if (!Number.isInteger(validity) || validity < 1 || validity > 365) {
      alert("Validity must be 1–365 days");
      return;
    }
    const price = Number(draft.price ?? 0);
    if (!Number.isFinite(price) || price < 0) {
      alert("Price must be 0 or more");
      return;
    }
    const name =
      draft.name?.trim() ||
      autoBundleName({ network, volume: normalized, validityDays: validity });

    if (editingId) {
      const next = bundles.map((b) =>
        b.id === editingId
          ? {
              ...b,
              network,
              volume: normalized,
              validityDays: validity,
              price,
              name,
              description: draft.description,
              active: draft.active ?? true,
            }
          : b,
      );
      onChange(next);
      resetDraft();
      return;
    }

    const bundle: DataBundle = {
      id: newId(),
      network,
      volume: normalized,
      validityDays: validity,
      price,
      name,
      description: draft.description,
      active: draft.active ?? true,
    };
    onChange([...bundles, bundle]);
    resetDraft();
  }

  function edit(bundle: DataBundle) {
    setEditingId(bundle.id);
    setDraft({
      network: bundle.network,
      volume: bundle.volume,
      validityDays: bundle.validityDays,
      price: bundle.price,
      name: bundle.name,
      description: bundle.description,
      active: bundle.active,
    });
  }

  function remove(id: string) {
    onChange(bundles.filter((b) => b.id !== id));
    if (editingId === id) resetDraft();
  }

  function toggleActive(id: string) {
    onChange(
      bundles.map((b) => (b.id === id ? { ...b, active: !b.active } : b)),
    );
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-line bg-white p-4">
        <h4 className="text-sm font-semibold text-navy">
          {editingId ? "Edit data bundle" : "Add a data bundle"}
        </h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-xs font-semibold">Network</span>
            <select
              value={draft.network ?? "mtn"}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  network: e.target.value as DataNetworkId,
                }))
              }
              className="rounded-lg border border-line px-3 py-2 text-sm"
            >
              {DATA_NETWORKS.map((net) => (
                <option key={net.id} value={net.id}>
                  {net.label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="text-xs font-semibold">Volume</span>
            <input
              value={draft.volume ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, volume: e.target.value }))
              }
              placeholder="e.g. 2GB, 500MB"
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-xs font-semibold">Validity (days)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={draft.validityDays ?? 30}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  validityDays: Number(e.target.value),
                }))
              }
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-xs font-semibold">Price (GHS)</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={draft.price ?? 0}
              onChange={(e) =>
                setDraft((d) => ({ ...d, price: Number(e.target.value) }))
              }
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>

          <label className="grid gap-1 sm:col-span-2">
            <span className="text-xs font-semibold">Name (auto if empty)</span>
            <input
              value={draft.name ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
              placeholder="e.g. MTN 2GB - 30 days"
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>

          <label className="grid gap-1 sm:col-span-2">
            <span className="text-xs font-semibold">
              Description (optional)
            </span>
            <input
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
              placeholder="e.g. Best for streaming"
              className="rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.active ?? true}
              onChange={(e) =>
                setDraft((d) => ({ ...d, active: e.target.checked }))
              }
            />
            <span className="text-xs">Active (shown to customers)</span>
          </label>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={addOrUpdate}
            className="btn-primary px-4 py-2 text-sm"
          >
            {editingId ? "Save changes" : "Add bundle"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetDraft}
              className="btn-secondary px-4 py-2 text-sm"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {bundles.length === 0 ? (
        <p className="text-xs text-slate-500">
          No data bundles yet. Add one above.
        </p>
      ) : (
        <div className="grid gap-3">
          {Array.from(grouped.entries()).map(([network, list]) => {
            const colors = dataNetworkColors(network);
            return (
              <div key={network} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-bold"
                    style={{ background: colors.bg, color: colors.fg }}
                  >
                    {dataNetworkLabel(network)}
                  </span>
                  <span className="text-xs text-slate-500">
                    {list.length} bundle{list.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="mt-2 grid gap-2">
                  {list.map((b) => (
                    <li
                      key={b.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-ivory-50 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">
                          {b.name}{" "}
                          {!b.active && (
                            <span className="text-xs font-normal text-slate-500">
                              (hidden)
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-600">
                          {b.volume} • {b.validityDays} day
                          {b.validityDays === 1 ? "" : "s"} • GH₵{b.price}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => edit(b)}
                          className="rounded-md border border-line bg-white px-2 py-1 text-xs"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleActive(b.id)}
                          className="rounded-md border border-line bg-white px-2 py-1 text-xs"
                        >
                          {b.active ? "Hide" : "Show"}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(b.id)}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700"
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
