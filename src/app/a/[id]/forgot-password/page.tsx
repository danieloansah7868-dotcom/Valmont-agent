import Link from "next/link";
import { AgentForgotPasswordForm } from "@/components/shop-agent/forms";

export const dynamic = "force-dynamic";

export default async function AgentForgotPasswordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="mx-auto flex w-full max-w-[440px] justify-center px-4 py-10 sm:px-6 sm:py-16">
      <div className="card w-full p-6 sm:p-8">
        <p className="text-xs font-bold tracking-[0.16em] text-copper-700 uppercase">
          Agent portal
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-navy">
          Forgot your password?
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate">
          Enter your email and we will send a link to choose a new password.
        </p>
        <div className="mt-6">
          <AgentForgotPasswordForm draftId={id} />
        </div>
        <p className="mt-6 border-t border-line pt-5 text-center text-sm text-slate">
          <Link
            href={`/a/${encodeURIComponent(id)}/login`}
            className="font-semibold text-copper-700 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </section>
  );
}
