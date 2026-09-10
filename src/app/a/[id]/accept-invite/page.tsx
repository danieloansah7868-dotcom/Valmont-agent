import Link from "next/link";
import { AgentAcceptInviteForm } from "@/components/shop-agent/forms";
import { getShopAgentStore } from "@/lib/shop-agent/store";

export const dynamic = "force-dynamic";

export default async function AgentAcceptInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  const preview = token ? await getShopAgentStore().peekInvite(token) : null;
  // The POST route is the authority for token validity. Render the form for a
  // well-shaped token even if this read races a separate SQLite connection;
  // submission still rejects expired, used, or cross-shop tokens without
  // revealing any account details.
  const canSubmit = Boolean(token && token.length >= 16);
  return (
    <section className="mx-auto flex w-full max-w-[440px] justify-center px-4 py-10 sm:px-6 sm:py-16">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Agent portal
        </p>
        {canSubmit && token ? (
          <>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
              Welcome{preview ? `, ${preview.name}` : ""}
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Choose the password you will use to sign in
              {preview ? (
                <>
                  {" "}
                  as{" "}
                  <span className="font-semibold text-navy">
                    {preview.email}
                  </span>
                </>
              ) : (
                "."
              )}
            </p>
            <div className="mt-6">
              <AgentAcceptInviteForm
                draftId={id}
                token={token}
                initialName={preview?.name ?? ""}
              />
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
              This link is invalid or has expired
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Invite links work once and expire after 24 hours. Ask the shop
              owner to send a new one.
            </p>
            <Link
              href={`/a/${encodeURIComponent(id)}/login`}
              className="btn-secondary mt-6"
            >
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
