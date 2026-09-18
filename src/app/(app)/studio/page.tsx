import Link from "next/link";
import {
  ArrowRight,
  BedDouble,
  Briefcase,
  Building2,
  CalendarCheck,
  Compass,
  GraduationCap,
  HeartHandshake,
  Home,
  LayoutDashboard,
  Palette,
  Scissors,
  ShoppingBag,
  Stethoscope,
  Utensils,
  Wand2,
  Zap,
} from "lucide-react";
import { requireSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { getDomainStore } from "@/lib/studio/domains";
import { buildWebsiteDashboard, SHOP_ORDERS_PATH } from "@/lib/studio/websites";
import { categories } from "@/lib/studio/categories";
import {
  defaultTemplateForCategory,
  getTemplate,
} from "@/lib/studio/templates";
import { BackupControls } from "@/components/studio/backup-controls";
import { WebsiteSwitcher } from "@/components/studio/website-switcher";
import { ShareLinkButton } from "@/components/studio/share-link-button";
import { canonicalUserId } from "@/lib/user-identity";
import { resolvePaymentConfig } from "@/lib/studio/payment-settings";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  "online-shop": ShoppingBag,
  "data-bundles": Zap,
  "business-profile": Building2,
  school: GraduationCap,
  church: HeartHandshake,
  restaurant: Utensils,
  hotel: BedDouble,
  salon: Scissors,
  clinic: Stethoscope,
  "real-estate": Home,
  "travel-tourism": Compass,
  ngo: HeartHandshake,
  portfolio: Palette,
  consultant: Briefcase,
  booking: CalendarCheck,
  "customer-portal": LayoutDashboard,
  custom: Wand2,
};

const COMPLETION_BADGE_CLASS: Record<"ready" | "in-progress", string> = {
  ready: "bg-pass-soft text-pass-strong",
  "in-progress": "bg-attention-soft text-attention",
};

const DOMAIN_LINE_CLASS: Record<string, string> = {
  not_set: "text-slate-500",
  pending: "text-attention",
  active: "text-pass-strong",
  error: "text-fail-strong",
};

/**
 * The client-project dashboard: one row per client website, with the quick
 * switcher above it. Order management is intentionally not here — shop orders
 * stay on their own owner-scoped page, reachable from a shop website's card.
 */
export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ website?: string }>;
}) {
  const user = await requireSessionUser();
  const { website: requestedWebsiteId } = await searchParams;
  const ownerId = canonicalUserId(user);
  const drafts = await getStudioDraftStore().list(user);
  const domains = await getDomainStore().getDomainsForOwner(ownerId);
  // Every id the switcher and the cards can offer comes from here, and this
  // builder keeps only the signed-in owner's own drafts.
  const { websites, switcherOptions, selectedWebsite } = buildWebsiteDashboard({
    drafts,
    ownerId,
    domains,
    requestedWebsiteId,
  });
  const paymentConfig = await resolvePaymentConfig();
  const starters = categories.map((category) => ({
    id: category.id,
    label: category.label,
    description: category.description,
    templateLabel:
      getTemplate(defaultTemplateForCategory(category.id))?.label ?? "",
  }));

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-navy">Website Studio</h1>
      <p className="mt-2 text-sm text-slate">
        Every client website you build lives here. Each one starts from a
        Valmont template, so a new website is a copy-and-adjust job instead of a
        build from zero. Everything saves as you type, and you can come back to
        any website later on any device.
      </p>

      <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <Link
          href="/studio/drafts/new"
          className="btn-primary inline-flex justify-center sm:w-auto"
          data-testid="start-new-website"
        >
          Start new website
        </Link>
        {switcherOptions.length > 0 && (
          <WebsiteSwitcher
            websites={switcherOptions}
            selectedWebsiteId={selectedWebsite?.id}
          />
        )}
      </div>

      <section className="mt-8" aria-labelledby="your-websites">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="your-websites" className="text-lg font-semibold text-navy">
              Your websites
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              {switcherOptions.length === 0
                ? "You have no client websites yet."
                : `${switcherOptions.length} client ${
                    switcherOptions.length === 1 ? "website" : "websites"
                  } · pick one in the list above to jump straight to it.`}
            </p>
          </div>
          {selectedWebsite && (
            <span className="rounded-full bg-brandblue/10 px-2.5 py-1 text-xs font-semibold text-brandblue">
              Selected {selectedWebsite.name}
            </span>
          )}
        </div>

        {websites.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            Use “Start new website” above to make your first one, or pick a
            website type below to start from the Valmont template that suits it.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3" data-testid="website-list">
            {websites.map((website) => (
              <li
                key={website.id}
                data-testid="website-card"
                className={`rounded-xl border bg-white p-4 ${
                  selectedWebsite?.id === website.id
                    ? "border-brandblue ring-2 ring-brandblue/10"
                    : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={website.editorHref}
                      className="text-base font-semibold text-navy underline"
                    >
                      {website.name}
                    </Link>
                    <p className="mt-1 text-xs text-slate-600">
                      {website.typeLabel}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Layout {website.templateLabel} · Theme{" "}
                      {website.themeLabel}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        COMPLETION_BADGE_CLASS[
                          website.completion.readyForHandoff
                            ? "ready"
                            : "in-progress"
                        ]
                      }`}
                      data-testid="website-completion"
                    >
                      {website.completion.label}
                    </span>
                    <span className="text-xs text-slate-500">
                      Brief {website.completion.score}% complete
                    </span>
                  </div>
                </div>

                {website.completion.nextStep && (
                  <p className="mt-2 text-xs text-slate-600">
                    Next: {website.completion.nextStep}.
                  </p>
                )}

                <p
                  className={`mt-2 text-xs ${
                    DOMAIN_LINE_CLASS[website.domain.status] ?? "text-slate-500"
                  }`}
                  data-testid="website-domain-status"
                >
                  {website.domain.status === "active" &&
                  website.domain.hostname ? (
                    <>
                      {website.domain.label}:{" "}
                      <a
                        href={`http://${website.domain.hostname}`}
                        target="_blank"
                        className="underline"
                      >
                        {website.domain.hostname}
                      </a>
                    </>
                  ) : website.domain.hostname ? (
                    `${website.domain.label}: ${website.domain.hostname}`
                  ) : (
                    website.domain.label
                  )}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Link
                    href={website.editorHref}
                    className="btn-secondary min-h-9 px-3 text-sm"
                    data-testid="open-editor"
                  >
                    Open editor
                  </Link>
                  <ShareLinkButton draftId={website.id} compact />
                  {website.hasShop && (
                    <>
                      <Link
                        href={SHOP_ORDERS_PATH}
                        className="text-xs font-medium text-navy underline"
                        data-testid="shop-orders-link"
                      >
                        Shop orders
                      </Link>
                      <Link
                        href={`/studio/analytics?website=${encodeURIComponent(website.id)}`}
                        className="text-xs font-medium text-navy underline"
                        data-testid="website-analytics-link"
                      >
                        Sales analytics
                      </Link>
                    </>
                  )}
                </div>

                <p className="mt-2 text-xs text-slate-500">
                  Last saved {formatAccra(website.updatedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="starters-heading">
        <h2 id="starters-heading" className="text-lg font-semibold text-navy">
          Start from a Valmont template
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Pick the type of website your client needs. Valmont starts it on the
          layout that suits that type, and you can change the layout and theme
          in step 3 of the wizard.
        </p>
        <ul
          className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="template-starters"
        >
          {starters.map((starter) => {
            const Icon = CATEGORY_ICONS[starter.id] ?? Wand2;
            return (
              <li key={starter.id}>
                <Link
                  href={`/studio/drafts/new?type=${starter.id}`}
                  className="card card-hover group relative flex h-full flex-col p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-brandblue-50 text-brandblue ring-1 ring-inset ring-brandblue-100 transition-colors group-hover:bg-copper-50 group-hover:text-copper-700 group-hover:ring-copper-300">
                      <Icon
                        className="size-5"
                        strokeWidth={1.9}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="rounded-full bg-ivory-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-slate uppercase ring-1 ring-inset ring-line">
                      Template
                    </span>
                  </div>

                  <h3 className="mt-3.5 text-[15px] font-bold tracking-[-0.01em] text-navy">
                    {starter.label}
                  </h3>
                  <p className="mt-1 flex-1 text-[12.5px] leading-5 text-slate">
                    {starter.description}
                  </p>

                  <span className="mt-3.5 inline-flex items-center gap-1 text-[12px] font-bold text-brandblue transition-colors group-hover:text-copper-700">
                    Starts on “{starter.templateLabel}”
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-8" aria-labelledby="analytics-heading">
        <h2 id="analytics-heading" className="text-lg font-semibold text-navy">
          Sales analytics
        </h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white p-4">
          <div>
            <p className="text-sm font-semibold text-navy">
              See what customers are buying
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Review settled sales, top items, payment methods and busiest order
              times across your shop websites.
            </p>
          </div>
          <Link
            href="/studio/analytics"
            className="btn-secondary min-h-11 px-4"
            data-testid="analytics-link"
          >
            Open analytics
          </Link>
        </div>
      </section>

      <section className="mt-8" aria-labelledby="payments-heading">
        <h2 id="payments-heading" className="text-lg font-semibold text-navy">
          Payments
        </h2>
        <div
          className={`mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
            paymentConfig.liveActive
              ? "border-red-300 bg-red-50"
              : "border-line bg-white"
          }`}
          data-testid="payments-card"
        >
          <div>
            <p className="text-sm font-semibold text-navy">
              {paymentConfig.liveActive ? (
                <span className="text-red-700">
                  LIVE — real Mobile Money and card payments
                </span>
              ) : (
                "Test mode — pretend payments only"
              )}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {paymentConfig.liveActive
                ? "Customers are charged real money at checkout."
                : "No real money moves. Connect Valmont Pay when you are ready for real payments."}
            </p>
          </div>
          <Link
            href="/studio/settings/payments"
            className="btn-secondary min-h-11 px-4"
            data-testid="payment-settings-link"
          >
            Payment settings
          </Link>
        </div>
      </section>

      <section className="mt-8" aria-labelledby="backup-heading">
        <h2 id="backup-heading" className="text-lg font-semibold text-navy">
          Backup
        </h2>
        <div className="mt-3">
          <BackupControls />
        </div>
      </section>

      <p className="mt-4 text-xs text-slate-500">
        Your websites are stored in the same database file as your chats, or in
        PostgreSQL when DATABASE_URL is set. Only you can see them.
      </p>
    </div>
  );
}
