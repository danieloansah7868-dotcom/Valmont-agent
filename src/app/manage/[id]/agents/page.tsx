import { notFound } from "next/navigation";
import { AgentsManager } from "@/components/shop-admin/agents";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { shopAgentEmailConfigured } from "@/lib/shop-agent/email";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { planAllows, planOf } from "@/lib/studio/plans";

export const dynamic = "force-dynamic";

export default async function ShopAgentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(id, `${base}/agents`);
  if (session.admin.role !== "owner") notFound();
  const draft = await publicGetDraft(id);
  if (!draft || draft.brief.category !== "data-bundles") notFound();
  if (!planAllows(planOf(draft.brief), "wallets")) notFound();
  const store = getShopAgentStore();
  const [agents, settings] = await Promise.all([
    store.listForDraft(id),
    store.getSettings(id),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">Agents</h1>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate">
        Your agents buy bundles from their wallet at your agent price. Only you
        can add credit or remove it; every change is written in the statement.
      </p>
      <div className="mt-5">
        <AgentsManager
          draftId={id}
          initialAgents={agents}
          initialDiscount={settings.discountPercent}
          emailConfigured={shopAgentEmailConfigured()}
        />
      </div>
    </div>
  );
}
