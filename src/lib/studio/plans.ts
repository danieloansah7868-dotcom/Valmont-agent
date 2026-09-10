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
 * supplier API with automatic sending; `wallets` is Stage 7: the owner-only
 * Agents page and the agent portal (7a); no permission box may ever grant it
 */
export const PLAN_FEATURES = [
  "auto_dispatch",
  "bundle_pause",
  "supplier_page",
  "second_supplier",
  "reports",
  "wallets",
  // Stage B: the Brand Kit studio — Command Center includes it; the cheaper
  // packages can buy it as the one-time add-on (see brandKitAddon below).
  "brand_kit",
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
 * | brand_kit         | —       | —             | ✓ (Stage B; cheaper plans: paid add-on) |
 */
const FEATURE_MATRIX: Record<PlanId, Readonly<Record<PlanFeature, boolean>>> = {
  starter: {
    auto_dispatch: false,
    bundle_pause: false,
    supplier_page: false,
    second_supplier: false,
    reports: false,
    wallets: false,
    brand_kit: false,
  },
  auto_dispatch: {
    auto_dispatch: true,
    bundle_pause: true,
    supplier_page: true,
    second_supplier: false,
    reports: false,
    wallets: false,
    brand_kit: false,
  },
  command_center: {
    auto_dispatch: true,
    bundle_pause: true,
    supplier_page: true,
    second_supplier: true,
    reports: true,
    wallets: true,
    brand_kit: true,
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
 * Stage B — the agency price-sheet label for the Brand Kit add-on, shown
 * beside the "Client paid the Brand Kit add-on" tick box in the wizard.
 * Display only — the software never charges it.
 */
export const BRAND_KIT_ADDON_PRICE_LABEL = "GH₵ 600 one-time add-on";

/**
 * Stage B — whether a brief may use the Brand Kit studio.
 *
 * The gate sits on `category === "data-bundles"` first, exactly like every
 * other Stage 6 gate: every other website type is always allowed, because
 * packages only exist for bundle shops. A data-bundles website is allowed
 * when its package includes the feature (Command Center) or when the agency
 * has ticked the paid add-on on the brief (`brandKitAddon`, meaning the
 * client bought {@link BRAND_KIT_ADDON_PRICE_LABEL}; Starter and
 * Auto-Dispatch only). Read defensively: a raw row saved before Stage B has
 * no `brandKitAddon` key at all, and `planOf` already maps an unknown or
 * missing plan onto the Auto-Dispatch default.
 */
export function brandKitAllowed(
  brief:
    | {
        category?: string | undefined;
        plan?: string | undefined;
        brandKitAddon?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (!brief || brief.category !== "data-bundles") return true;
  if (planAllows(planOf(brief), "brand_kit")) return true;
  return brief.brandKitAddon === true;
}

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
