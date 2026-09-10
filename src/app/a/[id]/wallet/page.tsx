import Link from "next/link";
import { requireShopAgentSession } from "@/lib/shop-agent/auth";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { formatMoney } from "@/lib/studio/money";
import { formatAccra } from "@/lib/studio/format";

export const dynamic = "force-dynamic";

/**
 * What one wallet row is called. Credits and deductions keep the exact 7a
 * wording; Stage 7b's order-bound rows name the order and link to it.
 */
function entryLabel(kind: string, amount: number): string {
  if (kind === "purchase") return "Purchase";
  if (kind === "refund") return "Refund";
  return amount >= 0 ? "Credit added" : "Credit removed";
}

export default async function AgentWalletPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireShopAgentSession(
    id,
    `/a/${encodeURIComponent(id)}/wallet`,
  );
  const entries = await getShopAgentStore().listEntries(session.agent.id, 100);
  const home = `/a/${encodeURIComponent(id)}`;
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">Wallet statement</h1>
      <p className="mt-1 text-sm text-slate">
        Your latest wallet changes, newest first.
      </p>
      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-white">
        {entries.length === 0 ? (
          <p className="p-4 text-sm text-slate">No wallet changes yet.</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0 sm:grid-cols-4 sm:gap-3"
                data-testid="agent-entry-row"
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
                  {entryLabel(entry.kind, entry.amount)}{" "}
                  {formatMoney(entry.amount)}
                </span>
                <span>Balance after: {formatMoney(entry.balanceAfter)}</span>
                <span className="text-slate">
                  {entry.orderId &&
                  (entry.kind === "purchase" || entry.kind === "refund") ? (
                    <Link
                      href={`${home}/orders/${encodeURIComponent(entry.orderId)}`}
                      className="font-semibold text-copper-700 hover:underline"
                      data-testid="agent-entry-order-link"
                    >
                      {entry.kind === "purchase" ? "Purchase" : "Refund"} -
                      Order {entry.orderId.slice(0, 8)}
                    </Link>
                  ) : (
                    entry.note || "—"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
