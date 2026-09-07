import { notFound } from "next/navigation";
import { TeamManager } from "@/components/shop-admin/team";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { shopAdminEmailConfigured } from "@/lib/shop-admin/email";
import { getShopAdminStore } from "@/lib/shop-admin/store";

export const dynamic = "force-dynamic";

/**
 * Team (Stage 6b). Owner only: a member who types the address gets a 404,
 * the same as a stranger, so the page does not even confirm it exists.
 */
export default async function ShopTeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(id, `${base}/team`);
  if (session.admin.role !== "owner") notFound();

  const admins = await getShopAdminStore().listForDraft(id);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">Team</h1>
      <p className="mt-1 text-sm text-slate">
        The people who can sign in to this shop. Tick what each person may do;
        you can change it or switch them off at any time.
      </p>
      <div className="mt-5">
        <TeamManager
          draftId={id}
          ownerId={session.admin.id}
          initialAdmins={admins}
          emailConfigured={shopAdminEmailConfigured()}
        />
      </div>
    </div>
  );
}
