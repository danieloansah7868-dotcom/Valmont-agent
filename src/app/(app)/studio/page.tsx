import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import { getCategory } from "@/lib/studio/categories";
import { BackupControls } from "@/components/studio/backup-controls";
import { ShareLinkButton } from "@/components/studio/share-link-button";
import { canonicalUserId } from "@/lib/user-identity";
import { getOrdersStore, type OrderRecord } from "@/lib/studio/orders";
import { formatMoney } from "@/lib/studio/valmont-pay";
import { resolvePaymentConfig } from "@/lib/studio/payment-settings";
import { STATUS_BADGE_CLASS, STATUS_LABELS } from "@/lib/studio/order-status";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const user = await requireSessionUser();
  const drafts = await getStudioDraftStore().list(user);
  const paymentConfig = await resolvePaymentConfig();

  const hasShop = drafts.some((draft) => draft.brief.payments?.enabled);
  let orders: OrderRecord[] = [];
  if (hasShop) {
    orders = await getOrdersStore().listForOwner(canonicalUserId(user), 10);
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

      <section className="mt-8" aria-labelledby="your-drafts">
        <h2 id="your-drafts" className="text-lg font-semibold text-navy">
          Your drafts
        </h2>
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
              return (
                <li
                  key={draft.id}
                  className="rounded-xl border border-line bg-white p-4"
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
                  <div className="mt-3">
                    <ShareLinkButton draftId={draft.id} compact />
                  </div>
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
            <h2 id="orders-heading" className="text-lg font-semibold text-navy">
              Recent orders
            </h2>
            <Link
              href="/studio/orders"
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

      <section
        className="mt-8 rounded-xl border border-line bg-white p-4"
        aria-labelledby="not-yet-heading"
      >
        <h2 id="not-yet-heading" className="text-sm font-semibold">
          Not working yet — planned for later phases
        </h2>
        <ul className="mt-2 list-disc pl-4 text-xs text-slate-600">
          <li>Custom domain for this website — Phase 5</li>
        </ul>
      </section>

      <p className="mt-4 text-xs text-slate-500">
        Drafts are stored in the same database file as your chats, or in
        PostgreSQL when DATABASE_URL is set.
      </p>
    </div>
  );
}
