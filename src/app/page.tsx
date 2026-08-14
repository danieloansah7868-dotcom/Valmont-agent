import Link from "next/link";
import {
  ArrowRight,
  Check,
  FileCode2,
  Github,
  GitPullRequest,
  LockKeyhole,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { Logo } from "@/components/logo";
import { githubConfigured } from "@/lib/auth";
import { demoModeEnabled, missingLiveRequirements } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string; auth_error?: string }>;
}) {
  const params = await searchParams;
  const configured = githubConfigured();
  const demoMode = demoModeEnabled();
  const missing = missingLiveRequirements();

  const notice =
    params.auth_error === "github"
      ? "GitHub sign-in did not complete. Check the OAuth callback URL and try again."
      : params.connect === "required"
        ? "Connect GitHub to open your workspace. Valmont works against your real repositories."
        : params.connect === "unconfigured"
          ? "GitHub OAuth is not configured on this server yet. Set the variables below and restart."
          : "";

  return (
    <main className="min-h-screen overflow-hidden bg-ivory-50">
      <nav className="mx-auto flex h-20 max-w-[1180px] items-center justify-between px-5 sm:px-8">
        <Logo href="/" />
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/docs/security"
            className="btn-quiet hidden sm:inline-flex"
          >
            Security model
          </Link>
          <Link href="/settings" className="btn-secondary">
            Setup
          </Link>
        </div>
      </nav>

      {notice && (
        <div className="mx-auto max-w-[1180px] px-5 sm:px-8">
          <p
            role="status"
            className="rounded-xl border border-copper-300 bg-copper-50 px-4 py-3 text-[12px] leading-5 font-semibold text-copper-700"
          >
            {notice}
          </p>
        </div>
      )}

      <section className="relative mx-auto grid max-w-[1180px] items-center gap-14 px-5 pt-14 pb-20 sm:px-8 sm:pt-20 lg:grid-cols-[1.03fr_0.97fr] lg:pt-24 lg:pb-28">
        <div className="relative z-10">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-brandblue">
              <ShieldCheck
                className="size-3.5 text-copper"
                aria-hidden="true"
              />
              Approval-first by design
            </span>
            {demoMode && <DemoBadge compact />}
          </div>
          <h1 className="text-balance max-w-[680px] text-[43px] leading-[1.06] font-[750] tracking-[-0.045em] text-navy sm:text-[58px]">
            Ship code with an agent you stay{" "}
            <span className="text-copper">in control of.</span>
          </h1>
          <p className="mt-6 max-w-[610px] text-[17px] leading-7 text-slate sm:text-lg">
            Valmont inspects your repository, proposes a plan, and waits. You
            approve every meaningful boundary — from implementation to pull
            request.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/api/auth/github"
              className="btn-primary min-h-12 px-5 text-[15px]"
            >
              <Github className="size-[18px]" aria-hidden="true" />
              {configured ? "Continue with GitHub" : "Connect GitHub"}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href="/docs/security"
              className="btn-secondary min-h-12 px-5 text-[15px]"
            >
              How the approvals work
            </Link>
          </div>

          {!configured && missing.length > 0 && (
            <div className="mt-8 rounded-xl border border-line bg-white p-4">
              <p className="text-[11px] font-bold text-navy">
                Server configuration required for live mode
              </p>
              <ul className="mt-2.5 flex flex-wrap gap-2">
                {missing.map((name) => (
                  <li
                    key={name}
                    className="rounded-md bg-ivory-100 px-2.5 py-1.5 text-[10px] font-bold text-slate-700 ring-1 ring-inset ring-line"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[12px] font-medium text-slate">
            {["Never merges", "Never deploys", "Server-side model keys"].map(
              (item) => (
                <span key={item} className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-copper" aria-hidden="true" />
                  {item}
                </span>
              ),
            )}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[570px] lg:mx-0">
          <div
            className="absolute -inset-16 -z-10 rounded-full bg-[radial-gradient(circle,#e3dfd1_0%,transparent_68%)]"
            aria-hidden="true"
          />
          <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_24px_70px_rgba(9,21,52,0.16)]">
            <div className="flex h-12 items-center justify-between border-b border-line bg-navy px-4">
              <div className="flex items-center gap-2" aria-hidden="true">
                <span className="size-2.5 rounded-full bg-copper" />
                <span className="size-2.5 rounded-full bg-brandblue-600" />
                <span className="size-2.5 rounded-full bg-ivory/40" />
              </div>
              <span className="text-[11px] font-semibold text-ivory/70">
                Task preview
              </span>
            </div>
            <div className="p-5 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="mb-1 text-[11px] font-bold tracking-[0.08em] text-slate uppercase">
                    your-org / your-repo
                  </p>
                  <h2 className="text-[18px] font-bold tracking-[-0.02em] text-navy">
                    Add empty state to project dashboard
                  </h2>
                </div>
                <span className="shrink-0 rounded-full bg-copper-50 px-2.5 py-1 text-[10px] font-bold text-copper-700 ring-1 ring-inset ring-copper-300">
                  Approval needed
                </span>
              </div>
              <div className="mt-6 space-y-2.5">
                {[
                  ["1", "Add an accessible empty project state", FileCode2],
                  ["2", "Preserve loading and populated paths", ShieldCheck],
                  ["3", "Add focused regression coverage", TerminalSquare],
                ].map(([number, text, Icon]) => (
                  <div
                    key={String(number)}
                    className="flex items-center gap-3 rounded-xl border border-line p-3.5"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brandblue-50 text-[11px] font-bold text-brandblue">
                      {String(number)}
                    </span>
                    <span className="flex-1 text-[13px] font-semibold text-navy">
                      {String(text)}
                    </span>
                    <Icon
                      className="size-4 text-slate-400"
                      aria-hidden="true"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-xl border border-copper-300 bg-copper-50 p-4">
                <div className="flex gap-3">
                  <LockKeyhole
                    className="mt-0.5 size-4 shrink-0 text-copper-700"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-[12px] font-bold text-copper-700">
                      Execution is locked
                    </p>
                    <p className="mt-1 text-[11px] leading-4 text-slate-700">
                      Review the plan before Valmont can change any file.
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <span className="btn-secondary pointer-events-none min-h-9 text-xs">
                  Reject plan
                </span>
                <span className="btn-primary pointer-events-none min-h-9 text-xs">
                  <Check className="size-3.5" aria-hidden="true" /> Approve &
                  execute
                </span>
              </div>
            </div>
          </div>
          <div className="absolute -right-5 -bottom-7 hidden items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-lg sm:flex">
            <span className="flex size-8 items-center justify-center rounded-full bg-copper-50 text-copper-700">
              <GitPullRequest className="size-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-[11px] font-bold text-navy">
                Human approval required
              </p>
              <p className="mt-0.5 text-[10px] text-slate">
                before every pull request
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-navy">
        <div className="mx-auto grid max-w-[1180px] gap-8 px-5 py-14 sm:grid-cols-3 sm:px-8">
          {[
            [
              "Private by default",
              "Credentials stay server-side. Sensitive files are excluded before retrieval or model context.",
            ],
            [
              "Restricted execution",
              "Workspaces enforce path boundaries, command allowlists, timeouts, and output limits.",
            ],
            [
              "Auditable decisions",
              "Every state transition, tool call, validation, and approval appears in a visible timeline.",
            ],
          ].map(([title, copy], index) => (
            <div key={title} className="flex gap-4">
              <span className="mt-0.5 text-[12px] font-bold text-copper">
                0{index + 1}
              </span>
              <div>
                <h3 className="text-sm font-bold text-ivory">{title}</h3>
                <p className="mt-2 text-[13px] leading-5 text-ivory/65">
                  {copy}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1180px] flex-col gap-3 px-5 py-8 text-xs text-slate sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <Logo href="/" />
        <p>Private coding agent · Always review generated code</p>
      </footer>
    </main>
  );
}
