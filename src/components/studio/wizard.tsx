"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiDelete, apiPatch } from "@/lib/client-api";
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
  siteBriefSchemaV1,
  type SiteBriefV1,
  type StudioDraft,
} from "@/lib/studio/site-brief/schema";
import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import {
  GHANA_REGIONS,
  PAYMENT_PLANNING_NOTICE,
  PLANNED_PAYMENT_METHODS,
  formatGhanaPhone,
} from "@/lib/studio/site-brief/defaults";
import { changedFields, mergeBriefs } from "@/lib/studio/merge";

const STEPS = [
  { number: 1, title: "Website type" },
  { number: 2, title: "Package" },
  { number: 3, title: "Look and layout" },
  { number: 4, title: "Business details" },
] as const;

type SaveState =
  | { kind: "saved"; at: string }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; fields: string[] };

const AUTOSAVE_DELAY_MS = 600;

/** Comma-separated text <-> list of trimmed values. */
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
  /** Both versions kept side by side while the person decides. */
  const [conflictPair, setConflictPair] = useState<{
    mine: SiteBriefV1;
    theirs: SiteBriefV1;
  } | null>(null);
  /** Number of unsaved field changes, tracked in state so render stays pure. */
  const [pendingCount, setPendingCount] = useState(0);

  /**
   * Everything the save loop needs lives in refs so the loop never restarts
   * mid-flight and never captures a stale copy of the Brief.
   */
  const revisionRef = useRef<number>(initial.revision);
  /** The version last confirmed by the server — the base for any merge. */
  const savedBriefRef = useRef<SiteBriefV1>(initial.brief);
  /** Latest on-screen version waiting to be written. */
  const pendingRef = useRef<SiteBriefV1 | null>(null);
  /** True while a request is in flight: this is what serializes saving. */
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Lets the save loop re-enter itself without becoming its own dependency. */
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const unmountedRef = useRef(false);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const validation = useMemo(() => {
    const result = siteBriefSchemaV1.safeParse(brief);
    if (result.success) return { ok: true as const, issues: [] };
    return {
      ok: false as const,
      // Field paths and Zod's own wording only — never the value entered.
      issues: result.error.issues.map((issue) => ({
        field: issue.path.join(".") || "form",
        message: issue.message,
      })),
    };
  }, [brief]);

  const completeness = useMemo(() => computeBriefCompleteness(brief), [brief]);

  /**
   * A 409 means somebody else saved first. We fetch their version, then try to
   * replay our pending edit on top of it. If the two edits touched different
   * fields the replay is safe and happens automatically. If they touched the
   * same field we stop and ask, because either answer would throw away real
   * work. Nothing is discarded without the person choosing.
   */
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
      const outcome = mergeBriefs(savedBriefRef.current, mine, latest.brief);
      savedBriefRef.current = latest.brief;

      if (outcome.merged) {
        // Safe: replay our fields on their version and retry exactly once.
        setBrief(outcome.merged);
        pendingRef.current = outcome.merged;
        return;
      }

      // Overlapping edits: show both options rather than pick for them.
      setConflictPair({ mine, theirs: latest.brief });
      setSaveState({
        kind: "conflict",
        fields: outcome.conflictingFields.map(String),
      });
    },
    [id],
  );

  /**
   * Sends exactly one save at a time. If edits arrive while a request is in
   * flight they queue in `pendingRef` and are written by the next pass, so
   * requests can never overtake one another and clobber a newer value.
   */
  const flush = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    const outgoing = pendingRef.current;
    if (!outgoing) return;

    // Never send something the server would reject; wait for it to be valid.
    if (!siteBriefSchemaV1.safeParse(outgoing).success) return;

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
        setSaveState({ kind: "saved", at: updated.updatedAt });
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not save your changes.";
      const isConflict = /changed somewhere else|conflict/i.test(message);
      if (isConflict) {
        await handleConflict(outgoing);
      } else if (!unmountedRef.current) {
        // Keep the edit queued so it is retried on the next change or retry.
        pendingRef.current = pendingRef.current ?? outgoing;
        setSaveState({ kind: "error", message });
      }
    } finally {
      inFlightRef.current = false;
      // A newer edit may have queued while we were saving.
      if (pendingRef.current && !unmountedRef.current) {
        void flushRef.current();
      }
    }
  }, [id, handleConflict]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  /** Queue an edit and restart the debounce window. */
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

  /**
   * Changing the website type may make the chosen layout unsuitable. Only the
   * layout is adjusted — every business detail is left exactly as it was.
   */
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
    setConflictPair(null);
    pendingRef.current = conflictPair.mine;
    setSaveState({ kind: "unsaved" });
    void flush();
  }, [conflictPair, flush]);

  const takeTheirs = useCallback(() => {
    if (!conflictPair) return;
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

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-navy sm:text-2xl">
          {brief.businessName || "Untitled website"}
        </h1>
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
              <p className="text-xs text-slate-500">
                The package is separate from the website type. Changing it does
                not affect anything else you have filled in.
              </p>
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

              <TextField
                id="hours"
                label="Opening hours"
                value={brief.hours ?? ""}
                onChange={(value) => update({ hours: value || undefined })}
                hint="e.g. Mon–Sat 8am–6pm"
              />

              <TextField
                id="services"
                label="Services you offer"
                value={brief.services.join(", ")}
                onChange={(value) => update({ services: toList(value) })}
                hint="Separate each one with a comma."
              />

              <TextField
                id="products"
                label="Products you sell"
                value={brief.products.map((product) => product.name).join(", ")}
                onChange={(value) =>
                  update({
                    products: toList(value).map((name) => ({ name })),
                  })
                }
                hint="Just the names, separated by commas. No prices, stock or checkout in Phase 1."
              />

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

              <fieldset className="grid gap-2 rounded-lg border border-line p-3">
                <legend className="text-sm font-semibold">
                  Payment methods you might want later
                </legend>
                <p className="text-xs text-amber-800">
                  {PAYMENT_PLANNING_NOTICE}
                </p>
                {PLANNED_PAYMENT_METHODS.map((method) => (
                  <label key={method.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={brief.plannedPaymentMethods.includes(method.id)}
                      onChange={(event) =>
                        update({
                          plannedPaymentMethods: event.target.checked
                            ? [...brief.plannedPaymentMethods, method.id]
                            : brief.plannedPaymentMethods.filter(
                                (item) => item !== method.id,
                              ),
                        })
                      }
                    />
                    <span className="text-sm">{method.label}</span>
                  </label>
                ))}
              </fieldset>

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

          <div className="mt-4">
            <BusinessPreview brief={brief} />
          </div>
        </aside>
      </div>

      <div className="mt-8 border-t border-line pt-4">
        <button
          type="button"
          onClick={removeDraft}
          disabled={deleting}
          data-testid="delete-draft"
          className="text-sm text-red-700 underline"
        >
          {deleting ? "Deleting…" : "Delete this draft"}
        </button>
        <p className="mt-1 text-xs text-slate-500">
          Deleting removes the draft permanently. Download a backup first if you
          want to keep a copy.
        </p>
      </div>
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
