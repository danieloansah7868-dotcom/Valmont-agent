import Link from "next/link";
import { AgentResetPasswordForm } from "@/components/shop-agent/forms";

export const dynamic = "force-dynamic";

export default async function AgentResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  return (
    <section className="mx-auto flex w-full max-w-[440px] justify-center px-4 py-10 sm:px-6">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Agent portal
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
              <AgentResetPasswordForm draftId={id} token={token} />
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
              This link is missing its code
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate">
              Request a new reset link from the sign-in page.
            </p>
            <Link
              href={`/a/${encodeURIComponent(id)}/forgot-password`}
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
