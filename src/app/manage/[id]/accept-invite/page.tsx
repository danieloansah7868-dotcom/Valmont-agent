import Link from "next/link";
import { ShopAcceptInviteForm } from "@/components/shop-admin/forms";
import { getShopAdminStore } from "@/lib/shop-admin/store";

export const dynamic = "force-dynamic";

/**
 * The page behind an invite link. It reads the token only to prefill the
 * person's name and to say plainly when the link is dead; the token is not
 * consumed until the form is submitted, so refreshing this page is harmless.
 */
export default async function ShopAcceptInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  const invited = token ? await getShopAdminStore().peekInvite(token) : null;
  // A link minted for another shop's login is not valid on this shop's page.
  const preview = invited && invited.draftId === id ? invited : null;
  const base = `/manage/${encodeURIComponent(id)}`;

  return (
    <section className="mx-auto flex w-full max-w-[440px] justify-center px-4 py-10 sm:px-6 sm:py-16">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Shop admin
        </p>
        {preview && token ? (
          <>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
              Welcome, {preview.name}
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Choose the password you will use to sign in as{" "}
              <span className="font-semibold text-navy">{preview.email}</span>.
            </p>
            <div className="mt-6">
              <ShopAcceptInviteForm
                draftId={id}
                token={token}
                initialName={preview.name}
              />
            </div>
          </>
        ) : (
          <>
            <h1
              className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy"
              data-testid="shop-invite-invalid"
            >
              This link is invalid or has expired
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Invite links work once and expire after 24 hours. Ask whoever
              invited you to send a new one.
            </p>
            <Link href={`${base}/login`} className="btn-secondary mt-6">
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
