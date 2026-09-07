"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiMutation } from "@/lib/client-api";
import {
  BRAND_KIT_ADDON_PRICE_LABEL,
  brandKitAllowed,
} from "@/lib/studio/plans";
import { getTheme } from "@/lib/studio/themes";
import type {
  BrandKitNameSuggestion,
  BrandKitPalette,
} from "@/lib/studio/brand-kit";
import type { SiteBriefV1, StudioDraft } from "@/lib/studio/site-brief/schema";

/**
 * Stage B — the wizard's Brand Kit card, for a client who arrives with no
 * brand at all. Collapsed behind one button; inside, four questions, then
 * suggestions. Every suggestion is only a suggestion: nothing reaches the
 * brief until the agency clicks a "Use this" button, and each of those goes
 * through the apply/logo routes, which save exactly what the wizard would.
 *
 * Kept pure-client: the server library for this feature reads the model and
 * the rate limiter, neither of which may enter the browser bundle — so the
 * four feelings live here too (type-only imports from the library stay
 * type-only).
 */
const FEELINGS = ["trusted", "friendly", "premium", "young"] as const;
type Feeling = (typeof FEELINGS)[number];

const FEELING_LABELS: Record<Feeling, string> = {
  trusted: "Trusted",
  friendly: "Friendly",
  premium: "Premium",
  young: "Young",
};

const LAYOUTS = ["wordmark", "badge", "stacked"] as const;
const LAYOUT_LABELS: Record<(typeof LAYOUTS)[number], string> = {
  wordmark: "Name only",
  badge: "Badge beside the name",
  stacked: "Badge above the name",
};

type BusyAction =
  | { kind: "suggest" }
  | { kind: "name"; index: number }
  | { kind: "palette"; index: number }
  | { kind: "logo"; layout: string }
  | null;

interface Props {
  draftId: string;
  brief: SiteBriefV1;
  /** The revision the wizard last got confirmed by the server. */
  expectedRevision: number;
  /** Adopts the draft an apply/logo route returned, like an asset upload. */
  onDraftUpdated: (draft: StudioDraft) => void;
  /** The "Client paid the Brand Kit add-on" tick box (bundle plans only). */
  onAddonChange: (checked: boolean) => void;
}

/** "adom, gold, premium" -> ["adom", "gold", "premium"] (max 3, max 20 chars each). */
function parseMustInclude(text: string): string[] {
  return text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word.slice(0, 20));
}

export function BrandKitCard({
  draftId,
  brief,
  expectedRevision,
  onDraftUpdated,
  onAddonChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [modelMissing, setModelMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);

  const [whatTheySell, setWhatTheySell] = useState("");
  const [town, setTown] = useState("");
  const [feeling, setFeeling] = useState<Feeling>("friendly");
  const [mustInclude, setMustInclude] = useState("");

  const [names, setNames] = useState<BrandKitNameSuggestion[] | null>(null);
  const [palettes, setPalettes] = useState<BrandKitPalette[] | null>(null);

  const isBundleSite = brief.category === "data-bundles";
  const gated = !brandKitAllowed(brief);

  // Latest revision in a ref so sequential actions never send a stale one.
  const revisionRef = useRef(expectedRevision);
  useEffect(() => {
    revisionRef.current = expectedRevision;
  }, [expectedRevision]);

  const theme = getTheme(brief.selectedTheme);
  const [primary, accent, surface] = brief.preferredColours ?? [
    theme?.tokens.colors.primary ?? "#0A1F44",
    theme?.tokens.colors.accent ?? "#E8822B",
    theme?.tokens.colors.surface ?? "#F8F6F0",
  ];

  const baseUrl = `/api/studio/drafts/${draftId}/brand-kit`;

  const logoSvgUrl = useCallback(
    (layout: (typeof LAYOUTS)[number]): string => {
      const query = new URLSearchParams({
        layout,
        name: brief.businessName,
        primary,
        accent,
        surface,
      });
      return `${baseUrl}/logo.svg?${query.toString()}`;
    },
    [baseUrl, brief.businessName, primary, accent, surface],
  );

  const describeError = (cause: unknown): string => {
    if (cause instanceof ApiError) {
      if (cause.status === 503) {
        setModelMissing(true);
        return "AI branding is not configured on this server.";
      }
      if (cause.status === 409) {
        return "This draft was changed somewhere else. Reload the page, then try again.";
      }
      return cause.message;
    }
    return "Something went wrong. Please try again.";
  };

  const adoptDraft = (draft: StudioDraft, message: string) => {
    revisionRef.current = draft.revision;
    setNotice(message);
    onDraftUpdated(draft);
  };

  const suggest = async (): Promise<void> => {
    setBusy({ kind: "suggest" });
    setError(null);
    setNotice(null);
    try {
      const answer = await apiMutation<{
        names: BrandKitNameSuggestion[];
        palettes: BrandKitPalette[];
      }>(`${baseUrl}/suggest`, {
        whatTheySell: whatTheySell.trim(),
        town: town.trim(),
        feeling,
        mustInclude: parseMustInclude(mustInclude),
        category: brief.category,
      });
      setNames(answer.names);
      setPalettes(answer.palettes);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (
    action: BusyAction,
    patch: Record<string, unknown>,
    message: string,
  ): Promise<void> => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiMutation<StudioDraft>(`${baseUrl}/apply`, {
        ...patch,
        expectedRevision: revisionRef.current,
      });
      adoptDraft(updated, message);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveLogo = async (layout: (typeof LAYOUTS)[number]): Promise<void> => {
    setBusy({ kind: "logo", layout });
    setError(null);
    setNotice(null);
    try {
      const updated = await apiMutation<StudioDraft>(`${baseUrl}/logo`, {
        layout,
        palette: { primary, accent, surface },
        name: brief.businessName,
        expectedRevision: revisionRef.current,
      });
      adoptDraft(updated, "Logo saved to this draft.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const canSuggest =
    whatTheySell.trim().length > 0 && town.trim().length > 0 && busy === null;

  return (
    <section
      aria-label="Brand Kit"
      className="rounded-lg border border-line bg-white p-3"
    >
      <button
        type="button"
        data-testid="brand-kit-open"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="w-full rounded-md border border-line bg-ivory-50 px-3 py-2 text-left text-sm font-semibold text-navy hover:bg-ivory-100"
      >
        {open ? "Close the brand kit" : "No brand yet? Create one"}
      </button>

      {open && (
        <div className="mt-3 grid gap-4">
          {isBundleSite && gated ? (
            <div className="grid gap-2">
              <p className="text-sm">
                The Brand Kit — names, tagline, colours and a simple logo — is
                not included in this shop&apos;s package. It is available as an
                add-on ({BRAND_KIT_ADDON_PRICE_LABEL}).
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="brand-kit-addon"
                  checked={brief.brandKitAddon ?? false}
                  onChange={(event) => onAddonChange(event.target.checked)}
                />
                <span className="text-sm">Client paid the add-on</span>
              </label>
            </div>
          ) : modelMissing ? (
            <p
              className="rounded bg-amber-50 p-2 text-sm text-amber-900"
              role="status"
            >
              AI branding is not configured on this server.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                Answer four short questions and Valmont suggests names, a
                tagline and colours. Nothing is saved to the brief until you
                click a &quot;Use this&quot; button — the agency always decides.
              </p>

              <fieldset className="grid gap-3">
                <legend className="text-sm font-semibold">
                  About the business
                </legend>
                <div className="grid gap-1">
                  <label htmlFor="brand-what" className="text-sm">
                    What does the business sell or do?
                  </label>
                  <input
                    id="brand-what"
                    type="text"
                    maxLength={300}
                    value={whatTheySell}
                    onChange={(event) => setWhatTheySell(event.target.value)}
                    placeholder="e.g. Fresh kenkey and fish"
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  />
                </div>
                <div className="grid gap-1">
                  <label htmlFor="brand-town" className="text-sm">
                    Which town is it based in?
                  </label>
                  <input
                    id="brand-town"
                    type="text"
                    maxLength={60}
                    value={town}
                    onChange={(event) => setTown(event.target.value)}
                    placeholder="e.g. Koforidua"
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  />
                </div>
                <div className="grid gap-1">
                  <label htmlFor="brand-feeling" className="text-sm">
                    How should the brand feel?
                  </label>
                  <select
                    id="brand-feeling"
                    value={feeling}
                    onChange={(event) =>
                      setFeeling(event.target.value as Feeling)
                    }
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  >
                    {FEELINGS.map((option) => (
                      <option key={option} value={option}>
                        {FEELING_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1">
                  <label htmlFor="brand-must-include" className="text-sm">
                    Words the name must include (optional)
                  </label>
                  <input
                    id="brand-must-include"
                    type="text"
                    value={mustInclude}
                    onChange={(event) => setMustInclude(event.target.value)}
                    placeholder="e.g. adom, gold"
                    aria-describedby="brand-must-include-hint"
                    className="w-full rounded-lg border border-line px-3 py-2 text-base"
                  />
                  <p
                    id="brand-must-include-hint"
                    className="text-xs text-slate-500"
                  >
                    Up to 3 short words, separated by commas.
                  </p>
                </div>
                <div>
                  <button
                    type="button"
                    data-testid="brand-kit-suggest"
                    disabled={!canSuggest}
                    onClick={() => void suggest()}
                    className="btn-primary min-h-10 px-4 text-sm disabled:opacity-60"
                  >
                    {busy?.kind === "suggest" ? "Thinking…" : "Suggest a brand"}
                  </button>
                </div>
              </fieldset>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
                >
                  {error}
                </p>
              )}
              {notice && (
                <p
                  role="status"
                  className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"
                >
                  {notice}
                </p>
              )}

              {names && names.length > 0 && (
                <div className="grid gap-3">
                  <h3 className="text-sm font-semibold">Name ideas</h3>
                  <p className="text-xs text-slate-500">
                    Always check a name before using it — Valmont only suggests,
                    it does not check trademarks.
                  </p>
                  {names.map((idea, index) => (
                    <article
                      key={`${idea.slug}-${index}`}
                      data-testid={`brand-name-${index}`}
                      className="grid gap-2 rounded-lg border border-line p-3"
                    >
                      <h4 className="text-sm font-bold text-navy">
                        {idea.name}
                      </h4>
                      <p className="text-xs text-slate-600">{idea.meaning}</p>
                      <p className="text-xs italic text-slate-700">
                        &ldquo;{idea.tagline}&rdquo;
                      </p>
                      <p className="text-xs text-slate-600">
                        Domains to check: {idea.domainCandidates[0]},{" "}
                        {idea.domainCandidates[1]}
                      </p>
                      <p className="flex flex-wrap gap-3 text-xs">
                        <a
                          href={idea.checkLinks.instagram}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Check Instagram
                        </a>
                        <a
                          href={idea.checkLinks.tiktok}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Check TikTok
                        </a>
                        <a
                          href={idea.checkLinks.whois}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Check WHOIS
                        </a>
                      </p>
                      <div>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            void apply(
                              { kind: "name", index },
                              { name: idea.name, tagline: idea.tagline },
                              `Name and tagline applied to the brief.`,
                            )
                          }
                          className="btn-secondary min-h-10 px-3 text-sm disabled:opacity-60"
                        >
                          {busy?.kind === "name" && busy.index === index
                            ? "Applying…"
                            : "Use this name"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {palettes && palettes.length > 0 && (
                <div className="grid gap-3">
                  <h3 className="text-sm font-semibold">Colour palettes</h3>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {palettes.map((palette, index) => (
                      <article
                        key={`${palette.themeId}-${index}`}
                        data-testid={`brand-palette-${index}`}
                        className="overflow-hidden rounded-lg border border-line"
                      >
                        <div
                          className="px-3 py-2 text-xs font-bold"
                          style={{
                            backgroundColor: palette.primary,
                            color: "#FFFFFF",
                          }}
                        >
                          {palette.label}
                        </div>
                        <div
                          className="grid gap-2 px-3 py-3"
                          style={{ backgroundColor: palette.surface }}
                        >
                          <p
                            className="text-xs"
                            style={{ color: palette.text }}
                          >
                            {primaryAndHex(palette)}
                          </p>
                          <button
                            type="button"
                            tabIndex={-1}
                            className="rounded-md px-2 py-1 text-xs font-semibold text-white"
                            style={{ backgroundColor: palette.accent }}
                          >
                            Button
                          </button>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              void apply(
                                { kind: "palette", index },
                                {
                                  palette: {
                                    themeId: palette.themeId,
                                    primary: palette.primary,
                                    accent: palette.accent,
                                    surface: palette.surface,
                                  },
                                },
                                "Colours applied to the brief.",
                              )
                            }
                            className="btn-secondary min-h-10 px-2 text-xs disabled:opacity-60"
                          >
                            {busy?.kind === "palette" && busy.index === index
                              ? "Applying…"
                              : "Use this palette"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}

              {names !== null && (
                <div className="grid gap-3">
                  <h3 className="text-sm font-semibold">A simple text logo</h3>
                  <p className="text-xs text-slate-500">
                    Same name and colours in three layouts. Saving one puts it
                    in this draft&apos;s logo slot.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {LAYOUTS.map((layout) => (
                      <article
                        key={layout}
                        className="grid content-start gap-2 rounded-lg border border-line p-3"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={logoSvgUrl(layout)}
                          alt={`${brief.businessName} as a ${layout} logo`}
                          className="w-full rounded border border-slate-100"
                        />
                        <p className="text-xs text-slate-600">
                          {LAYOUT_LABELS[layout]}
                        </p>
                        <button
                          type="button"
                          data-testid={`brand-logo-${layout}`}
                          disabled={busy !== null}
                          onClick={() => void saveLogo(layout)}
                          className="btn-secondary min-h-10 px-2 text-xs disabled:opacity-60"
                        >
                          {busy?.kind === "logo" && busy.layout === layout
                            ? "Saving…"
                            : "Save as logo"}
                        </button>
                      </article>
                    ))}
                  </div>
                  <div>
                    <a
                      data-testid="brand-kit-sheet"
                      href={`${baseUrl}/sheet`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-primary inline-flex min-h-10 items-center px-4 text-sm"
                    >
                      Download brand sheet
                    </a>
                    <p className="mt-1 text-xs text-slate-500">
                      One page with the logo, name, tagline, colours and font —
                      ready to share or print.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** "Primary #0A1F44 · Accent #E8822B · Surface #F8F6F0" — small hex list. */
function primaryAndHex(palette: BrandKitPalette): string {
  return `${palette.primary} / ${palette.accent} / ${palette.surface}`;
}
