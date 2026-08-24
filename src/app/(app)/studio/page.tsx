import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { getDomainStore } from "@/lib/studio/domains";
import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import { getCategory } from "@/lib/studio/categories";
import { BackupControls } from "@/components/studio/backup-controls";
import { BusinessSwitcher } from "@/components/studio/business-switcher";
import { ShareLinkButton } from "@/components/studio/share-link-button";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore, type OrderRecord } from "@/lib/studio/orders";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { resolvePaymentConfig } from "@/lib/studio/payment-settings";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string }>;
}) {
  const user = await requireSessionUser();
  const { business: requestedBusinessId } = await searchParams;
  const drafts = await getStudioDraftStore().list(user);
  const ownerId = canonicalUserId(user);
  const activeBusiness = drafts.find(
    (draft) => draft.id === requestedBusinessId,
  );
  const businesses = drafts.map((draft) => ({
    id: draft.id,
    name: draft.brief.businessName,
  }));
  const businessNames = new Map(
    businesses.map((business) => [business.id, business.name]),
  );
  const domains = await getDomainStore().getDomainsForOwner(ownerId);
  const paymentConfig = await resolvePaymentConfig();

  const hasShop = drafts.some((draft) => draft.brief.payments?.enabled);
  let orders: OrderRecord[] = [];
  if (hasShop) {
    orders = await getOrdersStore().listForOwner(
      ownerId,
      activeBusiness
        ? { limit: 10, filter: "all", draftId: activeBusiness.id }
        : 10,
    );
  }

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-navy">Website Studio</h1>
      <p className="mt-2 text-sm text-slate">
        Plan a website: choose the type, the package, the look, and fill in your
        business details. Everything saves as you type, and you can come back to
        it later on any device.
      </p>

      <Link
        href="/studio/drafts/new"
        className="btn-primary mt-5 inline-flex w-full justify-center sm:w-auto"
        data-testid="start-new-website"
      >
        Start new website
      </Link>

      {drafts.length > 0 && (
        <section
          className="mt-8 rounded-xl border border-brandblue/20 bg-brandblue/5 p-4 sm:p-5"
          aria-labelledby="business-switcher-heading"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold tracking-wide text-brandblue uppercase">
                Multi-business workspace
              </p>
              <h2
                id="business-switcher-heading"
                className="mt-1 text-lg font-semibold text-navy"
              >
                Switch business
              </h2>
              <p className="mt-1 max-w-xl text-sm text-slate-600">
                Jump between your websites without searching through your
                drafts. Your business list and orders are private to your
                account.
              </p>
            </div>
            <BusinessSwitcher
              businesses={businesses}
              selectedBusinessId={activeBusiness?.id}
              basePath="/studio"
            />
          </div>
          {activeBusiness ? (
            <div className="mt-4 flex flex-col gap-3 rounded-lg border border-brandblue/20 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-600">
                  Selected business
                </p>
                <p className="mt-1 font-semibold text-navy">
                  {activeBusiness.brief.businessName}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/studio/drafts/${activeBusiness.id}`}
                  className="btn-secondary min-h-10 text-sm"
                >
                  Open website
                </Link>
                <Link
                  href={`/studio/orders?business=${encodeURIComponent(activeBusiness.id)}`}
                  className="btn-primary min-h-10 text-sm"
                >
                  View its orders
                </Link>
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-line bg-white p-3 text-sm text-slate-600">
              Choose a business above to focus its website and orders, or keep
              “All businesses” selected to see your workspace together.
            </p>
          )}
        </section>
      )}

      <section className="mt-8" aria-labelledby="your-drafts">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="your-drafts" className="text-lg font-semibold text-navy">
            Your drafts
          </h2>
          {activeBusiness && (
            <span className="rounded-full bg-brandblue/10 px-2.5 py-1 text-xs font-semibold text-brandblue">
              Selected {activeBusiness.brief.businessName}
            </span>
          )}
        </div>
        {drafts.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            You have no drafts yet. Use “Start new website” above to make your
            first one.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3" data-testid="draft-list">
            {drafts.map((draft) => {
              const completeness = computeBriefCompleteness(draft.brief);
              const category = getCategory(draft.brief.category);
              const domain = domains.find((d) => d.draft_id === draft.id);
              return (
                <li
                  key={draft.id}
                  className={`rounded-xl border bg-white p-4 ${
                    activeBusiness?.id === draft.id
                      ? "border-brandblue ring-2 ring-brandblue/10"
                      : "border-line"
                  }`}
                >
                  <Link
                    href={`/studio/drafts/${draft.id}`}
                    className="text-base font-semibold text-navy underline"
                  >
                    {draft.brief.businessName}
                  </Link>
                  <p className="mt-1 text-xs text-slate-600">
                    {category?.label ?? draft.brief.category} · Brief{" "}
                    {completeness.score}% complete ·{" "}
                    {completeness.missingRequired.length} required item
                    {completeness.missingRequired.length === 1 ? "" : "s"} left
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Last saved {formatAccra(draft.updatedAt)}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <ShareLinkButton draftId={draft.id} compact />
                    <Link
                      href={`/studio/drafts/${draft.id}#custom-domain-card`}
                      className="text-xs font-medium text-navy underline"
                      data-testid="custom-domain-link"
                    >
                      {domain ? "Custom domain" : "Set up a custom domain"}
                    </Link>
                  </div>
                  {domain && domain.status === "active" && (
                    <p className="mt-2 text-xs text-slate-500">
                      Connected domain:{" "}
                      <a
                        href={`http://${domain.hostname}`}
                        target="_blank"
                        className="underline"
                      >
                        {domain.hostname}
                      </a>
                    </p>
                  )}
                  {domain && domain.status !== "active" && (
                    <p className="mt-2 text-xs text-amber-600">
                      Domain {domain.hostname} (
                      {domain.status === "pending"
                        ? "waiting for DNS"
                        : "configuration problem"}
                      )
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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

      {hasShop && (
        <section className="mt-8" aria-labelledby="orders-heading">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2
                id="orders-heading"
                className="text-lg font-semibold text-navy"
              >
                {activeBusiness
                  ? `${activeBusiness.brief.businessName} orders`
                  : "Recent orders"}
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                {activeBusiness
                  ? "Recent orders for the selected business."
                  : "Recent orders from all your businesses."}
              </p>
            </div>
            <Link
              href={
                activeBusiness
                  ? `/studio/orders?business=${encodeURIComponent(activeBusiness.id)}`
                  : "/studio/orders"
              }
              className="text-sm font-semibold text-brandblue underline"
            >
              View all orders
            </Link>
          </div>
          {orders.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">
              No orders yet. When a customer checks out, their order appears
              here.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2" data-testid="orders-list">
              {orders.map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/studio/orders/${order.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white p-3 hover:border-copper"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-brandblue">
                        {businessNames.get(order.draftId) ??
                          "Business no longer in Studio"}
                      </p>
                      <p className="text-sm font-semibold text-navy">
                        {order.customerName} · {order.id.slice(0, 8)}
                      </p>
                      <p className="text-xs text-slate-600">
                        {formatAccra(order.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          STATUS_BADGE_CLASS[order.status] ??
                          "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {STATUS_LABELS[order.status]}
                      </span>
                      <span className="text-sm font-semibold">
                        {formatMoney(order.total, order.currency)}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="mt-8" aria-labelledby="backup-heading">
        <h2 id="backup-heading" className="text-lg font-semibold text-navy">
          Backup
        </h2>
        <div className="mt-3">
          <BackupControls />
        </div>
      </section>

      <p className="mt-4 text-xs text-slate-500">
        Drafts are stored in the same database file as your chats, or in
        PostgreSQL when DATABASE_URL is set.
      </p>
    </div>
  );
}
