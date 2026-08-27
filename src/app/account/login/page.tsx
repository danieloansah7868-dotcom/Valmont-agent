import Link from "next/link";
import {
  LoginForm,
  ResendVerificationForm,
} from "@/components/customer-account-forms";

export const dynamic = "force-dynamic";

export default async function CustomerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; verified?: string }>;
}) {
  const params = await searchParams;
  const next = params.next || "/account";
  const verificationMessage =
    params.verified === "success"
      ? "Your email has been verified. You can now sign in."
      : params.verified === "invalid"
        ? "That verification link is invalid or has expired. Request a new account email if needed."
        : undefined;

  return (
    <section className="mx-auto flex w-full max-w-[480px] justify-center px-5 py-12 sm:px-8 sm:py-20">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Customer account
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
          Welcome back
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate">
          Sign in to see your Valmont orders and keep future purchases together.
        </p>
        {verificationMessage ? (
          <p className="mt-5 rounded-lg bg-pass-soft px-3 py-2 text-sm text-pass-strong">
            {verificationMessage}
          </p>
        ) : null}
        <div className="mt-6">
          <LoginForm next={next} />
        </div>
        <div className="mt-6 border-t border-line pt-5">
          <p className="text-sm font-semibold text-navy">
            Need another verification email?
          </p>
          <p className="mt-1 text-xs leading-5 text-slate">
            We will send one only when the address belongs to an unverified
            account.
          </p>
          <div className="mt-3">
            <ResendVerificationForm />
          </div>
        </div>
        <p className="mt-6 border-t border-line pt-5 text-center text-sm text-slate">
          New to Valmont?{" "}
          <Link
            href={`/account/register?next=${encodeURIComponent(next)}`}
            className="font-semibold text-copper-700 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
    </section>
  );
}
