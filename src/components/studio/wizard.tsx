"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ApiError, apiDelete, apiPatch } from "@/lib/client-api";
import { BusinessPreview } from "./business-preview";
import {
  categories,
  ECOM_SUBCATEGORIES,
  ecomSubcategoryLabel,
  isCategoryId,
  type EcomSubcategoryId,
} from "@/lib/studio/categories";
import { packages } from "@/lib/studio/packages";
import { themes } from "@/lib/studio/themes";
import {
  templatesForCategory,
  reconcileTemplate,
} from "@/lib/studio/templates";
import {
  PAYMENT_METHODS,
  REDUNDANT_WHEN_VALMONT_PAY,
  siteBriefSchemaV1,
  type PaymentMethodId,
  type SiteBriefV1,
  type StudioDraft,
  type CatalogItem,
} from "@/lib/studio/site-brief/schema";
import { formatPricedItems, parsePricedItems } from "@/lib/studio/catalog";
import { ShareLinkButton } from "./share-link-button";
import { CustomDomainCard } from "./custom-domain-card";
import { ProductImagesEditor } from "./product-images";
import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import { evaluateSaveGate } from "@/lib/studio/save-gate";
import {
  GHANA_REGIONS,
  SUPPORTED_COUNTRIES,
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIMEZONES,
  formatGhanaPhone,
} from "@/lib/studio/site-brief/defaults";
import { changedFields, mergeBriefs } from "@/lib/studio/merge";
import { AssetUploader } from "./asset-uploader";
import {
  BUNDLE_NETWORKS,
  type BundleNetworkId,
  starterBundleCatalogue,
  mergeStarterBundles,
  formatDataMb,
  bundleNetworkLabel,
} from "@/lib/studio/bundles";

const STEPS = [
  { number: 1, title: "Website type" },
  { number: 2, title: "Package" },
  { number: 3, title: "Look and layout" },
  { number: 4, title: "Business details" },
  { number: 5, title: "Payments and delivery" },
] as const;

type SaveState =
  | { kind: "saved"; at: string }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; fields: string[] };

const AUTOSAVE_DELAY_MS = 600;

function toList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function Wizard({ id, initial }: { id: string; initial: StudioDraft }) {
  const router = useRouter();
  const [brief, setBrief] = useState<SiteBriefV1>(initial.brief);
  const [step, setStep] = useState<number>(1);
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "saved",
    at: initial.updatedAt,
  });
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [conflictPair, setConflictPair] = useState<{
    mine: SiteBriefV1;
    theirs: SiteBriefV1;
  } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [serverRevision, setServerRevision] = useState<number>(
    initial.revision,
  );

  const revisionRef = useRef<number>(initial.revision);
  const savedBriefRef = useRef<SiteBriefV1>(initial.brief);
  const pendingRef = useRef<SiteBriefV1 | null>(null);
  const inFlightRef = useRef(false);
  const awaitingConflictChoiceRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const unmountedRef = useRef(false);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!confirmingDelete) return;
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    const cancelButton = dialog.querySelector<HTMLButtonElement>(
      '[data-testid="delete-draft-cancel"]',
    );
    cancelButton?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmingDelete(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const trigger = deleteTriggerRef.current;
      if (trigger && document.body.contains(trigger)) trigger.focus();
    };
  }, [confirmingDelete]);

  const validation = useMemo(() => {
    const result = siteBriefSchemaV1.safeParse(brief);
    if (result.success) return { ok: true as const, issues: [] };
    return {
      ok: false as const,
      issues: result.error.issues.map((issue) => ({
        field: issue.path.join(".") || "form",
        message: issue.message,
      })),
    };
  }, [brief]);

  const completeness = useMemo(() => computeBriefCompleteness(brief), [brief]);

  const handleConflict = useCallback(
    async (mine: SiteBriefV1): Promise<void> => {
      let latest: StudioDraft;
      try {
        const response = await fetch(`/api/studio/drafts/${id}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Could not load the latest version.");
        latest = (await response.json()) as StudioDraft;
      } catch {
        pendingRef.current = mine;
        setSaveState({
          kind: "error",
          message:
            "Someone else saved this draft and we could not load their version. Your changes are still on screen.",
        });
        return;
      }
      revisionRef.current = latest.revision;
      const latestLocal = pendingRef.current ?? mine;
      const outcome = mergeBriefs(
        savedBriefRef.current,
        latestLocal,
        latest.brief,
      );
      savedBriefRef.current = latest.brief;
      if (outcome.merged) {
        setBrief(outcome.merged);
        pendingRef.current = outcome.merged;
        return;
      }
      awaitingConflictChoiceRef.current = true;
      setConflictPair({ mine: latestLocal, theirs: latest.brief });
      setSaveState({
        kind: "conflict",
        fields: outcome.conflictingFields.map(String),
      });
    },
    [id],
  );

  const flush = useCallback(async (): Promise<void> => {
    const outgoing = pendingRef.current;
    const decision = evaluateSaveGate({
      inFlight: inFlightRef.current,
      awaitingConflictChoice: awaitingConflictChoiceRef.current,
      hasPendingEdit: outgoing !== null,
      isValid:
        outgoing !== null && siteBriefSchemaV1.safeParse(outgoing).success,
    });
    if (!decision.send || !outgoing) return;
    inFlightRef.current = true;
    pendingRef.current = null;
    setSaveState({ kind: "saving" });
    try {
      const updated = await apiPatch<StudioDraft>(`/api/studio/drafts/${id}`, {
        ...outgoing,
        expectedRevision: revisionRef.current,
      });
      revisionRef.current = updated.revision;
      savedBriefRef.current = updated.brief;
      if (!unmountedRef.current) {
        setPendingCount(0);
        setServerRevision(updated.revision);
        setSaveState({ kind: "saved", at: updated.updatedAt });
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not save your changes.";
      const isConflict = cause instanceof ApiError && cause.status === 409;
      if (isConflict) {
        await handleConflict(outgoing);
      } else if (!unmountedRef.current) {
        pendingRef.current = pendingRef.current ?? outgoing;
        setSaveState({ kind: "error", message });
      }
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current && !unmountedRef.current) {
        void flushRef.current();
      }
    }
  }, [id, handleConflict]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const update = useCallback(
    (patch: Partial<SiteBriefV1>) => {
      setBrief((current) => {
        const next = { ...current, ...patch } as SiteBriefV1;
        pendingRef.current = next;
        setPendingCount(changedFields(savedBriefRef.current, next).length);
        return next;
      });
      setSaveState((current) =>
        current.kind === "conflict" ? current : { kind: "unsaved" },
      );
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  const finishAndLeave = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await flush();
    if (pendingRef.current === null && !awaitingConflictChoiceRef.current) {
      router.push("/studio");
    }
  }, [flush, router]);

  const changeCategory = useCallback(
    (categoryId: string) => {
      if (!isCategoryId(categoryId)) return;
      update({
        category: categoryId,
        selectedTemplate: reconcileTemplate(categoryId, brief.selectedTemplate),
        ecomSubcategory:
          categoryId === "online-shop" ? brief.ecomSubcategory : undefined,
      });
    },
    [brief.ecomSubcategory, brief.selectedTemplate, update],
  );

  const keepMine = useCallback(() => {
    if (!conflictPair) return;
    awaitingConflictChoiceRef.current = false;
    setConflictPair(null);
    const latest = pendingRef.current ?? conflictPair.mine;
    pendingRef.current = latest;
    setSaveState({ kind: "unsaved" });
    void flush();
  }, [conflictPair, flush]);

  const takeTheirs = useCallback(() => {
    if (!conflictPair) return;
    awaitingConflictChoiceRef.current = false;
    setConflictPair(null);
    setBrief(conflictPair.theirs);
    savedBriefRef.current = conflictPair.theirs;
    pendingRef.current = null;
    setPendingCount(0);
    setSaveState({ kind: "saved", at: new Date().toISOString() });
  }, [conflictPair]);

  async function removeDraft() {
    setDeleting(true);
    try {
      await apiDelete(`/api/studio/drafts/${id}`);
      router.push("/studio");
      router.refresh();
    } catch (cause) {
      setDeleting(false);
      setSaveState({
        kind: "error",
        message:
          cause instanceof Error
            ? cause.message
            : "Could not delete the draft.",
      });
    }
  }

  const availableTemplates = templatesForCategory(brief.category);
  const isBundleSite = brief.category === "data-bundles";

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-navy sm:text-2xl">
          {brief.businessName || "Untitled website"}
        </h1>
        <ShareLinkButton draftId={id} compact />
        <span
          data-testid="save-state"
          role="status"
          aria-live="polite"
          className="text-xs text-slate-600"
        >
          {saveState.kind === "saved" && "All changes saved"}
          {saveState.kind === "saving" && "Saving…"}
          {saveState.kind === "unsaved" &&
            `Not saved yet (${pendingCount} change${pendingCount === 1 ? "" : "s"})`}
          {saveState.kind === "error" && `Not saved: ${saveState.message}`}
          {saveState.kind === "conflict" && "Someone else edited this draft"}
        </span>
      </div>

      {saveState.kind === "error" && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          <p>{saveState.message}</p>
          <button
            type="button"
            onClick={() => void flush()}
            className="mt-2 underline"
          >
            Try saving again
          </button>
        </div>
      )}

      {saveState.kind === "conflict" && (
        <div
          role="alert"
          data-testid="conflict-banner"
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <p className="font-semibold">
            This draft was also changed somewhere else.
          </p>
          <p className="mt-1">
            Both versions changed: {saveState.fields.join(", ")}. Nothing has
            been thrown away. Choose which version to keep.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <button type="button" onClick={keepMine} className="underline">
              Keep what is on this screen
            </button>
            <button type="button" onClick={takeTheirs} className="underline">
              Use the other version instead
            </button>
          </div>
        </div>
      )}

      <nav aria-label="Wizard steps" className="mt-5">
        <p className="mb-2 text-xs font-semibold text-slate">
          Step {step} of {STEPS.length} — {STEPS[step - 1]?.title}
        </p>
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((item) => (
            <li key={item.number}>
              <button
                type="button"
                onClick={() => setStep(item.number)}
                aria-current={step === item.number ? "step" : undefined}
                className={`rounded-lg px-3 py-2 text-sm ${
                  step === item.number
                    ? "bg-navy text-white"
                    : "bg-slate-100 text-navy"
                }`}
              >
                <span className="sr-only">Step </span>
                {item.number}. {item.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="min-w-0">
          {step === 1 && (
            <fieldset className="grid gap-3">
              <legend className="text-sm font-semibold">
                What kind of website is this?
              </legend>
              <label htmlFor="category" className="text-sm">
                Website type
              </label>
              <select
                id="category"
                value={brief.category}
                onChange={(event) => changeCategory(event.target.value)}
                className="w-full rounded-lg border border-line px-3 py-2 text-base"
              >
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>

              {brief.category === "online-shop" && (
                <>
                  <label htmlFor="ecomSubcategory" className="text-sm">
                    What does the shop sell?
                  </label>
                  <select
                    id="ecomSubcategory"
                    value={brief.ecomSubcategory ?? ""}
                    onChange={(event) =>
                      update({
                        ecomSubcategory:
                          (event.target.value as EcomSubcategoryId) ||
                          undefined,
                      })
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
                </>
              )}
              <p className="text-xs text-slate-500">
                Changing the website type keeps every business detail you have
                already entered.
              </p>
            </fieldset>
          )}

          {step === 2 && (
            <fieldset className="grid gap-3">
              <legend className="text-sm font-semibold">
                Which package do you want?
              </legend>
              {packages.map((item) => (
                <label
                  key={item.id}
                  className="flex items-start gap-3 rounded-lg border border-line p-3"
                >
                  <input
                    type="radio"
                    name="selectedPackage"
                    value={item.id}
                    checked={brief.selectedPackage === item.id}
                    onChange={() => update({ selectedPackage: item.id })}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-semibold">
                      {item.label}
                    </span>
                    <span className="block text-xs text-slate-600">
                      Up to {item.limits.maxPages} pages,{" "}
                      {item.limits.maxProducts} products
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {step === 3 && (
            <div className="grid gap-6">
              <fieldset className="grid gap-3">
                <legend className="text-sm font-semibold">
                  Colours and style
                </legend>
                {themes.map((theme) => (
                  <label
                    key={theme.id}
                    className="flex items-center gap-3 rounded-lg border border-line p-3"
                  >
                    <input
                      type="radio"
                      name="selectedTheme"
                      value={theme.id}
                      checked={brief.selectedTheme === theme.id}
                      onChange={() => update({ selectedTheme: theme.id })}
                    />
                    <span className="text-sm">{theme.label}</span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="grid gap-3">
                <legend className="text-sm font-semibold">Page layout</legend>
                {availableTemplates.map((template) => (
                  <label
                    key={template.id}
                    className="flex items-start gap-3 rounded-lg border border-line p-3"
                  >
                    <input
                      type="radio"
                      name="selectedTemplate"
                      value={template.id}
                      checked={brief.selectedTemplate === template.id}
                      onChange={() => update({ selectedTemplate: template.id })}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-semibold">
                        {template.label}
                      </span>
                      <span className="block text-xs text-slate-600">
                        {template.description}
                      </span>
                    </span>
                  </label>
                ))}
                <p className="text-xs text-slate-500">
                  Only layouts that suit a{" "}
                  {categories.find((c) => c.id === brief.category)?.label ??
                    "website"}{" "}
                  are shown.
                </p>
              </fieldset>

              <section className="rounded-lg border border-line bg-white p-3">
                <h3 className="text-sm font-semibold text-navy">
                  Logo and photos
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Pictures you upload stay with this draft and show up in the
                  preview. They are included when you download a backup.
                </p>
                <div className="mt-3">
                  <AssetUploader
                    draftId={id}
                    assets={brief.assets ?? { logo: null, photos: [] }}
                    expectedRevision={serverRevision}
                    onSaved={({ assets, revision }) => {
                      revisionRef.current = revision;
                      const merged = { ...brief, assets };
                      setBrief(merged);
                      savedBriefRef.current = merged;
                      pendingRef.current = null;
                      setPendingCount(0);
                      setServerRevision(revision);
                      setSaveState({
                        kind: "saved",
                        at: new Date().toISOString(),
                      });
                    }}
                    onError={() => {}}
                  />
                </div>
              </section>
            </div>
          )}

          {step === 4 && (
            <div className="grid gap-4">
              <TextField
                id="businessName"
                label="Business name"
                required
                value={brief.businessName}
                onChange={(value) => update({ businessName: value })}
              />
              <TextField
                id="tagline"
                label="Tagline"
                value={brief.tagline ?? ""}
                onChange={(value) => update({ tagline: value || undefined })}
                hint="One short line that sums up the business."
              />
              <TextArea
                id="description"
                label="What does the business do?"
                value={brief.description ?? ""}
                onChange={(value) =>
                  update({ description: value || undefined })
                }
              />
              <TextField
                id="adminEmail"
                label="Admin email"
                required
                type="email"
                value={brief.adminEmail}
                onChange={(value) => update({ adminEmail: value })}
                hint="Where Valmont will contact you about this website."
              />
              <TextField
                id="email"
                label="Email shown to customers"
                type="email"
                value={brief.email ?? ""}
                onChange={(value) => update({ email: value || undefined })}
                hint="Optional, and shown on the website. Your admin email stays private."
              />
              <TextField
                id="phone"
                label="Phone number"
                type="tel"
                value={brief.phone ?? ""}
                onChange={(value) =>
                  update({ phone: formatGhanaPhone(value) || undefined })
                }
                hint="Ghana numbers become +233… automatically."
              />
              <TextField
                id="whatsapp"
                label="WhatsApp number"
                type="tel"
                value={brief.whatsapp ?? ""}
                onChange={(value) =>
                  update({ whatsapp: formatGhanaPhone(value) || undefined })
                }
              />
              <TextField
                id="address"
                label="Address"
                value={brief.address ?? ""}
                onChange={(value) => update({ address: value || undefined })}
              />

              <div className="grid gap-1">
                <label htmlFor="ghanaRegion" className="text-sm font-semibold">
                  Region
                </label>
                <select
                  id="ghanaRegion"
                  value={brief.ghanaRegion ?? ""}
                  onChange={(event) =>
                    update({ ghanaRegion: event.target.value || undefined })
                  }
                  className="w-full rounded-lg border border-line px-3 py-2 text-base"
                >
                  <option value="">Choose a region</option>
                  {GHANA_REGIONS.map((region) => (
                    <option key={region} value={region}>
                      {region}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="grid gap-3 rounded-lg border border-line p-3">
                <legend className="text-sm font-semibold">
                  Country, currency and timezone
                </legend>
                <div className="grid gap-1">
                  <label htmlFor="country" className="text-sm font-semibold">
                    Country
                  </label>
                  <select
                    id="country"
                    value={brief.country}
                    onChange={(event) =>
                      update({ country: event.target.value })
                    }
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  >
                    {SUPPORTED_COUNTRIES.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1">
                  <label htmlFor="currency" className="text-sm font-semibold">
                    Currency
                  </label>
                  <select
                    id="currency"
                    value={brief.currency}
                    onChange={(event) =>
                      update({ currency: event.target.value })
                    }
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  >
                    {SUPPORTED_CURRENCIES.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1">
                  <label htmlFor="timezone" className="text-sm font-semibold">
                    Timezone
                  </label>
                  <select
                    id="timezone"
                    value={brief.timezone}
                    onChange={(event) =>
                      update({ timezone: event.target.value })
                    }
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  >
                    {SUPPORTED_TIMEZONES.map((timezone) => (
                      <option key={timezone} value={timezone}>
                        {timezone}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-slate-500">
                  Ghana, GHS (GH₵) and Africa/Accra are the starting defaults.
                </p>
              </fieldset>

              <TextField
                id="hours"
                label="Opening hours"
                value={brief.hours ?? ""}
                onChange={(value) => update({ hours: value || undefined })}
                hint="e.g. Mon–Sat 8am–6pm"
              />

              {isBundleSite ? (
                <BundleTable
                  items={brief.items}
                  onChange={(items) => update({ items })}
                />
              ) : (
                <>
                  <TextField
                    id="services"
                    label="Services you offer"
                    value={brief.services.join(", ")}
                    onChange={(value) => update({ services: toList(value) })}
                    hint="Separate each one with a comma."
                  />

                  <TextArea
                    id="products"
                    label="Products you sell"
                    value={formatPricedItems(brief.items)}
                    onChange={(value) =>
                      update({ items: parsePricedItems(value, brief.items) })
                    }
                  />
                  <p className="text-xs text-slate-500">
                    One item per line works best, or separate with commas. Add a
                    price with a dash, e.g. Jollof Rice - 45.
                  </p>
                  {brief.items.length > 0 && (
                    <ul
                      data-testid="parsed-items-preview"
                      className="grid gap-1 rounded-lg border border-line bg-ivory-50 p-3 text-sm"
                    >
                      {brief.items.map((item) => (
                        <li
                          key={item.id}
                          className="flex items-center justify-between gap-3"
                        >
                          <span>{item.name}</span>
                          <span className="text-xs font-semibold text-copper">
                            {item.price !== undefined
                              ? `GH₵${item.price}`
                              : "No price — shown as information only"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ProductImagesEditor
                    items={brief.items}
                    onChange={(items) => update({ items })}
                  />
                </>
              )}

              <TextField
                id="serviceAreas"
                label="Areas you serve"
                value={brief.serviceAreas.join(", ")}
                onChange={(value) => update({ serviceAreas: toList(value) })}
                hint="Towns or regions, separated by commas."
              />

              <TextField
                id="deliveryAreas"
                label="Areas you deliver to"
                value={brief.deliveryAreas.join(", ")}
                onChange={(value) => update({ deliveryAreas: toList(value) })}
                hint="A note for planning only — no delivery is arranged by this app."
              />

              <TextArea
                id="specialInstructions"
                label="Anything else Valmont should know"
                value={brief.specialInstructions ?? ""}
                onChange={(value) =>
                  update({ specialInstructions: value || undefined })
                }
              />
            </div>
          )}

          {step === 5 && (
            <div className="grid gap-4">
              <fieldset className="grid gap-2 rounded-lg border border-line p-3">
                <legend className="text-sm font-semibold">
                  Accept orders and payments
                </legend>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={brief.payments.enabled}
                    onChange={(event) =>
                      update({
                        payments: {
                          ...brief.payments,
                          enabled: event.target.checked,
                        },
                      })
                    }
                    data-testid="payments-enabled"
                  />
                  <span className="text-sm">
                    Turn on a basket and checkout on this website
                  </span>
                </label>
                <p className="text-xs text-slate-600">
                  {isBundleSite
                    ? "Turn on checkout so customers can buy bundles with Mobile Money."
                    : "Add prices to your products in Step 4 so customers can add them to a basket and pay."}
                </p>
              </fieldset>

              <fieldset className="grid gap-2 rounded-lg border border-line p-3">
                <legend className="text-sm font-semibold">
                  Customer accounts (optional)
                </legend>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={brief.features.customerAccounts}
                    onChange={(event) =>
                      update({
                        features: {
                          ...brief.features,
                          customerAccounts: event.target.checked,
                        },
                      })
                    }
                    data-testid="customer-accounts-enabled"
                  />
                  <span className="text-sm">
                    Let customers create an account to track their orders
                  </span>
                </label>
              </fieldset>

              {brief.payments.enabled && (
                <>
                  <fieldset className="grid gap-2 rounded-lg border border-line p-3">
                    <legend className="text-sm font-semibold">
                      How can customers pay?
                    </legend>
                    {PAYMENT_METHODS.filter((method) => {
                      if (
                        brief.payments.methods.includes("valmont_pay") &&
                        REDUNDANT_WHEN_VALMONT_PAY.includes(method.id)
                      ) {
                        return false;
                      }
                      return true;
                    }).map((method) => (
                      <label key={method.id} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={brief.payments.methods.includes(method.id)}
                          onChange={(event) => {
                            let methods: PaymentMethodId[] = event.target
                              .checked
                              ? [...brief.payments.methods, method.id]
                              : brief.payments.methods.filter(
                                  (id) => id !== method.id,
                                );
                            if (
                              method.id === "valmont_pay" &&
                              event.target.checked
                            ) {
                              methods = methods.filter(
                                (id) =>
                                  !REDUNDANT_WHEN_VALMONT_PAY.includes(id),
                              );
                            }
                            update({
                              payments: {
                                ...brief.payments,
                                methods,
                              },
                            });
                          }}
                        />
                        <span>
                          <span className="block text-sm font-semibold">
                            {method.label}
                          </span>
                          <span className="block text-xs text-slate-600">
                            {method.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  {!isBundleSite && (
                    <fieldset className="grid gap-3 rounded-lg border border-line p-3">
                      <legend className="text-sm font-semibold">
                        Delivery
                      </legend>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={brief.payments.delivery.enabled}
                          onChange={(event) =>
                            update({
                              payments: {
                                ...brief.payments,
                                delivery: {
                                  ...brief.payments.delivery,
                                  enabled: event.target.checked,
                                },
                              },
                            })
                          }
                        />
                        <span className="text-sm">Offer delivery</span>
                      </label>

                      {brief.payments.delivery.enabled && (
                        <div className="grid gap-3 sm:grid-cols-3">
                          <NumberField
                            id="deliveryFee"
                            label="Delivery fee"
                            value={brief.payments.delivery.fee}
                            onChange={(value) =>
                              update({
                                payments: {
                                  ...brief.payments,
                                  delivery: {
                                    ...brief.payments.delivery,
                                    fee: value,
                                  },
                                },
                              })
                            }
                          />
                          <NumberField
                            id="minimumOrder"
                            label="Minimum order"
                            value={brief.payments.delivery.minimumOrder}
                            onChange={(value) =>
                              update({
                                payments: {
                                  ...brief.payments,
                                  delivery: {
                                    ...brief.payments.delivery,
                                    minimumOrder: value,
                                  },
                                },
                              })
                            }
                          />
                          <NumberField
                            id="freeDeliveryAbove"
                            label="Free delivery above"
                            value={
                              brief.payments.delivery.freeDeliveryAbove ?? 0
                            }
                            onChange={(value) =>
                              update({
                                payments: {
                                  ...brief.payments,
                                  delivery: {
                                    ...brief.payments.delivery,
                                    freeDeliveryAbove:
                                      value > 0 ? value : undefined,
                                  },
                                },
                              })
                            }
                          />
                        </div>
                      )}
                    </fieldset>
                  )}

                  <fieldset className="grid gap-3 rounded-lg border border-line p-3">
                    <legend className="text-sm font-semibold">
                      Order notifications
                    </legend>
                    <p className="text-xs text-slate-600">
                      Where the business is told about new orders.
                    </p>
                    <TextField
                      id="notifyEmail"
                      label="Email for orders"
                      type="email"
                      value={brief.payments.notifications.email ?? ""}
                      onChange={(value) =>
                        update({
                          payments: {
                            ...brief.payments,
                            notifications: {
                              ...brief.payments.notifications,
                              email: value || undefined,
                            },
                          },
                        })
                      }
                    />
                    <TextField
                      id="notifyWhatsapp"
                      label="WhatsApp for orders"
                      type="tel"
                      value={brief.payments.notifications.whatsapp ?? ""}
                      onChange={(value) =>
                        update({
                          payments: {
                            ...brief.payments,
                            notifications: {
                              ...brief.payments.notifications,
                              whatsapp: formatGhanaPhone(value) || undefined,
                            },
                          },
                        })
                      }
                    />
                  </fieldset>

                  <TextArea
                    id="checkoutNote"
                    label="Message shown at checkout"
                    value={brief.payments.checkoutNote ?? ""}
                    onChange={(value) =>
                      update({
                        payments: {
                          ...brief.payments,
                          checkoutNote: value || undefined,
                        },
                      })
                    }
                  />
                </>
              )}
            </div>
          )}

          {!validation.ok && (
            <div
              role="alert"
              data-testid="validation-errors"
              className="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            >
              <p className="font-semibold">
                Some answers need fixing before this can save:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {validation.issues.map((issue) => (
                  <li key={`${issue.field}-${issue.message}`}>
                    {issue.field}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <nav
            aria-label="Step navigation"
            className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-4"
          >
            <button
              type="button"
              data-testid="step-back"
              onClick={() => setStep((current) => Math.max(1, current - 1))}
              disabled={step === 1}
              className="btn-secondary"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Back
            </button>
            {step < STEPS.length ? (
              <button
                type="button"
                data-testid="step-next"
                onClick={() =>
                  setStep((current) => Math.min(STEPS.length, current + 1))
                }
                className="btn-primary"
              >
                Next: {STEPS[step]?.title}
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                data-testid="step-finish"
                onClick={() => void finishAndLeave()}
                disabled={!validation.ok || saveState.kind === "saving"}
                className="btn-primary"
                title={
                  validation.ok
                    ? undefined
                    : "Fix the highlighted answers first."
                }
              >
                Done — back to my drafts
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            )}
          </nav>
        </div>

        <aside className="min-w-0">
          <section
            aria-labelledby="completeness-heading"
            className="rounded-xl border border-line bg-white p-4"
          >
            <h2
              id="completeness-heading"
              className="text-sm font-semibold text-navy"
            >
              Brief completeness
            </h2>
            <p
              data-testid="completeness-score"
              className="mt-1 text-2xl font-bold"
            >
              {completeness.score}%
            </p>
            <div
              role="progressbar"
              aria-valuenow={completeness.score}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-labelledby="completeness-heading"
              className="mt-2 h-2 w-full rounded bg-slate-200"
            >
              <div
                className="h-2 rounded bg-navy"
                style={{ width: `${completeness.score}%` }}
              />
            </div>
            {completeness.missingRequired.length > 0 && (
              <>
                <h3 className="mt-3 text-xs font-semibold">Still needed</h3>
                <ul
                  data-testid="missing-required"
                  className="mt-1 list-disc pl-5 text-xs text-slate-700"
                >
                  {completeness.missingRequired.map((gap) => (
                    <li key={gap.field}>
                      {gap.label} — {gap.hint}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {completeness.recommended.length > 0 && (
              <>
                <h3 className="mt-3 text-xs font-semibold">Nice to add</h3>
                <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                  {completeness.recommended.map((gap) => (
                    <li key={gap.field}>{gap.label}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <CustomDomainCard draftId={id} />

          <div className="mt-4">
            <BusinessPreview brief={brief} draftId={id} />
          </div>
        </aside>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step <= 1}
            data-testid="wizard-back"
            className="btn-secondary min-h-10 px-3 text-sm"
          >
            Back
          </button>
          {step < STEPS.length ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(STEPS.length, s + 1))}
              data-testid="wizard-next"
              className="btn-primary min-h-10 px-3 text-sm"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void finishAndLeave()}
              disabled={!validation.ok || saveState.kind === "saving"}
              title={
                validation.ok ? undefined : "Fix the highlighted answers first."
              }
              data-testid="done-to-studio"
              className="btn-primary min-h-10 inline-flex items-center gap-2 px-4 text-sm"
            >
              {saveState.kind === "saving" ? "Saving…" : "Done"}
            </button>
          )}
        </div>

        {confirmingDelete ? (
          <div
            ref={deleteDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-heading"
            aria-describedby="delete-confirm-body"
            data-testid="delete-confirm"
            className="w-full rounded-lg border border-red-300 bg-red-50 p-4"
          >
            <h3
              id="delete-confirm-heading"
              className="text-sm font-semibold text-red-900"
            >
              Delete this draft permanently?
            </h3>
            <p id="delete-confirm-body" className="mt-1 text-xs text-red-800">
              This cannot be undone. Everything you entered for this business
              will be removed.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={removeDraft}
                disabled={deleting}
                data-testid="delete-draft-confirm"
                className="min-h-10 rounded-md bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
              >
                {deleting ? "Deleting…" : "Yes, delete it"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                data-testid="delete-draft-cancel"
                className="min-h-10 rounded-md border border-line bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Keep this draft
              </button>
            </div>
          </div>
        ) : (
          <div className="text-right">
            <button
              type="button"
              onClick={(event) => {
                deleteTriggerRef.current = event.currentTarget;
                setConfirmingDelete(true);
              }}
              disabled={deleting}
              data-testid="delete-draft"
              className="text-sm text-red-700 underline"
            >
              Delete this draft
            </button>
            <p className="mt-1 text-xs text-slate-500">
              Deleting removes the draft permanently. Download a backup first if
              you want to keep a copy.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function BundleTable({
  items,
  onChange,
}: {
  items: CatalogItem[];
  onChange: (items: CatalogItem[]) => void;
}) {
  const idCounterRef = useRef(items.length);

  const addBundle = useCallback(() => {
    idCounterRef.current += 1;
    const newId = `bundle-${String(idCounterRef.current).padStart(2, "0")}-${Date.now().toString(36)}`;
    const newItem: CatalogItem = {
      id: newId,
      name: "MTN 1GB",
      price: 10,
      category: "mtn",
      description: "1GB - 30 days",
      bundle: {
        network: "mtn",
        dataMb: 1024,
        validity: "30 days",
      },
    };
    onChange([...items, newItem]);
  }, [items, onChange]);

  const loadStarter = useCallback(() => {
    const merged = mergeStarterBundles(items, starterBundleCatalogue());
    onChange(merged);
  }, [items, onChange]);

  const updateItem = useCallback(
    (
      id: string,
      patch: Partial<Omit<CatalogItem, "bundle">> & {
        bundle?: Partial<NonNullable<CatalogItem["bundle"]>>;
      },
    ) => {
      const next = items.map((it) => {
        if (it.id !== id) return it;
        const nextBundle = patch.bundle
          ? { ...(it.bundle ?? {}), ...patch.bundle }
          : it.bundle;
        let name = it.name;
        if (patch.bundle?.network || patch.bundle?.dataMb !== undefined) {
          const network = (patch.bundle?.network ??
            it.bundle?.network ??
            "mtn") as BundleNetworkId;
          const mb = patch.bundle?.dataMb ?? it.bundle?.dataMb ?? 1024;
          name = `${bundleNetworkLabel(network)} ${formatDataMb(mb)}`;
        }
        if (patch.name) name = patch.name;
        return {
          ...it,
          ...patch,
          bundle: nextBundle,
          name,
          category:
            (patch.bundle?.network as string) ?? patch.category ?? it.category,
        };
      });
      onChange(next as CatalogItem[]);
    },
    [items, onChange],
  );

  const deleteItem = useCallback(
    (id: string) => {
      onChange(items.filter((it) => it.id !== id));
    },
    [items, onChange],
  );

  return (
    <div className="grid gap-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Bundles you sell</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={loadStarter}
            className="rounded-md border border-line bg-white px-2 py-1 text-xs font-semibold hover:bg-slate-50"
            data-testid="load-starter-bundles"
          >
            Load starter price list
          </button>
          <button
            type="button"
            onClick={addBundle}
            className="rounded-md bg-navy px-2 py-1 text-xs font-semibold text-white"
            data-testid="add-bundle"
          >
            Add bundle
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Each bundle needs a network, size and price. Use MB or GB — stored as
        whole MB (1 GB = 1024 MB).
      </p>

      {items.length === 0 ? (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          No bundles yet. Click &quot;Load starter price list&quot; to add 18
          Ghana bundles with placeholder prices, or Add bundle.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-slate-500">
                <th className="p-1">Network</th>
                <th className="p-1">Size</th>
                <th className="p-1">Unit</th>
                <th className="p-1">Price (GHS)</th>
                <th className="p-1">Validity</th>
                <th className="p-1"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const network = (item.bundle?.network ??
                  "mtn") as BundleNetworkId;
                const dataMb = item.bundle?.dataMb ?? 1024;
                const isGb = dataMb % 1024 === 0;
                const displayValue = isGb ? dataMb / 1024 : dataMb;
                const displayUnit = isGb ? "GB" : "MB";
                return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="p-1">
                      <select
                        value={network}
                        onChange={(e) =>
                          updateItem(item.id, {
                            bundle: {
                              network: e.target.value as BundleNetworkId,
                            },
                          })
                        }
                        className="rounded border border-line px-1 py-1 text-xs"
                        data-testid={`bundle-network-${item.id}`}
                      >
                        {BUNDLE_NETWORKS.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        min={0.1}
                        step={displayUnit === "GB" ? 0.5 : 1}
                        value={displayValue}
                        onChange={(e) => {
                          const raw = Number(e.target.value);
                          if (!Number.isFinite(raw) || raw <= 0) return;
                          const mb =
                            displayUnit === "GB"
                              ? Math.round(raw * 1024)
                              : Math.round(raw);
                          if (mb <= 0) return;
                          updateItem(item.id, {
                            bundle: { dataMb: mb },
                          });
                        }}
                        className="w-20 rounded border border-line px-1 py-1 text-xs"
                        data-testid={`bundle-size-${item.id}`}
                      />
                    </td>
                    <td className="p-1">
                      <select
                        value={displayUnit}
                        onChange={(e) => {
                          const newUnit = e.target.value as "MB" | "GB";
                          // Convert current displayValue to new unit's MB
                          const currentMb = dataMb;
                          let newMb: number;
                          if (newUnit === "GB") {
                            // If switching to GB, convert MB to GB rounded to 0.5
                            newMb =
                              (Math.round((currentMb / 1024) * 2) / 2) * 1024;
                            if (newMb < 1024) newMb = 1024;
                          } else {
                            // GB to MB: keep same MB
                            newMb = currentMb;
                          }
                          updateItem(item.id, {
                            bundle: { dataMb: Math.round(newMb) },
                          });
                        }}
                        className="rounded border border-line px-1 py-1 text-xs"
                        data-testid={`bundle-unit-${item.id}`}
                      >
                        <option value="MB">MB</option>
                        <option value="GB">GB</option>
                      </select>
                    </td>
                    <td className="p-1">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={item.price ?? 0}
                        onChange={(e) => {
                          const price = Number(e.target.value);
                          updateItem(item.id, {
                            price: Number.isFinite(price) ? price : 0,
                          });
                        }}
                        className="w-20 rounded border border-line px-1 py-1 text-xs"
                        data-testid={`bundle-price-${item.id}`}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        type="text"
                        value={item.bundle?.validity ?? ""}
                        onChange={(e) =>
                          updateItem(item.id, {
                            bundle: { validity: e.target.value || undefined },
                          })
                        }
                        placeholder="30 days"
                        className="w-24 rounded border border-line px-1 py-1 text-xs"
                        data-testid={`bundle-validity-${item.id}`}
                      />
                    </td>
                    <td className="p-1">
                      <button
                        type="button"
                        onClick={() => deleteItem(item.id)}
                        className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100"
                        data-testid={`delete-bundle-${item.id}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {items.length > 0 && (
        <ul className="grid gap-1 text-xs text-slate-600">
          {items.map((i) => (
            <li key={i.id}>
              {i.name} — {i.bundle ? formatDataMb(i.bundle.dataMb) : "no size"}{" "}
              {i.bundle?.validity ? `• ${i.bundle.validity}` : ""} — GH₵
              {i.price}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  required,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
  type?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
        {required && <span aria-hidden="true"> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        aria-describedby={hintId}
        aria-required={required || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-line px-3 py-2 text-base"
      />
      {hint && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? next : 0);
        }}
        className="w-full rounded-lg border border-line px-3 py-2 text-base"
      />
    </div>
  );
}

function TextArea({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <textarea
        id={id}
        name={id}
        value={value}
        rows={4}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-line px-3 py-2 text-base"
      />
    </div>
  );
}
