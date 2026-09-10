import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShopAdminSession } from "@/lib/shop-admin/auth";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { planAllows, planOf } from "@/lib/studio/plans";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

export default async function ShopAgentStatementPage({
  params,
}: {
  params: Promise<{ id: string; agentId: string }>;
}) {
  const { id, agentId } = await params;
  const base = `/manage/${encodeURIComponent(id)}`;
  const session = await requireShopAdminSession(
    id,
    `${base}/agents/${encodeURIComponent(agentId)}`,
  );
  if (session.admin.role !== "owner") notFound();
  const draft = await publicGetDraft(id);
  if (!draft || draft.brief.category !== "data-bundles") notFound();
  if (!planAllows(planOf(draft.brief), "wallets")) notFound();
  const store = getShopAgentStore();
  const agent = await store.getById(agentId);
  if (!agent || agent.draftId !== id) notFound();
  const entries = await store.listEntries(agentId, 100);
  const admins = await getShopAdminStore().listForDraft(id);
  const adminNames = new Map(admins.map((admin) => [admin.id, admin.name]));

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Link
        href={`${base}/agents`}
        className="text-sm font-semibold text-copper-700 hover:underline"
      >
        ← Agents
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">
            {agent.name}&apos;s statement
          </h1>
          <p className="mt-1 text-sm text-slate">{agent.email}</p>
        </div>
        <p className="text-lg font-bold text-navy">
          {formatMoney(agent.balance)}
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-slate">No wallet changes yet.</p>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border border-line bg-white">
          <div className="hidden grid-cols-5 gap-3 border-b border-line bg-ivory-50 px-4 py-3 text-xs font-semibold text-slate sm:grid">
            <span>When</span>
            <span>Change</span>
            <span>Balance after</span>
            <span>Note</span>
            <span>Done by</span>
          </div>
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0 sm:grid-cols-5 sm:gap-3"
                data-testid="shop-agent-entry-row"
              >
                <span className="text-xs text-slate">
                  {formatAccra(entry.createdAt)}
                </span>
                <span
                  className={
                    entry.amount >= 0
                      ? "font-semibold text-emerald-700"
                      : "font-semibold text-red-700"
                  }
                >
                  {entry.amount >= 0 ? "Credit added" : "Credit removed"}{" "}
                  {formatMoney(entry.amount)}
                </span>
                <span>{formatMoney(entry.balanceAfter)}</span>
                <span className="text-slate">{entry.note || "—"}</span>
                <span>
                  {adminNames.get(entry.createdBy) || entry.createdBy}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
