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

export default function LandingPage() {
  const configured = githubConfigured();
  return (
    <main className="min-h-screen overflow-hidden bg-[#f6f7f4]">
      <nav className="mx-auto flex h-20 max-w-[1180px] items-center justify-between px-5 sm:px-8">
        <Logo href="/" />
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/settings" className="btn-quiet hidden sm:inline-flex">
            Security & setup
          </Link>
          <Link href="/dashboard" className="btn-secondary">
            Open demo
          </Link>
        </div>
      </nav>

      <section className="relative mx-auto grid max-w-[1180px] items-center gap-14 px-5 pb-20 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.03fr_0.97fr] lg:pb-28 lg:pt-24">
        <div className="relative z-10">
          <div className="mb-6 flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#cddbd3] bg-white px-3 py-1.5 text-xs font-semibold text-[#315647]">
              <ShieldCheck className="size-3.5" /> Approval-first by design
            </span>
            {!configured && <DemoBadge compact />}
          </div>
          <h1 className="text-balance max-w-[680px] text-[43px] leading-[1.06] font-[750] tracking-[-0.045em] text-[#12251e] sm:text-[58px]">
            Ship code with an agent you stay in control of.
          </h1>
          <p className="mt-6 max-w-[610px] text-[17px] leading-7 text-[#5d6b66] sm:text-lg">
            Valmont inspects your repository, proposes a plan, and waits. You
            approve every meaningful boundary—from implementation to pull
            request.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/api/auth/github"
              className="btn-primary min-h-12 px-5 text-[15px]"
            >
              <Github className="size-[18px]" />
              {configured ? "Continue with GitHub" : "Explore with demo data"}
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/dashboard"
              className="btn-secondary min-h-12 px-5 text-[15px]"
            >
              View the approval workflow
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[12px] font-medium text-[#6b7873]">
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5 text-[#287358]" /> Never merges
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5 text-[#287358]" /> Never deploys
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5 text-[#287358]" /> Server-side model
              keys
            </span>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[570px] lg:mx-0">
          <div className="absolute -inset-16 -z-10 rounded-full bg-[radial-gradient(circle,#dcebe2_0%,transparent_68%)]" />
          <div className="overflow-hidden rounded-2xl border border-[#cfd9d3] bg-white shadow-[0_24px_70px_rgba(27,55,43,0.15)]">
            <div className="flex h-12 items-center justify-between border-b border-[#e1e7e3] bg-[#fbfcfb] px-4">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#df8d82]" />
                <span className="size-2.5 rounded-full bg-[#e6c26d]" />
                <span className="size-2.5 rounded-full bg-[#74b48e]" />
              </div>
              <span className="text-[11px] font-semibold text-[#79867f]">
                Task #1042
              </span>
            </div>
            <div className="p-5 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="mb-1 text-[11px] font-bold tracking-[0.08em] text-[#718079] uppercase">
                    acme-labs / atlas-web
                  </p>
                  <h2 className="text-[18px] font-bold tracking-[-0.02em]">
                    Add empty state to project dashboard
                  </h2>
                </div>
                <span className="shrink-0 rounded-full bg-[#fff3d5] px-2.5 py-1 text-[10px] font-bold text-[#905611]">
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
                    className="flex items-center gap-3 rounded-xl border border-[#e2e8e4] p-3.5"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#edf5f0] text-[11px] font-bold text-[#27634d]">
                      {String(number)}
                    </span>
                    <span className="flex-1 text-[13px] font-semibold text-[#34453e]">
                      {String(text)}
                    </span>
                    <Icon className="size-4 text-[#87958e]" />
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-xl border border-[#eadcb9] bg-[#fffaf0] p-4">
                <div className="flex gap-3">
                  <LockKeyhole className="mt-0.5 size-4 shrink-0 text-[#9a621e]" />
                  <div>
                    <p className="text-[12px] font-bold text-[#754a15]">
                      Execution is locked
                    </p>
                    <p className="mt-1 text-[11px] leading-4 text-[#8d704b]">
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
                  <Check className="size-3.5" /> Approve & execute
                </span>
              </div>
            </div>
          </div>
          <div className="absolute -right-5 -bottom-7 hidden items-center gap-3 rounded-xl border border-[#d7e0da] bg-white px-4 py-3 shadow-lg sm:flex">
            <span className="flex size-8 items-center justify-center rounded-full bg-[#e6f5ed] text-[#247052]">
              <GitPullRequest className="size-4" />
            </span>
            <div>
              <p className="text-[11px] font-bold">Human approval required</p>
              <p className="mt-0.5 text-[10px] text-[#728078]">
                before every pull request
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-[#dde4df] bg-white">
        <div className="mx-auto grid max-w-[1180px] gap-8 px-5 py-12 sm:grid-cols-3 sm:px-8">
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
              <span className="mt-0.5 text-[12px] font-bold text-[#34745a]">
                0{index + 1}
              </span>
              <div>
                <h3 className="text-sm font-bold">{title}</h3>
                <p className="mt-2 text-[13px] leading-5 text-[#68756f]">
                  {copy}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <footer className="mx-auto flex max-w-[1180px] flex-col gap-3 px-5 py-8 text-xs text-[#78847e] sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <Logo href="/" />
        <p>Private coding agent · Always review generated code</p>
      </footer>
    </main>
  );
}
