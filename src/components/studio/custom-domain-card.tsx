"use client";

import { useState, useEffect } from "react";
import { apiMutation, apiDelete, ApiError } from "@/lib/client-api";

export function CustomDomainCard({ draftId }: { draftId: string }) {
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState<{
    hostname: string;
    status: string;
  } | null>(null);
  const [input, setInput] = useState("");
  const [checkLoading, setCheckLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(`/api/studio/drafts/${draftId}/domain`);
        if (!response.ok) throw new Error("Failed to load");
        const data = await response.json();
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
      const result = await apiMutation<{ hostname: string; status: string }>(
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
        {domain && (
          <div className="mt-2 rounded bg-slate-50 p-3 text-xs text-slate-700">
            <p className="font-semibold">
              Set this CNAME record at your registrar:
            </p>
            <p className="mt-1">
              Host:{" "}
              <span className="font-mono bg-slate-200 px-1 rounded">www</span>{" "}
              (or <span className="font-mono bg-slate-200 px-1 rounded">@</span>
              )
            </p>
            <p className="mt-1">
              Target:{" "}
              <span className="font-mono bg-slate-200 px-1 rounded">
                {process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST || "valmont.test"}
              </span>
            </p>
            {!process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST && (
              <p className="mt-2 text-[10px] text-amber-600">
                Note: The public Valmont address isn&apos;t configured on this
                machine.
              </p>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={onSave}
            disabled={checkLoading}
            className="btn-primary text-xs py-1 px-3"
          >
            {checkLoading
              ? "Checking..."
              : input.trim()
                ? "Check my domain"
                : "Remove"}
          </button>
          {domain && (
            <span className="text-xs font-medium px-2 py-1 rounded bg-slate-100">
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
          The security padlock turns on automatically once your domain is
          connected and your site is running on the public Valmont server.
        </p>
      </div>
    </section>
  );
}
