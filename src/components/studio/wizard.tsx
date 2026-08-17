/* eslint-disable */
"use client";
import { useState, useEffect, useRef } from "react";
import { BusinessPreview } from "./business-preview";
import { categories } from "@/lib/studio/categories";
import { packages } from "@/lib/studio/packages";
import { themes } from "@/lib/studio/themes";

export function Wizard({ id, initial }: { id: string; initial: any }) {
  const [brief, setBrief] = useState<any>(initial.brief);
  const [rev, setRev] = useState(initial.revision);
  const [status, setStatus] = useState("Saved");
  const [step, setStep] = useState(1);
  const timer = useRef<any>(null);

  const field = (name: string) => ({
    value: brief[name] || "",
    onChange: (e: any) => setBrief({ ...brief, [name]: e.target.value }),
  });

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus("Saving...");
      const csrf = document.cookie.match(/valmont_csrf=([^;]+)/)?.[1] || "";
      try {
        const res = await fetch(`/api/studio/drafts/${id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-valmont-csrf": csrf,
          },
          body: JSON.stringify({ ...brief, expectedRevision: rev }),
        });
        if (res.status === 409) {
          const data = await res.json();
          setStatus("Conflict — reload");
          const fresh = await fetch(`/api/studio/drafts/${id}`).then((r) =>
            r.json(),
          );
          setRev(fresh.revision);
          setStatus("Reloaded, retry");
          return;
        }
        if (res.ok) {
          const d = await res.json();
          setRev(d.revision);
          setStatus("Saved");
        } else setStatus("Error");
      } catch {
        setStatus("Error");
      }
    }, 500);
    return () => clearTimeout(timer.current);
  }, [brief]);

  return (
    <div className="grid gap-6 p-6">
      <div className="flex gap-2 text-sm">
        {[1, 2, 3, 4].map((n) => (
          <button
            key={n}
            onClick={() => setStep(n)}
            className={`px-3 py-1 rounded ${step === n ? "bg-navy text-white" : "bg-slate-100"}`}
            aria-label={`Step ${n}`}
          >
            Step {n}
          </button>
        ))}
        <span className="ml-auto text-xs">
          {status} • rev {rev} • Brief completeness
        </span>
      </div>
      {step === 1 && (
        <div className="grid gap-2">
          <label htmlFor="category" className="text-sm font-semibold">
            Category
          </label>
          <select
            id="category"
            value={brief.category}
            onChange={(e) => setBrief({ ...brief, category: e.target.value })}
            className="border p-2"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {brief.category === "online-shop" && (
            <select
              value={brief.ecomSubcategory || ""}
              onChange={(e) =>
                setBrief({ ...brief, ecomSubcategory: e.target.value })
              }
              className="border p-2"
            >
              <option value="">— subtype —</option>
              <option value="fashion">fashion</option>
              <option value="gadgets">gadgets</option>
            </select>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="grid gap-2">
          <label className="text-sm font-semibold">Package</label>
          {packages.map((p) => (
            <label key={p.id} className="flex gap-2">
              <input
                type="radio"
                name="pkg"
                checked={brief.selectedPackage === p.id}
                onChange={() => setBrief({ ...brief, selectedPackage: p.id })}
              />{" "}
              {p.label}
            </label>
          ))}
        </div>
      )}
      {step === 3 && (
        <div className="grid gap-2">
          <label className="text-sm font-semibold">Theme</label>
          {themes.map((t) => (
            <label key={t.id} className="flex gap-2">
              <input
                type="radio"
                name="theme"
                checked={brief.selectedTheme === t.id}
                onChange={() => setBrief({ ...brief, selectedTheme: t.id })}
              />{" "}
              {t.label}
            </label>
          ))}
        </div>
      )}
      {step === 4 && (
        <div className="grid gap-3">
          <label htmlFor="businessName" className="text-sm font-semibold">
            Business name *
          </label>
          <input
            id="businessName"
            {...field("businessName")}
            className="border p-2"
          />
          <label htmlFor="adminEmail" className="text-sm font-semibold">
            Admin email *
          </label>
          <input
            id="adminEmail"
            {...field("adminEmail")}
            className="border p-2"
          />
          <label htmlFor="phone" className="text-sm font-semibold">
            Phone +233
          </label>
          <input
            id="phone"
            {...field("phone")}
            placeholder="+233..."
            className="border p-2"
          />
          <label htmlFor="services" className="text-sm font-semibold">
            Services (comma separated)
          </label>
          <input
            id="services"
            value={(brief.services || []).join(", ")}
            onChange={(e) =>
              setBrief({
                ...brief,
                services: e.target.value
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean),
              })
            }
            className="border p-2"
          />
          <label htmlFor="products" className="text-sm font-semibold">
            Products (comma separated)
          </label>
          <input
            id="products"
            value={(brief.products || []).map((p: any) => p.name).join(", ")}
            onChange={(e) =>
              setBrief({
                ...brief,
                products: e.target.value
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean)
                  .map((n: string) => ({ name: n })),
              })
            }
            className="border p-2"
          />
          <label htmlFor="paymentNotes" className="text-sm font-semibold">
            Payment preferences (planning only — not operational)
          </label>
          <input
            id="paymentNotes"
            {...field("paymentNotes")}
            placeholder="e.g. MoMo, Paystack — future only"
            className="border p-2"
          />
          <p className="text-xs text-slate-500">
            Ghana defaults: country Ghana, currency GHS, timezone Africa/Accra.
            Delivery/service areas configurable. Mobile Money / Paystack not
            operational in Phase 1.
          </p>
        </div>
      )}
      <BusinessPreview brief={brief} />
      <button
        onClick={async () => {
          if (prompt("Type DELETE") === "DELETE") {
            const csrf =
              document.cookie.match(/valmont_csrf=([^;]+)/)?.[1] || "";
            await fetch(`/api/studio/drafts/${id}`, {
              method: "DELETE",
              headers: { "x-valmont-csrf": csrf },
            });
            location.href = "/studio";
          }
        }}
        className="text-sm text-red-600 underline"
      >
        Delete draft
      </button>
    </div>
  );
}
