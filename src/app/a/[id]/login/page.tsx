import { redirect } from "next/navigation";
import { AgentLoginForm } from "@/components/shop-agent/forms";
import {
  getShopAgentSession,
  safeAgentReturnPath,
} from "@/lib/shop-agent/auth";

export const dynamic = "force-dynamic";

export default async function AgentLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { id } = await params;
  const { next } = await searchParams;
  const target = safeAgentReturnPath(id, next);
  if (await getShopAgentSession(id)) redirect(target);
  return (
    <section className="mx-auto flex w-full max-w-[440px] justify-center px-4 py-10 sm:px-6 sm:py-16">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Agent portal
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
          Sign in
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate">
          Use the email and password you set when you accepted your invite.
        </p>
        <div className="mt-6">
          <AgentLoginForm draftId={id} next={target} />
        </div>
      </div>
    </section>
  );
}
