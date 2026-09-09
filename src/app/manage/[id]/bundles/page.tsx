import { notFound } from "next/navigation";
import { BundleManager } from "@/components/shop-admin/bundle-manager";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { shopCatalogueView } from "@/lib/shop-admin/bundle-view";
import { can } from "@/lib/shop-admin/permissions";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { planAllows, planOf } from "@/lib/studio/plans";

export const dynamic = "force-dynamic";

/**
 * The shop's bundles (Stage 6c). Price edits for every package; Pause /
 * Resume only where the package includes it (`bundle_pause` — Auto-Dispatch
 * Pro and Command Center), which the page shows as the plain sentence
 * instead of the toggle rather than letting a Starter owner discover the
 * 403 by trying.
 *
 * A login without the "bundles.manage" box gets a 404, the same as a
 * stranger, and the page never receives or renders anything but the
 * catalogue projection — no payment settings, no `adminEmail`, no brief.
 */
export default async function ShopBundlesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(id, `${base}/bundles`);
  if (!can(session.admin, "bundles.manage")) notFound();

  const draft = await publicGetDraft(id);
  if (!draft || draft.brief.category !== "data-bundles") notFound();

  const plan = planOf(draft.brief);
  const items = shopCatalogueView(draft.brief.items);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">Bundles</h1>
      <p className="mt-1 text-sm text-slate">
        Change a price, or pause a bundle so customers cannot buy it while you
        sort out stock. Paused bundles disappear from the shop until you resume
        them; orders already placed keep their prices.
      </p>
      <div className="mt-5">
        <BundleManager
          draftId={id}
          items={items}
          canPause={planAllows(plan, "bundle_pause")}
        />
      </div>
    </div>
  );
}
