"use client";

import { useState, useEffect } from "react";
import { apiMutation, apiDelete, ApiError } from "@/lib/client-api";

interface DomainView {
  hostname: string;
  status: string;
  verifiedAt?: string | null;
  lastCheckedAt?: string | null;
  records?: {
    txt: { name: string; value: string };
    cname: { name: string; target: string | null };
  };
  detail?: string;
}

function Mono({ children }: { children: string }) {
  return (
    <span className="rounded bg-slate-200 px-1 font-mono break-all select-all">
      {children}
    </span>
  );
}

export function CustomDomainCard({ draftId }: { draftId: string }) {
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState<DomainView | null>(null);
  const [input, setInput] = useState("");
  const [checkLoading, setCheckLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(`/api/studio/drafts/${draftId}/domain`);
        if (!response.ok) throw new Error("Failed to load");
        const data = (await response.json()) as DomainView | null;
        setDomain(data);
        if (data) setInput(data.hostname);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [draftId]);

  const onSave = async () => {
    if (!input.trim()) {
      if (domain) {
        try {
          await apiDelete(`/api/studio/drafts/${draftId}/domain`);
          setDomain(null);
          setInput("");
        } catch (err) {
          setError(
            err instanceof ApiError ? err.message : "Failed to remove domain",
          );
        }
      }
      return;
    }

    setCheckLoading(true);
    setError(null);
    try {
      const result = await apiMutation<DomainView>(
        `/api/studio/drafts/${draftId}/domain`,
        {
          hostname: input.trim(),
        },
      );
      setDomain(result);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to check domain",
      );
    } finally {
      setCheckLoading(false);
    }
  };

  if (loading)
    return (
      <div
        id="custom-domain-card"
        className="mt-4 h-32 scroll-mt-24 animate-pulse rounded-xl border border-line bg-white p-4"
      />
    );

  const cnameTarget =
    domain?.records?.cname.target ??
    process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST ??
    null;

  return (
    <section
      id="custom-domain-card"
      className="mt-4 scroll-mt-24 rounded-xl border border-line bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-navy">Custom domain</h2>
      <div className="mt-3 grid gap-2">
        <label htmlFor="custom-domain" className="sr-only">
          Domain name
        </label>
        <div className="flex gap-2">
          <input
            id="custom-domain"
            type="text"
            placeholder="e.g. akwaababites.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-lg border border-line px-3 py-1.5 text-sm"
          />
        </div>
        {domain && domain.records && (
          <div className="mt-2 grid gap-3 rounded bg-slate-50 p-3 text-xs text-slate-700">
            <div>
              <p className="font-semibold">
                1. Prove you own the domain — add this TXT record at your
                registrar:
              </p>
              <p className="mt-1">
                Name: <Mono>{domain.records.txt.name}</Mono>
              </p>
              <p className="mt-1">
                Value: <Mono>{domain.records.txt.value}</Mono>
              </p>
            </div>
            <div>
              <p className="font-semibold">
                2. Point the domain at Valmont — add this CNAME record:
              </p>
              <p className="mt-1">
                Name: <Mono>{domain.records.cname.name}</Mono>
              </p>
              <p className="mt-1">
                Target:{" "}
                {cnameTarget ? (
                  <Mono>{cnameTarget}</Mono>
                ) : (
                  <span className="text-amber-700">
                    not configured on this server yet
                  </span>
                )}
              </p>
            </div>
            {domain.detail && (
              <p className="text-slate-600" data-testid="domain-detail">
                {domain.detail}
              </p>
            )}
            {!cnameTarget && (
              <p className="text-[10px] text-amber-600">
                Note: The public Valmont address isn&apos;t configured on this
                machine, so the domain cannot be connected here yet.
              </p>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={onSave}
            disabled={checkLoading}
            className="btn-primary px-3 py-1 text-xs"
          >
            {checkLoading
              ? "Checking..."
              : input.trim()
                ? domain
                  ? "Check again"
                  : "Check my domain"
                : "Remove"}
          </button>
          {domain && (
            <span
              className="rounded bg-slate-100 px-2 py-1 text-xs font-medium"
              data-testid="domain-status"
            >
              {domain.status === "not_set"
                ? "Not set"
                : domain.status === "pending"
                  ? "Waiting for DNS"
                  : domain.status === "active"
                    ? "Connected"
                    : "Problem"}
            </span>
          )}
        </div>
        <p className="mt-3 text-[10px] text-slate-500">
          Both records are required. Ownership is re-checked from time to time,
          so keep the TXT record in place. The security padlock turns on
          automatically once your domain is connected and your site is running
          on the public Valmont server.
        </p>
      </div>
    </section>
  );
}
