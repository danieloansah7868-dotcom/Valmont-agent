import Link from "next/link";
import { ShopResetPasswordForm } from "@/components/shop-admin/forms";

export const dynamic = "force-dynamic";

export default async function ShopResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  const base = `/manage/${encodeURIComponent(id)}`;
  return (
    <section className="mx-auto flex w-full max-w-[440px] justify-center px-4 py-10 sm:px-6 sm:py-16">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Shop admin
        </p>
        {token ? (
          <>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
              Choose a new password
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Everyone signed in with the old password will be signed out.
            </p>
            <div className="mt-6">
              <ShopResetPasswordForm draftId={id} token={token} />
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
              This link is missing its code
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Open the reset link exactly as it was sent to you, or request a
              new one.
            </p>
            <Link
              href={`${base}/forgot-password`}
              className="btn-secondary mt-6"
            >
              Request a new link
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
