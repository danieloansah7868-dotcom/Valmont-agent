import { publicSitePath } from "./catalog";
import { getCategory } from "./categories";
import type { DomainRow, DomainStatus } from "./domains";
import type { StudioDraft } from "./site-brief/schema";
import { computeBriefCompleteness } from "./site-brief/readiness";
import { getTemplate } from "./templates";
import { getTheme } from "./themes";

/**
 * Phase 5 item 3 — the multi-website (client-project) dashboard.
 *
 * Valmont Web is the workspace the agency owner uses to build many client
 * websites: every Studio draft is one client website, started from a Valmont
 * template. This module turns the owner's drafts into the plain project
 * information the dashboard shows — who the website is for, what type it is,
 * which layout and theme it uses, how complete it is, whether a custom domain
 * is connected, and how to preview or open it.
 *
 * Everything here is pure: no database, no session, no rendering. The page
 * hands in what it already fetched, which keeps the isolation rule testable on
 * its own — see `websitesForOwner`.
 */

/** Path of the editor for one website. */
export function websiteEditorPath(draftId: string): string {
  return `/studio/drafts/${draftId}`;
}

/**
 * Where the optional shop-order tool lives. It is deliberately a single
 * owner-scoped page outside the website dashboard: order management is a tool
 * for online-shop websites, not part of the client-project overview.
 */
export const SHOP_ORDERS_PATH = "/studio/orders";

/** Plain-language wording for each custom-domain state. */
export const DOMAIN_LABELS: Record<DomainStatus, string> = {
  not_set: "No custom domain yet",
  pending: "Custom domain waiting for DNS",
  active: "Custom domain connected",
  error: "Custom domain needs fixing",
};

export interface WebsiteCompletion {
  /** 0–100, straight from the Brief readiness rules. */
  score: number;
  readyForHandoff: boolean;
  missingRequiredCount: number;
  /** One short status line for the card, e.g. "2 required items left". */
  label: string;
  /** The next thing the owner should fill in, or null when nothing is missing. */
  nextStep: string | null;
}

export interface WebsiteDomainSummary {
  status: DomainStatus;
  label: string;
  hostname?: string;
}

/** Everything the dashboard card for one website needs. */
export interface WebsiteSummary {
  id: string;
  /** Client / business name, exactly as the owner typed it. */
  name: string;
  /** Website type, e.g. "Online Shop & E-Commerce". */
  typeLabel: string;
  /** Layout from the Valmont template registry. */
  templateLabel: string;
  /** Look and feel from the Valmont theme registry. */
  themeLabel: string;
  completion: WebsiteCompletion;
  domain: WebsiteDomainSummary;
  editorHref: string;
  /** Path of the public preview, i.e. the link to share with the client. */
  previewPath: string;
  /** True when this website has checkout switched on (an online shop). */
  hasShop: boolean;
  updatedAt: string;
}

/** The two fields a website switcher option needs — nothing more. */
export interface WebsiteSwitcherOption {
  id: string;
  name: string;
}

export interface WebsiteDashboard {
  websites: WebsiteSummary[];
  switcherOptions: WebsiteSwitcherOption[];
  /** The website named by the `website` query param, if the owner owns it. */
  selectedWebsite?: WebsiteSummary;
}

/**
 * Drops every draft that does not belong to `ownerId`.
 *
 * The draft store is already owner-scoped, so in normal operation this changes
 * nothing. It exists so the dashboard cannot be turned into a leak by a caller
 * that passes in more than it should: the switcher and the cards are built from
 * this list, so a foreign draft can never become an option, a card, or a
 * selectable id.
 */
export function websitesForOwner(
  drafts: readonly StudioDraft[],
  ownerId: string,
): StudioDraft[] {
  return drafts.filter((draft) => draft.ownerId === ownerId);
}

export function describeCompletion(
  brief: StudioDraft["brief"],
): WebsiteCompletion {
  const completeness = computeBriefCompleteness(brief);
  const missingRequiredCount = completeness.missingRequired.length;
  const label = completeness.readyForHandoff
    ? "Ready to hand off"
    : missingRequiredCount === 1
      ? "1 required item left"
      : `${missingRequiredCount} required items left`;
  const nextGap =
    completeness.missingRequired[0] ?? completeness.recommended[0] ?? null;
  return {
    score: completeness.score,
    readyForHandoff: completeness.readyForHandoff,
    missingRequiredCount,
    label,
    // Only the first letter is lowercased, so names inside a label (WhatsApp,
    // for instance) keep their spelling.
    nextStep: nextGap ? `Add ${lowerFirst(nextGap.label)}` : null,
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function describeDomain(domain?: DomainRow): WebsiteDomainSummary {
  const status: DomainStatus = domain?.status ?? "not_set";
  return {
    status,
    label: DOMAIN_LABELS[status],
    ...(domain ? { hostname: domain.hostname } : {}),
  };
}

export function toWebsiteSummary(
  draft: StudioDraft,
  domain?: DomainRow,
): WebsiteSummary {
  const { brief } = draft;
  const template = brief.selectedTemplate
    ? getTemplate(brief.selectedTemplate)
    : undefined;
  const theme = getTheme(brief.selectedTheme);
  return {
    id: draft.id,
    name: brief.businessName,
    typeLabel: getCategory(brief.category)?.label ?? brief.category,
    templateLabel:
      template?.label ??
      (brief.selectedTemplate
        ? brief.selectedTemplate
        : "No layout chosen yet"),
    themeLabel: theme?.label ?? brief.selectedTheme,
    completion: describeCompletion(brief),
    domain: describeDomain(domain),
    editorHref: websiteEditorPath(draft.id),
    previewPath: publicSitePath(draft.id),
    hasShop: brief.payments?.enabled === true,
    updatedAt: draft.updatedAt,
  };
}

/**
 * Resolves the `website` query parameter against the owner's own websites.
 *
 * A guessed id, another owner's draft id, or any value the owner does not own
 * resolves to `undefined` — the same as no selection at all. Nothing here can
 * fetch a draft: it only ever picks from the list it was handed.
 */
export function resolveSelectedWebsite(
  websites: readonly WebsiteSummary[],
  requestedId: string | undefined,
): WebsiteSummary | undefined {
  if (!requestedId) return undefined;
  return websites.find((website) => website.id === requestedId);
}

/**
 * Builds the whole dashboard view for one signed-in owner.
 *
 * `domains` may contain rows for other drafts; only rows owned by `ownerId`
 * and attached to one of the owner's websites are used.
 */
export function buildWebsiteDashboard(input: {
  drafts: readonly StudioDraft[];
  ownerId: string;
  domains?: readonly DomainRow[];
  requestedWebsiteId?: string;
}): WebsiteDashboard {
  const owned = websitesForOwner(input.drafts, input.ownerId);
  const domainByDraft = new Map<string, DomainRow>();
  for (const domain of input.domains ?? []) {
    if (domain.owner_id !== input.ownerId) continue;
    domainByDraft.set(domain.draft_id, domain);
  }
  const websites = owned.map((draft) =>
    toWebsiteSummary(draft, domainByDraft.get(draft.id)),
  );
  return {
    websites,
    switcherOptions: websites.map(({ id, name }) => ({ id, name })),
    selectedWebsite: resolveSelectedWebsite(websites, input.requestedWebsiteId),
  };
}
