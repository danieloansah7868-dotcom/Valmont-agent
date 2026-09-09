import { notFound } from "next/navigation";
import { SupplierRefreshButton } from "@/components/shop-admin/supplier-actions";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { can } from "@/lib/shop-admin/permissions";
import {
  shopSupplierView,
  SUPPLIER_LOW_BALANCE_MESSAGE,
  SUPPLIER_NOT_CONNECTED_MESSAGE,
  TECHCHIEF_PORTAL_URL,
} from "@/lib/shop-admin/supplier";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { formatAccra } from "@/lib/studio/format";
import { getTechChiefIntegration } from "@/lib/studio/integrations";
import { planAllows, planOf } from "@/lib/studio/plans";

export const dynamic = "force-dynamic";

/** "TCHX-AB12•••" — the stored prefix plus bullets; never more of the key. */
function prefixed(keyPrefix: string | null): string | null {
  return keyPrefix ? `${keyPrefix}•••` : null;
}

/** "GHS 123.45", or "GHS —" when no balance was ever reported. */
function supplierMoney(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `GHS ${value.toFixed(2)}`
    : "GHS —";
}

const STATUS_PILL: Record<string, string> = {
  verified: "Connected",
  unverified: "Not verified",
  error: "Error",
};

/**
 * The shop's Supplier page (Stage 6d): the TechChief balance, the connected
 * key's prefix, the top-up link and a rate-limited Refresh button.
 *
 * The page never calls TechChief — it renders the last state the Studio card
 * and the refresh route stored — and it never receives the key beyond its
 * 9-character prefix or the webhook URL: the projection
 * ({@link shopSupplierView}) is built from the no-secret integration record.
 * On Starter (no `supplier_page`) the page does not exist: a 404, the same
 * as a stranger gets.
 */
export default async function ShopSupplierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(id, `${base}/supplier`);
  if (!can(session.admin, "supplier.manage")) notFound();

  const draft = await publicGetDraft(id);
  if (!draft || draft.brief.category !== "data-bundles") notFound();
  const plan = planOf(draft.brief);
  if (!planAllows(plan, "supplier_page")) notFound();

  // The no-secret reader; the view is all this page ever holds.
  const supplier = shopSupplierView(await getTechChiefIntegration(id));
  const connected = supplier.connected;
  const prefix = prefixed(supplier.keyPrefix);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">Supplier</h1>
      <p className="mt-1 text-sm text-slate">
        Your shop sends bundles through the TechChief supplier API. Top-ups are
        paid from your own TechChief wallet, so keep an eye on the balance here.
      </p>

      <div className="mt-5">
        <a
          href={TECHCHIEF_PORTAL_URL}
          target="_blank"
          rel="noopener"
          data-testid="shop-supplier-topup-link"
          className="btn-secondary text-xs"
        >
          Top up at TechChief
        </a>
      </div>

      {!connected ? (
        <section
          className="mt-5 rounded-xl border border-line bg-white p-4"
          data-testid="shop-supplier-not-connected"
        >
          <p className="text-sm text-navy">{SUPPLIER_NOT_CONNECTED_MESSAGE}</p>
          <p className="mt-1 text-xs text-slate-600">
            Once a key is connected, this page shows your wallet balance and the
            bundles TechChief can deliver.
          </p>
        </section>
      ) : (
        <>
          <section className="mt-5 rounded-xl border border-line bg-white p-4">
            <dl className="grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Wallet balance</dt>
                <dd
                  className="text-xl font-bold text-navy"
                  data-testid="shop-supplier-balance"
                >
                  {supplierMoney(supplier.walletBalance)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Connection</dt>
                <dd className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      supplier.status === "error"
                        ? "bg-red-100 text-red-800"
                        : "bg-green-100 text-green-800"
                    }`}
                    data-testid="shop-supplier-status"
                  >
                    {STATUS_PILL[supplier.status ?? ""] ?? "Unknown"}
                  </span>
                  {prefix && (
                    <span
                      className="font-mono text-xs text-slate-600"
                      data-testid="shop-supplier-key-prefix"
                    >
                      {prefix}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Last checked</dt>
                <dd
                  className="text-navy"
                  data-testid="shop-supplier-last-checked"
                >
                  {supplier.lastCheckedAt
                    ? formatAccra(supplier.lastCheckedAt)
                    : "Never"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">TechChief requests</dt>
                <dd className="text-navy" data-testid="shop-supplier-requests">
                  Requests used this hour: {supplier.requestsThisHour} of{" "}
                  {supplier.requestsPerHour}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Bundles</dt>
                <dd className="text-navy" data-testid="shop-supplier-bundles">
                  {supplier.bundleCount} available
                  {supplier.bundlesSyncedAt
                    ? ` · synced ${formatAccra(supplier.bundlesSyncedAt)}`
                    : ""}
                </dd>
              </div>
            </dl>
            <div className="mt-4 border-t border-line pt-3">
              <SupplierRefreshButton draftId={id} />
            </div>
          </section>

          {supplier.lowBalance && (
            <div
              className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900"
              data-testid="shop-supplier-low-balance"
            >
              {SUPPLIER_LOW_BALANCE_MESSAGE}
            </div>
          )}

          {supplier.status === "error" && (
            <div
              className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm"
              data-testid="shop-supplier-error"
            >
              <p className="font-semibold text-red-800">
                {supplier.lastError ?? "The TechChief connection has an error."}
              </p>
              <p className="mt-1 text-red-700">
                Ask your agency to save a new key in Studio.
              </p>
            </div>
          )}
        </>
      )}

      {planAllows(plan, "second_supplier") && (
        <section
          className="mt-4 rounded-xl border border-line bg-white p-4"
          data-testid="shop-supplier-second"
        >
          <h2 className="text-sm font-semibold text-navy">
            Second supplier (backup)
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Not connected. A backup supplier can be added here when one is
            chosen.
          </p>
        </section>
      )}
    </div>
  );
}
