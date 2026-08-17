import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  Bot,
  Cpu,
  Database,
  Globe,
  Layers,
  LockKeyhole,
  Megaphone,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Wallet,
  Wrench,
} from "lucide-react";
import { Logo, LogoMark } from "@/components/logo";

export const dynamic = "force-static";

type Venture = {
  slug: string;
  name: string;
  shortLabel: string;
  tagline: string;
  description: string;
  icon: typeof Wallet;
  category: string;
  href?: string;
  live?: boolean;
};

const ventures: Venture[] = [
  {
    slug: "valmont-pay",
    name: "Valmont Pay",
    shortLabel: "Pay",
    tagline: "Payments, simplified.",
    description:
      "A private payments layer for sending, receiving, and settling money across wallets, cards, and accounts.",
    icon: Wallet,
    category: "Fintech",
  },
  {
    slug: "valmont-data",
    name: "Valmont Data",
    shortLabel: "Data",
    tagline: "Data that decides.",
    description:
      "Internal pipelines, analytics, and insights that turn raw activity into decisions — kept inside the workspace.",
    icon: Database,
    category: "Data & Analytics",
  },
  {
    slug: "valmont-electrical",
    name: "Valmont Electrical",
    shortLabel: "Electrical",
    tagline: "Power, done properly.",
    description:
      "Electrical installation, maintenance, and smart-power work for homes, businesses, and industrial sites.",
    icon: PlugZap,
    category: "Services",
  },
  {
    slug: "valmont-gadgets",
    name: "Valmont Gadgets",
    shortLabel: "Gadgets",
    tagline: "Tech you can trust.",
    description:
      "Phones, accessories, and smart devices — sourced, checked, and supported with after-sales care.",
    icon: Cpu,
    category: "Retail",
  },
  {
    slug: "valmont-web",
    name: "Valmont Web",
    shortLabel: "Web",
    tagline: "Websites that work.",
    description:
      "Design and engineering for fast, responsive websites and web apps that look sharp and convert visitors.",
    icon: Globe,
    category: "Web",
  },
  {
    slug: "valmont-ecosystem",
    name: "Valmont Ecosystem",
    shortLabel: "Ecosystem",
    tagline: "One connected network.",
    description:
      "The connecting layer across every Valmont product — shared identity, payments, data, and tooling under one roof.",
    icon: Layers,
    category: "Platform",
  },
  {
    slug: "valmont-bank",
    name: "Valmont Bank",
    shortLabel: "Bank",
    tagline: "Banking, rebuilt.",
    description:
      "Digital banking: accounts, transfers, cards, and savings built around how people actually manage money.",
    icon: Banknote,
    category: "Fintech",
  },
  {
    slug: "valmont-agent",
    name: "Valmont Agent",
    shortLabel: "Agent",
    tagline: "A private agent you stay in control of.",
    description:
      "A private, approval-first AI coding agent for your GitHub repositories — it proposes, you approve every meaningful step.",
    icon: Bot,
    category: "AI / Developer",
    href: "/agent",
    live: true,
  },
  {
    slug: "valmont-ads",
    name: "Valmont Ads",
    shortLabel: "Ads",
    tagline: "Ads that find their audience.",
    description:
      "Digital advertising and campaign management — targeted reach, clear reporting, and measurable return on spend.",
    icon: Megaphone,
    category: "Marketing",
  },
];

const pillars = [
  {
    icon: LockKeyhole,
    title: "Private by default",
    copy: "This workspace is not a public site. Access to Valmont Agent requires a GitHub sign-in. There is no public inbox.",
  },
  {
    icon: ShieldCheck,
    title: "You approve every step",
    copy: "Valmont Agent never merges, never deploys, and never writes a pull request until you say so.",
  },
  {
    icon: Sparkles,
    title: "One Valmont family",
    copy: "Every product below is a Valmont product — named in full, connected by the same identity and infrastructure.",
  },
];

function VentureCard({ venture }: { venture: Venture }) {
  const Icon = venture.icon;
  const isLink = Boolean(venture.href);
  const Wrapper: React.ElementType = isLink ? Link : "div";
  const linkProps = venture.href ? { href: venture.href } : {};

  return (
    <Wrapper
      {...linkProps}
      className={`card card-hover group relative flex h-full flex-col p-6 ${
        isLink ? "cursor-pointer" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl bg-brandblue-50 text-brandblue ring-1 ring-inset ring-brandblue-100 transition-colors group-hover:bg-copper-50 group-hover:text-copper-700 group-hover:ring-copper-300">
          <Icon className="size-5" strokeWidth={1.9} aria-hidden="true" />
        </span>
        <span className="rounded-full bg-ivory-100 px-2.5 py-1 text-[10px] font-bold tracking-wide text-slate uppercase ring-1 ring-inset ring-line">
          {venture.category}
        </span>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <h3 className="text-[17px] font-bold tracking-[-0.015em] text-navy">
          {venture.name}
        </h3>
        {venture.live && (
          <span className="inline-flex items-center gap-1 rounded-full bg-pass-soft px-2 py-0.5 text-[9px] font-bold text-pass-strong">
            <span
              className="size-1.5 rounded-full bg-pass"
              aria-hidden="true"
            />
            PRIVATE
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] font-semibold text-copper-700">
        {venture.tagline}
      </p>
      <p className="mt-3 flex-1 text-[13.5px] leading-6 text-slate">
        {venture.description}
      </p>

      {isLink && (
        <span className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-bold text-brandblue transition-colors group-hover:text-copper-700">
          Open Valmont Agent
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </span>
      )}
    </Wrapper>
  );
}

export default function PortfolioPage() {
  const liveCount = ventures.filter((v) => v.live).length;

  return (
    <main className="min-h-screen overflow-hidden bg-ivory-50">
      <div className="border-b border-line bg-navy text-ivory">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-5 py-2 text-[11px] sm:px-8">
          <span className="flex items-center gap-2 font-semibold text-ivory/80">
            <LockKeyhole className="size-3.5 text-copper" aria-hidden="true" />
            Private Valmont workspace — Valmont Agent requires GitHub sign-in.
          </span>
          <Link
            href="/agent"
            className="hidden items-center gap-1 font-bold text-copper-300 hover:text-copper sm:inline-flex"
          >
            Sign in <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <nav className="sticky top-0 z-30 border-b border-line/70 bg-ivory-50/85 backdrop-blur-md">
        <div className="mx-auto flex h-[72px] max-w-[1180px] items-center justify-between px-5 sm:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2.5"
            aria-label="Valmont home"
          >
            <LogoMark />
            <span className="leading-none">
              <span className="block text-[17px] font-bold tracking-[-0.01em] text-navy">
                Valmont
              </span>
              <span className="mt-0.5 block text-[9px] font-semibold tracking-[0.16em] text-slate uppercase">
                Private portfolio
              </span>
            </span>
          </Link>
          <div className="hidden items-center gap-1 md:flex">
            <a href="#ventures" className="btn-quiet text-[13px]">
              Products
            </a>
            <a href="#about" className="btn-quiet text-[13px]">
              About
            </a>
          </div>
          <Link href="/agent" className="btn-primary min-h-10 px-4 text-[13px]">
            <Bot className="size-4" aria-hidden="true" />
            Open Valmont Agent
          </Link>
        </div>
      </nav>

      <section className="relative mx-auto max-w-[1180px] px-5 pt-16 pb-10 sm:px-8 sm:pt-24 sm:pb-16">
        <div
          className="pointer-events-none absolute -top-24 right-[-10%] -z-0 h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle,#f3b77c_0%,transparent_66%)] opacity-50"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute top-40 left-[-12%] -z-0 h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,#bcd2e3_0%,transparent_68%)] opacity-40"
          aria-hidden="true"
        />

        <div className="relative z-10 grid items-center gap-14 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[11px] font-bold text-brandblue shadow-sm">
              <Sparkles className="size-3.5 text-copper" aria-hidden="true" />
              {ventures.length} Valmont products · {liveCount} private and live
            </span>
            <h1 className="text-balance mt-6 max-w-[720px] text-[44px] leading-[1.04] font-[760] tracking-[-0.045em] text-navy sm:text-[64px]">
              The private
              <br />
              <span className="text-copper">Valmont</span> portfolio.
            </h1>
            <p className="mt-6 max-w-[580px] text-[17px] leading-7 text-slate sm:text-lg">
              An internal map of every Valmont product — Valmont Pay, Valmont
              Bank, Valmont Data, Valmont Web, Valmont Agent, and the rest —
              built to stay inside this workspace. There is no public contact
              form and no open inbox.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a
                href="#ventures"
                className="btn-primary min-h-12 px-5 text-[15px]"
              >
                Browse Valmont products
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <Link
                href="/agent"
                className="btn-secondary min-h-12 px-5 text-[15px]"
              >
                <LockKeyhole className="size-[18px]" aria-hidden="true" />
                Sign in to Valmont Agent
              </Link>
            </div>

            <div className="mt-10 flex flex-wrap gap-x-7 gap-y-2.5">
              {["Private access", "GitHub sign-in", "Approval-first"].map(
                (tag) => (
                  <span
                    key={tag}
                    className="flex items-center gap-2 text-[12.5px] font-semibold text-slate"
                  >
                    <span
                      className="size-1.5 rounded-full bg-copper"
                      aria-hidden="true"
                    />
                    {tag}
                  </span>
                ),
              )}
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[560px] lg:mx-0">
            <div className="panel-navy overflow-hidden p-6 shadow-[0_30px_80px_rgba(10,31,68,0.28)] sm:p-8">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold tracking-[0.16em] text-copper-300 uppercase">
                    Valmont ecosystem
                  </p>
                  <h2 className="mt-1.5 text-[22px] font-bold tracking-[-0.02em] text-ivory">
                    Connected, and private
                  </h2>
                </div>
                <span className="flex size-12 items-center justify-center rounded-2xl bg-ivory/10 ring-1 ring-inset ring-ivory/20">
                  <Layers className="size-6 text-copper" aria-hidden="true" />
                </span>
              </div>

              <div className="mt-7 grid grid-cols-3 gap-2.5">
                {ventures.map((v) => {
                  const VIcon = v.icon;
                  return (
                    <div
                      key={v.slug}
                      className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-center transition-colors ${
                        v.live
                          ? "border-copper/40 bg-copper/10 hover:bg-copper/15"
                          : "border-ivory/10 bg-ivory/5 hover:bg-ivory/10"
                      }`}
                    >
                      <VIcon
                        className={`size-5 ${v.live ? "text-copper" : "text-ivory/80"}`}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      <span className="text-[10px] leading-tight font-bold text-ivory/90">
                        {v.shortLabel}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 rounded-xl border border-ivory/10 bg-navy-900/60 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-copper text-navy">
                    <Wrench className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-[12px] font-bold text-ivory">
                      Shared Valmont infrastructure
                    </p>
                    <p className="mt-0.5 text-[11px] leading-4 text-ivory/60">
                      Identity, payments, and data stay inside the workspace.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="absolute -right-4 -bottom-6 hidden items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-xl sm:flex">
              <span className="flex size-9 items-center justify-center rounded-full bg-pass-soft text-pass-strong">
                <LockKeyhole className="size-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[11px] font-bold text-navy">Members only</p>
                <p className="mt-0.5 text-[10px] text-slate">
                  no public contact
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-white">
        <div className="mx-auto grid max-w-[1180px] gap-8 px-5 py-14 sm:grid-cols-3 sm:px-8">
          {pillars.map((p) => {
            const PIcon = p.icon;
            return (
              <div key={p.title} className="flex gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-copper-50 text-copper-700 ring-1 ring-inset ring-copper-300">
                  <PIcon
                    className="size-5"
                    strokeWidth={1.9}
                    aria-hidden="true"
                  />
                </span>
                <div>
                  <h3 className="text-[15px] font-bold text-navy">{p.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-6 text-slate">
                    {p.copy}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section
        id="ventures"
        className="mx-auto max-w-[1180px] scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-copper-700 uppercase">
              Valmont products
            </p>
            <h2 className="text-balance mt-3 max-w-[640px] text-[34px] leading-[1.08] font-[750] tracking-[-0.03em] text-navy sm:text-[44px]">
              Nine Valmont products. One private family.
            </h2>
          </div>
          <p className="max-w-[360px] text-[14px] leading-6 text-slate">
            Each name is written in full. Only Valmont Agent is live in this
            workspace; the others are listed so the portfolio stays complete.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {ventures.map((venture) => (
            <VentureCard key={venture.slug} venture={venture} />
          ))}
        </div>
      </section>

      <section className="relative overflow-hidden bg-navy text-ivory">
        <div
          className="pointer-events-none absolute -top-32 -right-24 h-[460px] w-[460px] rounded-full bg-[radial-gradient(circle,rgba(232,130,43,0.35)_0%,transparent_66%)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto grid max-w-[1180px] items-center gap-12 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-copper/40 bg-copper/10 px-3 py-1.5 text-[11px] font-bold text-copper-300">
              <LockKeyhole className="size-3.5" aria-hidden="true" />
              PRIVATE · LIVE
            </span>
            <h2 className="text-balance mt-6 text-[36px] leading-[1.08] font-[750] tracking-[-0.035em] text-ivory sm:text-[48px]">
              <span className="text-copper">Valmont Agent</span> — a private
              coding partner you stay in control of.
            </h2>
            <p className="mt-6 max-w-[520px] text-[16px] leading-7 text-ivory/70">
              Valmont Agent inspects your repository, proposes a plan, and
              waits. You approve every meaningful boundary — from implementation
              to pull request. It never merges, never deploys, and keeps keys
              server-side. Sign in with GitHub to open it.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/agent"
                className="btn-primary min-h-12 px-5 text-[15px]"
              >
                Sign in to Valmont Agent
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                href="/docs/security"
                className="btn-inverse min-h-12 px-5 text-[15px]"
              >
                <ShieldCheck className="size-[18px]" aria-hidden="true" />
                Security model
              </Link>
            </div>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-2xl border border-ivory/10 bg-navy-900/70 shadow-[0_30px_80px_rgba(0,0,0,0.4)]">
              <div className="flex h-11 items-center gap-2 border-b border-ivory/10 px-4">
                <span className="size-2.5 rounded-full bg-copper" />
                <span className="size-2.5 rounded-full bg-brandblue-600" />
                <span className="size-2.5 rounded-full bg-ivory/30" />
                <span className="ml-3 text-[10px] font-semibold text-ivory/50">
                  valmont / agent
                </span>
              </div>
              <div className="space-y-3 p-6">
                <div className="rounded-xl border border-ivory/10 bg-ivory/5 p-4">
                  <p className="text-[10px] font-bold tracking-[0.1em] text-copper-300 uppercase">
                    Proposed plan
                  </p>
                  <p className="mt-2 text-[14px] font-bold text-ivory">
                    Add empty state to project dashboard
                  </p>
                </div>
                {[
                  "Add an accessible empty project state",
                  "Preserve loading and populated paths",
                  "Add focused regression coverage",
                ].map((step, i) => (
                  <div
                    key={step}
                    className="flex items-center gap-3 rounded-xl border border-ivory/10 bg-ivory/5 p-3.5"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brandblue-600/30 text-[11px] font-bold text-ivory">
                      {i + 1}
                    </span>
                    <span className="text-[13px] font-semibold text-ivory/90">
                      {step}
                    </span>
                  </div>
                ))}
                <div className="flex justify-end gap-2 pt-1">
                  <span className="btn-inverse pointer-events-none min-h-9 text-xs">
                    Reject
                  </span>
                  <span className="btn-primary pointer-events-none min-h-9 text-xs">
                    Approve & execute
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        id="about"
        className="mx-auto max-w-[1180px] scroll-mt-24 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-copper-700 uppercase">
              About this workspace
            </p>
            <h2 className="text-balance mt-3 text-[34px] leading-[1.1] font-[750] tracking-[-0.03em] text-navy sm:text-[42px]">
              A private map of every Valmont product.
            </h2>
          </div>
          <div className="space-y-5 text-[15.5px] leading-7 text-slate">
            <p>
              This page is not a public brochure. It is the internal Valmont
              portfolio: Valmont Pay, Valmont Data, Valmont Electrical, Valmont
              Gadgets, Valmont Web, Valmont Ecosystem, Valmont Bank, Valmont
              Agent, and Valmont Ads.
            </p>
            <p>
              Only Valmont Agent is connected here. Opening it requires a GitHub
              account. There is no public email, no partnership form, and no
              “get in touch” path — on purpose.
            </p>
            <div className="grid grid-cols-3 gap-4 pt-4">
              {[
                [String(ventures.length), "Valmont products"],
                [String(liveCount), "Private & live"],
                ["GitHub", "Sign-in only"],
              ].map(([stat, label]) => (
                <div key={label} className="card p-4 text-center">
                  <p className="text-[28px] font-[760] tracking-[-0.03em] text-copper">
                    {stat}
                  </p>
                  <p className="mt-1 text-[11px] font-bold tracking-wide text-slate uppercase">
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1180px] px-5 pb-20 sm:px-8 sm:pb-24">
        <div className="panel-navy relative overflow-hidden p-8 sm:p-12">
          <div
            className="pointer-events-none absolute -right-20 -bottom-20 h-[320px] w-[320px] rounded-full bg-[radial-gradient(circle,rgba(232,130,43,0.4)_0%,transparent_68%)]"
            aria-hidden="true"
          />
          <div className="relative z-10 flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
            <div>
              <p className="text-[11px] font-bold tracking-[0.16em] text-copper-300 uppercase">
                Members only
              </p>
              <h2 className="text-balance mt-3 max-w-[560px] text-[30px] leading-[1.12] font-[750] tracking-[-0.03em] text-ivory sm:text-[38px]">
                Open Valmont Agent with your GitHub account.
              </h2>
              <p className="mt-4 max-w-[520px] text-[15px] leading-7 text-ivory/70">
                No public inbox. No sales form. Sign in, pick a repository, and
                stay in control of every plan and pull request.
              </p>
            </div>
            <Link
              href="/agent"
              className="btn-primary min-h-12 px-6 text-[15px]"
            >
              <Bot className="size-[18px]" aria-hidden="true" />
              Sign in to Valmont Agent
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line bg-white">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-3">
            <Logo href="/" />
            <span className="text-[12px] text-slate">
              © {new Date().getFullYear()} Valmont. Private workspace.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12.5px] font-semibold text-slate">
            <a href="#ventures" className="hover:text-copper-700">
              Products
            </a>
            <a href="#about" className="hover:text-copper-700">
              About
            </a>
            <Link href="/agent" className="hover:text-copper-700">
              Valmont Agent
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
