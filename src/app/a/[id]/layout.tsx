import Link from "next/link";
import { notFound } from "next/navigation";
import { LogoMark } from "@/components/logo";
import { AgentLogoutButton } from "@/components/shop-agent/forms";
import { getShopAgentSession } from "@/lib/shop-agent/auth";
import { shopAgentsAllowed } from "@/lib/shop-agent/gate";
import { publicGetDraft } from "@/lib/studio/draft-public";

export const dynamic = "force-dynamic";

export default async function ShopAgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const draft = await publicGetDraft(id);
  if (!draft || !shopAgentsAllowed(draft.brief)) notFound();
  const session = await getShopAgentSession(id);
  const home = `/a/${encodeURIComponent(id)}`;
  return (
    <main className="min-h-screen bg-ivory-50">
      <header className="border-b border-line bg-paper/95">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href={home} className="flex min-w-0 items-center gap-2.5">
            <LogoMark />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[15px] font-bold text-navy">
                {draft.brief.businessName}
              </span>
              <span className="block text-[10px] font-semibold tracking-[0.12em] text-slate uppercase">
                Agent portal
              </span>
            </span>
          </Link>
          {session && (
            <div className="flex items-center gap-2">
              <nav
                aria-label="Agent portal"
                className="flex items-center gap-1 text-sm font-semibold"
              >
                <Link
                  href={home}
                  className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                >
                  Home
                </Link>
                <Link
                  href={`${home}/orders`}
                  className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                  data-testid="agent-nav-orders"
                >
                  Orders
                </Link>
                <Link
                  href={`${home}/wallet`}
                  className="rounded-md px-2.5 py-1.5 text-navy hover:bg-ivory-100"
                >
                  Statement
                </Link>
              </nav>
              <span className="hidden text-xs text-slate sm:inline">
                {session.agent.name}
              </span>
              <AgentLogoutButton draftId={id} />
            </div>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}
