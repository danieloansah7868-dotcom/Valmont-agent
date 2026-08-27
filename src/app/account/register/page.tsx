import Link from "next/link";
import { RegisterForm } from "@/components/customer-account-forms";

export const dynamic = "force-dynamic";

export default async function CustomerRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ claim?: string; next?: string }>;
}) {
  const params = await searchParams;
  const claimAccessCode = params.claim?.trim() || undefined;
  const next = params.next || "/account";

  return (
    <section className="mx-auto flex w-full max-w-[480px] justify-center px-5 py-12 sm:px-8 sm:py-20">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Customer account
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
          Create your account
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate">
          Accounts are optional. You can always continue checking out as a
          guest.
        </p>
        <div className="mt-6">
          <RegisterForm claimAccessCode={claimAccessCode} />
        </div>
        <p className="mt-6 border-t border-line pt-5 text-center text-sm text-slate">
          Already have an account?{" "}
          <Link
            href={`/account/login?next=${encodeURIComponent(next)}`}
            className="font-semibold text-copper-700 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </section>
  );
}
