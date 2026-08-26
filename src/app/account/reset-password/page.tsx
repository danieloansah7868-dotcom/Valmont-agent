import Link from "next/link";
import { ResetPasswordForm } from "@/components/customer-account-forms";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token?.trim();

  return (
    <section className="mx-auto flex w-full max-w-[480px] justify-center px-5 py-12 sm:px-8 sm:py-20">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Customer account
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
          Choose a new password
        </h1>
        {token ? (
          <>
            <p className="mt-2 text-sm leading-6 text-slate">
              Use at least 10 characters. This link can only be used once.
            </p>
            <div className="mt-6">
              <ResetPasswordForm token={token} />
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-6 text-slate">
              This reset link is missing. Request a new one to continue.
            </p>
            <Link
              className="btn-primary mt-6 w-full"
              href="/account/forgot-password"
            >
              Request a new link
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
