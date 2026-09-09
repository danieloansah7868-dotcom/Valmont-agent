import Link from "next/link";
import { notFound } from "next/navigation";
import { LogoMark } from "@/components/logo";
import { ShopLogoutButton } from "@/components/shop-admin/forms";
import { getShopAdminSession } from "@/lib/shop-admin/auth";
import { can } from "@/lib/shop-admin/permissions";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { PLAN_LABELS, planAllows, planOf } from "@/lib/studio/plans";

export const dynamic = "force-dynamic";

/**
 * The shop admin side (Stage 6b) has its own frame. It is deliberately *not*
 * the Studio `AppShell`: a shop owner is not an agency user, must never see
 * the agency navigation, and signs in with a different cookie. The header
 * shows the shop's own name, its commercial package, and — only when
 * somebody is signed in — a Logout button and the Orders / Team nav.
 *
 * An unknown website id is a 404 before anything renders, sign-in pages
 * included, so the login form cannot be used to probe for ids.
 *
 * Stage 6c adds a "Bundles" nav link for exactly the logins holding the
 * "bundles.manage" box (the owner always holds it), next to Orders.
 *
 * Stage 6d adds "Supplier" (for logins holding "supplier.manage" on a
 * package that includes the supplier page) and "Reports" (for logins holding
 * "reports.view" on a package that includes reports) — each link needs BOTH
 * the permission box and the package, so a Starter owner never sees a link
 * to a page that does not exist.
 */
export default async function ShopAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const draft = await publicGetDraft(id);
  if (!draft) notFound();

  const session = await getShopAdminSession(id);
  const plan = planOf(draft.brief);
  const home = `/manage/${encodeURIComponent(id)}`;

  return (
    <main className="min-h-screen bg-ivory-50">
      <header className="border-b border-line bg-paper/95">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href={home} className="flex min-w-0 items-center gap-2.5">
            <LogoMark />
            <span className="min-w-0 leading-tight">
              <span
                className="block truncate text-[15px] font-bold text-navy"
                data-testid="shop-admin-name"
              >
                {draft.brief.businessName}
              </span>
              <span
                className="block text-[10px] font-semibold tracking-[0.12em] text-slate uppercase"
                data-testid="shop-admin-plan"
              >
                {PLAN_LABELS[plan]}
                {plan === "starter" ? " · Manual delivery" : ""}
              </span>
            </span>
          </Link>
          {session && (
            <div className="flex items-center gap-1 sm:gap-2">
              <nav
                aria-label="Shop admin"
                className="flex items-center gap-1 text-sm font-semibold"
              >
                <Link
                  href={home}
                  className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                >
                  Orders
                </Link>
                {can(session.admin, "bundles.manage") && (
                  <Link
                    href={`${home}/bundles`}
                    className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                    data-testid="shop-admin-bundles-link"
                  >
                    Bundles
                  </Link>
                )}
                {can(session.admin, "supplier.manage") &&
                  planAllows(plan, "supplier_page") && (
                    <Link
                      href={`${home}/supplier`}
                      className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                      data-testid="shop-admin-supplier-link"
                    >
                      Supplier
                    </Link>
                  )}
                {can(session.admin, "reports.view") &&
                  planAllows(plan, "reports") && (
                    <Link
                      href={`${home}/reports`}
                      className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                      data-testid="shop-admin-reports-link"
                    >
                      Reports
                    </Link>
                  )}
                {session.admin.role === "owner" && (
                  <Link
                    href={`${home}/team`}
                    className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                    data-testid="shop-admin-team-link"
                  >
                    Team
                  </Link>
                )}
              </nav>
              <ShopLogoutButton draftId={id} />
            </div>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}
