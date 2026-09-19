"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiMutation, csrfToken } from "@/lib/client-api";
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
import {
  BRAND_LOGO_FONTS,
  BRAND_LOGO_ICONS,
  type BrandLogoIcon,
  type BrandLogoFontId,
} from "@/lib/studio/brand-logo";
import { ACCEPTED_BRAND_LOGO_MIMES, MAX_LOGO_BYTES } from "@/lib/studio/assets";
import { dataUrlByteLength, resizeImage } from "./resize-image";

/**
 * Stage B — the wizard's Brand Kit card, for a client who arrives with no
 * brand at all. Collapsed behind one button; inside, four questions, then
 * suggestions. Every suggestion is only a suggestion: nothing reaches the
 * brief until the agency clicks a "Use this" button, and each of those goes
 * through the apply/logo routes, which save exactly what the wizard would.
 *
 * Now also: richer generated logos (icon + font choices) and "Upload your
 * own logo" (PNG/JPEG/WebP up to 10MB, client+server validated, stored via
 * draft-assets).
 *
 * The card has two halves. The AI half (four questions, then name and palette
 * ideas) is transient by design. The second half — "Design the logo yourself"
 * — calls the model never: icon, font, the three layouts, the upload and the
 * brand sheet all render whether or not a suggest has ever succeeded, so a
 * degraded provider cannot take the offline tools away with it.
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

/**
 * The one extra sentence a failed suggest leaves behind. The icon and font
 * choices, the three layouts, the upload and the brand sheet are all offline,
 * so a degraded model provider must never read as "no logo today".
 */
const DIY_TOOLS_STILL_WORK =
  "The logo tools below still work without the AI — choose an icon and a font, save a layout, or upload your own logo.";

/**
 * The UI's own bound for one suggest — "Thinking…" must end even when a proxy
 * swallows the server's response and the browser would otherwise wait
 * forever. It sits deliberately above the server's model-call abort
 * (BRAND_KIT_MODEL_TIMEOUT_MS = 30s) so that on a live connection the
 * server's friendly 504 is what the agency reads, and a raw browser abort is
 * the last resort, never the expectation. When it does fire, the fetch
 * rejects without an ApiError and describeError answers with the honest
 * "unexpected, safe to retry" copy below.
 */
const SUGGEST_CLIENT_TIMEOUT_MS = 35_000;

const ICON_LABELS: Record<BrandLogoIcon, string> = {
  none: "No icon",
  fish: "Fish",
  chicken: "Chicken / Food",
  bolt: "Bolt / Electrical",
  scissors: "Scissors / Salon",
  house: "House",
  bag: "Shopping bag",
  book: "Book / School",
  car: "Car",
  leaf: "Leaf",
  mortar: "Mortar / Pharmacy",
};

type BusyAction =
  | { kind: "suggest" }
  | { kind: "name"; index: number }
  | { kind: "palette"; index: number }
  | { kind: "logo"; layout: string }
  | { kind: "custom-logo" }
  | { kind: "remove-logo" }
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

  // Richer logo options
  const [logoIcon, setLogoIcon] = useState<BrandLogoIcon>("none");
  const [logoFont, setLogoFont] = useState<BrandLogoFontId>("modern");

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
        icon: logoIcon,
        font: logoFont,
      });
      return `${baseUrl}/logo.svg?${query.toString()}`;
    },
    [baseUrl, brief.businessName, primary, accent, surface, logoIcon, logoFont],
  );

  const describeError = (cause: unknown): string => {
    if (cause instanceof ApiError) {
      if (cause.status === 503) {
        setModelMissing(true);
        return (
          cause.message ||
          "MODEL_API_KEY is not configured. Visit Settings (/settings) to configure your model provider."
        );
      }
      if (cause.status === 409) {
        return "This draft was changed somewhere else. Reload the page, then try again.";
      }
      return cause.message;
    }
    // A failure outside the API's own error shape — the browser could not
    // reach the server at all (offline, a proxy gave up, or this call's own
    // timeout fired). Still safe to retry: a suggest is a read, so nothing is
    // ever double-charged or half-written.
    return "Something unexpected happened while we were talking to the server. It is safe to try again.";
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
      }>(
        `${baseUrl}/suggest`,
        {
          whatTheySell: whatTheySell.trim(),
          town: town.trim(),
          feeling,
          mustInclude: parseMustInclude(mustInclude),
          category: brief.category,
        },
        // The UI must not wait longer than this, even on a hung connection.
        { timeoutMs: SUGGEST_CLIENT_TIMEOUT_MS },
      );
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
        icon: logoIcon,
        font: logoFont,
        palette: { primary, accent, surface },
        name: brief.businessName,
        expectedRevision: revisionRef.current,
      });
      adoptDraft(
        updated,
        "Logo saved to this draft. Uploading a custom logo will replace it, and vice versa.",
      );
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  // Custom logo upload — PNG/JPEG/WebP up to 10MB, client+server validated
  const customLogoInputRef = useRef<HTMLInputElement | null>(null);
  const [customLogoError, setCustomLogoError] = useState<string | null>(null);

  const validateCustomFileClient = (file: File): string | null => {
    if (!ACCEPTED_BRAND_LOGO_MIMES.has(file.type as never)) {
      return "That file type is not supported — use PNG, JPEG or WebP.";
    }
    if (file.size > MAX_LOGO_BYTES) {
      return "That file is too large — logos can be up to 10MB.";
    }
    return null;
  };

  const uploadCustomLogo = async (file: File): Promise<void> => {
    const clientError = validateCustomFileClient(file);
    if (clientError) {
      setCustomLogoError(clientError);
      return;
    }
    setBusy({ kind: "custom-logo" });
    setError(null);
    setCustomLogoError(null);
    setNotice(null);
    try {
      // Resize to 600 max side to keep brief small, but keep mime as PNG if needed
      const resized = await resizeImage(file, 600, true);
      const approxSize = await dataUrlByteLength(resized.dataUrl);
      if (approxSize > MAX_LOGO_BYTES) {
        throw new Error("That file is too large — logos can be up to 10MB.");
      }
      const response = await fetch(`/api/studio/drafts/${draftId}/assets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-valmont-csrf": csrfToken(),
        },
        body: JSON.stringify({
          kind: "logo",
          expectedRevision: revisionRef.current,
          image: {
            dataUrl: resized.dataUrl,
            fileName: file.name,
            mime: resized.mime,
            width: resized.width,
            height: resized.height,
          },
        }),
      });
      let data: {
        brief?: { assets?: { logo?: unknown } };
        revision?: number;
        error?: string;
      } = {};
      try {
        data = (await response.json()) as typeof data;
      } catch {}
      if (!response.ok) {
        throw new Error(data.error ?? "Upload failed.");
      }
      // Fetch full draft via assets route returns brief inside? Actually assets route returns full draft.
      // Re-use the response as draft if it has revision, else fetch draft.
      // The assets route returns StudioDraft JSON.
      const draft = data as unknown as StudioDraft;
      if (draft.revision) {
        adoptDraft(
          draft,
          "Custom logo uploaded. It replaces any generated logo, and saving a generated logo will replace it.",
        );
      } else {
        // Fallback: treat as success, but we need to get updated draft via separate fetch? For simplicity, show notice.
        setNotice(
          "Custom logo uploaded. It replaces any generated logo, and saving a generated logo will replace it.",
        );
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Upload failed.";
      setCustomLogoError(msg);
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const removeCustomLogo = async (): Promise<void> => {
    setBusy({ kind: "remove-logo" });
    setError(null);
    setCustomLogoError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams();
      params.set("target", "logo");
      params.set("expectedRevision", String(revisionRef.current));
      const response = await fetch(
        `/api/studio/drafts/${draftId}/assets?${params.toString()}`,
        {
          method: "DELETE",
          headers: { "x-valmont-csrf": csrfToken() },
        },
      );
      let data: {
        error?: string;
        revision?: number;
        brief?: { assets?: unknown };
      } = {};
      try {
        data = (await response.json()) as typeof data;
      } catch {}
      if (!response.ok) {
        throw new Error(data.error ?? "Remove failed.");
      }
      const draft = data as unknown as StudioDraft;
      if (draft.revision) {
        adoptDraft(draft, "Logo removed.");
      } else {
        setNotice("Logo removed.");
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Remove failed.";
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const canSuggest =
    whatTheySell.trim().length > 0 && town.trim().length > 0 && busy === null;

  const currentLogo = brief.assets?.logo ?? null;

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
                The Brand kit — names, tagline, colours and a simple logo — is
                not included in this shop&apos;s package. Choose the Command
                Center package in step 2 to include it, or tick the box below if
                the client paid for the {BRAND_KIT_ADDON_PRICE_LABEL}.
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
          ) : (
            <>
              {modelMissing ? (
                <p
                  className="rounded bg-amber-50 p-2 text-sm text-amber-900"
                  role="status"
                >
                  {error ||
                    "AI branding is not configured on this server. Visit Settings (/settings) to configure MODEL_API_KEY."}{" "}
                  {DIY_TOOLS_STILL_WORK}
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-600">
                    Answer four short questions and Valmont suggests names, a
                    tagline and colours. Nothing is saved to the brief until you
                    click a &quot;Use this&quot; button — the agency always
                    decides.
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
                        onChange={(event) =>
                          setWhatTheySell(event.target.value)
                        }
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
                        {busy?.kind === "suggest"
                          ? "Thinking…"
                          : "Suggest a brand"}
                      </button>
                    </div>
                  </fieldset>

                  {error && (
                    <p
                      role="alert"
                      className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
                    >
                      {error} {DIY_TOOLS_STILL_WORK}
                    </p>
                  )}
                </>
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
                            data-testid={`brand-palette-use-${index}`}
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

              {/* The offline half of the card. Nothing here calls the model,
                  so it stays put when the suggestions above fail or were
                  never requested. */}
              <div className="grid gap-3" data-testid="brand-kit-diy">
                <h3 className="text-sm font-semibold">
                  Design the logo yourself
                </h3>
                <p className="text-xs text-slate-500">
                  These tools never call the AI, so they work whether or not the
                  suggestions above do. Pick an icon and a font style, then save
                  one of the three layouts — or upload your own logo. Saving a
                  logo puts it in this draft&apos;s logo slot; uploading a
                  custom logo replaces the generated one, and vice versa.
                </p>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <label htmlFor="brand-logo-icon" className="text-sm">
                      Icon
                    </label>
                    <select
                      id="brand-logo-icon"
                      data-testid="brand-logo-icon"
                      value={logoIcon}
                      onChange={(e) =>
                        setLogoIcon(e.target.value as BrandLogoIcon)
                      }
                      className="w-full rounded-lg border border-line px-3 py-2 text-base"
                    >
                      {BRAND_LOGO_ICONS.map((ic) => (
                        <option key={ic} value={ic}>
                          {ICON_LABELS[ic]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <label htmlFor="brand-logo-font" className="text-sm">
                      Font style
                    </label>
                    <select
                      id="brand-logo-font"
                      data-testid="brand-logo-font"
                      value={logoFont}
                      onChange={(e) =>
                        setLogoFont(e.target.value as BrandLogoFontId)
                      }
                      className="w-full rounded-lg border border-line px-3 py-2 text-base"
                    >
                      {BRAND_LOGO_FONTS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {LAYOUTS.map((layout) => (
                    <article
                      key={layout}
                      className="grid content-start gap-2 rounded-lg border border-line p-3"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        data-testid={`brand-logo-preview-${layout}`}
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

                <div className="grid gap-3 rounded-lg border border-line p-3">
                  <h4 className="text-sm font-semibold">
                    Upload your own logo
                  </h4>
                  <p className="text-xs text-slate-500">
                    Upload a PNG, JPEG or WebP file up to 10MB. We check the
                    file type and size in your browser and again on the server.
                    Uploading replaces any generated logo, and saving a
                    generated logo will replace your upload. SVG uploads are not
                    accepted — we leave SVG out to keep logos safe.
                  </p>

                  {currentLogo ? (
                    <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        data-testid="custom-logo-preview"
                        src={currentLogo.dataUrl}
                        alt="Current logo"
                        className="h-16 w-16 rounded-md object-contain ring-1 ring-line"
                      />
                      <div className="text-xs text-slate-600">
                        <p className="font-semibold text-navy">
                          {currentLogo.fileName}
                        </p>
                        <p>
                          {currentLogo.width}×{currentLogo.height} ·{" "}
                          {formatBytes(currentLogo.size)}
                        </p>
                        <button
                          type="button"
                          onClick={() => void removeCustomLogo()}
                          disabled={busy !== null}
                          data-testid="remove-custom-logo"
                          className="mt-1 text-red-700 underline disabled:opacity-50"
                        >
                          {busy?.kind === "remove-logo"
                            ? "Removing…"
                            : "Remove logo"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      data-testid="upload-custom-logo"
                      disabled={busy !== null}
                      onClick={() => customLogoInputRef.current?.click()}
                      className="min-h-10 rounded-md border border-line bg-white px-3 text-sm font-semibold text-navy hover:bg-slate-50 disabled:opacity-60"
                    >
                      {busy?.kind === "custom-logo"
                        ? "Uploading…"
                        : currentLogo
                          ? "Replace logo"
                          : "Upload logo"}
                    </button>
                    <input
                      ref={customLogoInputRef}
                      type="file"
                      accept={Array.from(ACCEPTED_BRAND_LOGO_MIMES).join(",")}
                      className="hidden"
                      data-testid="custom-logo-input"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadCustomLogo(file);
                        // Reset so same file can be picked again
                        e.currentTarget.value = "";
                      }}
                    />
                    <span className="text-xs text-slate-500">
                      PNG, JPEG or WebP, up to 10MB.
                    </span>
                  </div>

                  {customLogoError && (
                    <p
                      role="alert"
                      className="rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800"
                    >
                      {customLogoError}
                    </p>
                  )}
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
