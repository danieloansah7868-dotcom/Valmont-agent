import Link from "next/link";
import { Github, LockKeyhole } from "lucide-react";
import { githubConfigured } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Private entry point for the agency workspace. This is intentionally not a
 * public marketing page: it only gives authorised agency users a way in.
 */
export default async function AgencyAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string; auth_error?: string }>;
}) {
  const params = await searchParams;
  const configured = githubConfigured();
  const notice =
    params.auth_error === "github"
      ? "GitHub sign-in did not complete. Please try again."
      : params.connect === "unconfigured"
        ? "GitHub access has not been configured on this server yet."
        : params.connect === "required"
          ? "Sign in to open the agency workspace."
          : null;

  return (
    <main className="grid min-h-screen place-items-center bg-ivory-50 p-5">
      <section className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-xl bg-navy text-ivory">
          <LockKeyhole className="size-5" aria-hidden="true" />
        </div>
        <p className="mt-5 text-xs font-bold tracking-[0.14em] text-copper uppercase">
          Private agency workspace
        </p>
        <h1 className="mt-2 text-3xl font-bold text-navy">Valmont Agent</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          This workspace is for the Valmont agency team. Sign in with the
          authorised GitHub account to continue.
        </p>
        {notice && (
          <p
            role="status"
            className="mt-5 rounded-lg border border-copper-300 bg-copper-50 px-4 py-3 text-sm font-semibold text-copper-700"
          >
            {notice}
          </p>
        )}
        {configured ? (
          <Link
            href="/api/auth/github"
            className="btn-primary mt-6 inline-flex min-h-11 w-full justify-center"
          >
            <Github className="size-5" aria-hidden="true" />
            Sign in with GitHub
          </Link>
        ) : (
          <p className="mt-6 rounded-lg bg-ivory-100 p-4 text-sm text-slate-600">
            GitHub access must be configured before this workspace can be used.
          </p>
        )}
      </section>
    </main>
  );
}
