import { requireShopAgentSession } from "@/lib/shop-agent/auth";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import { agentPrice } from "@/lib/shop-agent/pricing";
import { AgentBuyPanel } from "@/components/shop-agent/buy";
import {
  groupBundlesByNetwork,
  bundleNetworkLabel,
  type BundleNetworkId,
} from "@/lib/studio/bundles";
import { formatMoney } from "@/lib/studio/money";
import { publicGetDraft } from "@/lib/studio/draft-public";

export const dynamic = "force-dynamic";

export default async function AgentHomePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireShopAgentSession(
    id,
    `/a/${encodeURIComponent(id)}`,
  );
  const draft = await publicGetDraft(id);
  if (!draft) return null;
  const store = getShopAgentStore();
  const settings = await store.getSettings(id);
  const grouped = groupBundlesByNetwork(draft.brief.items);
  const networks = Object.keys(grouped) as BundleNetworkId[];
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-navy">
        Welcome, {session.agent.name}
      </h1>
      <div
        className="mt-5 rounded-2xl bg-navy p-5 text-ivory"
        data-testid="agent-balance"
      >
        <p className="text-xs font-semibold tracking-[0.14em] uppercase opacity-75">
          Wallet balance
        </p>
        <p className="mt-2 text-3xl font-bold">
          {formatMoney(session.agent.balance)}
        </p>
        {session.agent.balance === 0 && (
          <p className="mt-2 text-sm opacity-85">
            Your wallet is empty. Ask {draft.brief.businessName} to add credit.
          </p>
        )}
      </div>
      <p
        className="mt-4 text-sm font-semibold text-navy"
        data-testid="agent-discount"
      >
        {settings.discountPercent > 0
          ? `Your price: ${settings.discountPercent}% below the shop price.`
          : "Your price: the shop price."}
      </p>
      <div className="mt-6 grid gap-5">
        {networks.map(
          (network) =>
            grouped[network].length > 0 && (
              <section key={network}>
                <h2 className="text-lg font-bold text-navy">
                  {bundleNetworkLabel(network)}
                </h2>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {grouped[network].map((item) => {
                    // The price the panel previews and the server re-derives
                    // — the browser only ever shows it, never posts it (R1).
                    const price = agentPrice(
                      item.price ?? 0,
                      settings.discountPercent,
                    );
                    return (
                      <li
                        key={item.id}
                        className="rounded-xl border border-line bg-white p-4"
                        data-testid="agent-bundle-row"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold text-navy">
                            {item.name}
                          </span>
                          <span className="text-sm text-slate line-through">
                            {formatMoney(item.price ?? 0)}
                          </span>
                        </div>
                        <p
                          className="mt-1 text-lg font-bold text-copper-700"
                          data-testid="agent-bundle-price"
                        >
                          {formatMoney(price)}
                        </p>
                        {item.description && (
                          <p className="text-xs text-slate">
                            {item.description}
                          </p>
                        )}
                        <AgentBuyPanel
                          draftId={id}
                          itemId={item.id}
                          itemName={item.name}
                          unitPrice={price}
                          balance={session.agent.balance}
                          businessName={draft.brief.businessName}
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
        )}
      </div>
    </div>
  );
}
