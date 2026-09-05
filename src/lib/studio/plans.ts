/**
 * Stage 6 — the commercial packages a data-bundles website is sold under.
 *
 * The agency (Studio) picks exactly one package per website; the shop owner
 * can never change it, and the prices are labels only — the software never
 * charges them. What the package actually does is gate features:
 * `planAllows(plan, feature)` is the single server-side authority, so a
 * client cannot switch something on that the client did not buy.
 *
 * The default is `auto_dispatch`, which is the exact feature set every
 * data-bundles website had before packages existed: a brief without `plan`
 * keeps its current behaviour, and no existing test changes.
 *
 * Every gate in Stage 6 is on `category === "data-bundles"` first — for every
 * other website type the plan is ignored everywhere it is read.
 */

/** The three sellable packages, cheapest first. */
export const PLAN_IDS = ["starter", "auto_dispatch", "command_center"] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(value: unknown): value is PlanId {
  return (
    typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value)
  );
}

/** What the owner sees, e.g. on the badge in the shop-admin header. */
export const PLAN_LABELS: Record<PlanId, string> = {
  starter: "Starter Shop",
  auto_dispatch: "Auto-Dispatch Pro",
  command_center: "Command Center",
};

/** Agency price-sheet labels. Display only — never charged by the software. */
export const PLAN_PRICE_LABELS: Record<PlanId, string> = {
  starter: "GH₵ 3,500 one-time",
  auto_dispatch: "GH₵ 6,500 one-time",
  command_center: "GH₵ 10,000 one-time",
};

/**
 * The features a package can switch on. `auto_dispatch` is the TechChief
 * supplier API with automatic sending; `wallets` is reserved for Stage 7 and
 * must not be offered anywhere yet (no UI, no route may grant it).
 */
export const PLAN_FEATURES = [
  "auto_dispatch",
  "bundle_pause",
  "supplier_page",
  "second_supplier",
  "reports",
  "wallets",
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * The matrix the agency price sheet describes:
 *
 * | feature           | starter | auto_dispatch | command_center |
 * |-------------------|---------|---------------|----------------|
 * | auto_dispatch     | —       | ✓             | ✓              |
 * | bundle_pause      | —       | ✓             | ✓              |
 * | supplier_page     | —       | ✓             | ✓              |
 * | second_supplier   | —       | —             | ✓ (gap, no provider yet) |
 * | reports           | —       | —             | ✓ (Stage 6d)   |
 * | wallets           | —       | —             | ✓ (Stage 7)    |
 */
const FEATURE_MATRIX: Record<PlanId, Readonly<Record<PlanFeature, boolean>>> = {
  starter: {
    auto_dispatch: false,
    bundle_pause: false,
    supplier_page: false,
    second_supplier: false,
    reports: false,
    wallets: false,
  },
  auto_dispatch: {
    auto_dispatch: true,
    bundle_pause: true,
    supplier_page: true,
    second_supplier: false,
    reports: false,
    wallets: false,
  },
  command_center: {
    auto_dispatch: true,
    bundle_pause: true,
    supplier_page: true,
    second_supplier: true,
    reports: true,
    wallets: true,
  },
};

/**
 * Whether a website's package includes a feature. Every API route that
 * exposes a packaged feature must check this server-side; the refusal answer
 * is always {@link PACKAGE_NOT_INCLUDED_MESSAGE} with 403.
 */
export function planAllows(plan: PlanId, feature: PlanFeature): boolean {
  return FEATURE_MATRIX[plan][feature];
}

/** The exact wording a packaged refusal answers with (403). */
export const PACKAGE_NOT_INCLUDED_MESSAGE = "Not included in your package.";

/**
 * Reads a brief's plan defensively. Briefs saved before Stage 6 have no
 * `plan` at all (and a raw database row is never re-parsed on read), so every
 * reader must treat a missing or unknown value as the default — which keeps
 * each existing website on its exact pre-package behaviour.
 */
export function planOf(
  brief: { plan?: string | undefined } | null | undefined,
): PlanId {
  return isPlanId(brief?.plan) ? brief.plan : "auto_dispatch";
}
