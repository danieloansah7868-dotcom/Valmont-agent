"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiMutation } from "@/lib/client-api";
import { categories } from "@/lib/studio/categories";
import {
  ECOM_SUBCATEGORIES,
  ecomSubcategoryLabel,
  isCategoryId,
  type CategoryId,
  type EcomSubcategoryId,
} from "@/lib/studio/categories";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { defaultTemplateForCategory } from "@/lib/studio/templates";
import type { StudioDraft } from "@/lib/studio/site-brief/schema";

/**
 * Collects the two things a draft cannot be created without, then creates it.
 * Creation happens on submit (a POST), never on page load, so simply visiting
 * the page does not change anything.
 */
export function NewDraftForm() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [category, setCategory] = useState<CategoryId>("business-profile");
  const [ecomSubcategory, setEcomSubcategory] = useState<
    EcomSubcategoryId | ""
  >("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const brief = createDefaultBrief({
        businessName: businessName.trim() || undefined,
        category,
        ecomSubcategory:
          category === "online-shop" && ecomSubcategory
            ? ecomSubcategory
            : undefined,
        selectedTemplate: defaultTemplateForCategory(category),
      });
      const draft = await apiMutation<StudioDraft>("/api/studio/drafts", brief);
      router.push(`/studio/drafts/${draft.id}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start the draft. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="grid gap-1">
        <label htmlFor="new-business-name" className="text-sm font-semibold">
          Business name
        </label>
        <input
          id="new-business-name"
          name="businessName"
          value={businessName}
          onChange={(event) => setBusinessName(event.target.value)}
          placeholder="e.g. Adom Fashion House"
          autoComplete="organization"
          className="w-full rounded-lg border border-line px-3 py-2 text-base"
        />
        <p className="text-xs text-slate-500">
          You can change this later. Leave it blank to start with a placeholder.
        </p>
      </div>

      <div className="grid gap-1">
        <label htmlFor="new-category" className="text-sm font-semibold">
          What kind of website is this?
        </label>
        <select
          id="new-category"
          name="category"
          value={category}
          onChange={(event) => {
            const next = event.target.value;
            if (isCategoryId(next)) setCategory(next);
          }}
          className="w-full rounded-lg border border-line px-3 py-2 text-base"
        >
          {categories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {category === "online-shop" && (
        <div className="grid gap-1">
          <label htmlFor="new-subcategory" className="text-sm font-semibold">
            What does the shop sell?
          </label>
          <select
            id="new-subcategory"
            name="ecomSubcategory"
            value={ecomSubcategory}
            onChange={(event) =>
              setEcomSubcategory(event.target.value as EcomSubcategoryId | "")
            }
            className="w-full rounded-lg border border-line px-3 py-2 text-base"
          >
            <option value="">Not sure yet</option>
            {ECOM_SUBCATEGORIES.map((sub) => (
              <option key={sub} value={sub}>
                {ecomSubcategoryLabel(sub)}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="btn-primary inline-flex w-full justify-center sm:w-auto"
        data-testid="create-draft"
      >
        {busy ? "Starting…" : "Create draft"}
      </button>
    </form>
  );
}
