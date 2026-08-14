import Link from "next/link";
import { CircleHelp, ShieldCheck } from "lucide-react";
import { AppNav } from "@/components/app-nav";
import { DemoBadge } from "@/components/demo-badge";
import { Logo } from "@/components/logo";
import { SignOutButton } from "@/components/sign-out-button";
import type { SessionUser } from "@/lib/auth";

export function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: SessionUser;
}) {
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="min-h-screen bg-ivory-50 pb-16 md:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-60 focus:rounded-lg focus:bg-navy focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-ivory"
      >
        Skip to content
      </a>
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center border-b border-line bg-ivory-50/95 px-4 backdrop-blur md:left-[228px] md:px-7">
        <div className="md:hidden">
          <Logo />
        </div>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {user.demo && (
            <div className="mr-1 hidden sm:block">
              <DemoBadge />
            </div>
          )}
          <Link
            href="/docs/security"
            className="btn-quiet size-9 min-h-9 px-0"
            aria-label="Security model and setup help"
          >
            <CircleHelp className="size-[17px]" aria-hidden="true" />
          </Link>
          <div className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-lg p-1.5 transition-colors hover:bg-ivory-100"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-brandblue text-[10px] font-bold text-ivory">
              {initials || "VA"}
            </span>
            <span className="hidden text-left lg:block">
              <span className="block max-w-32 truncate text-[11px] font-bold text-navy">
                {user.name}
              </span>
              <span className="block text-[10px] text-slate">
                {user.demo ? "Demo workspace" : `@${user.login}`}
              </span>
            </span>
          </Link>
          {!user.demo && <SignOutButton />}
        </div>
      </header>

      <aside className="fixed inset-y-0 left-0 z-50 hidden w-[228px] flex-col border-r border-navy-700 bg-navy md:flex">
        <div className="flex h-16 items-center border-b border-navy-700 px-5">
          <Logo inverse />
        </div>
        <AppNav />
        <div className="m-3 rounded-xl border border-ivory/15 bg-ivory/5 p-3.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-ivory">
              <ShieldCheck
                className="size-3.5 text-copper"
                aria-hidden="true"
              />
              Safety boundaries
            </span>
            <span
              className="size-2 rounded-full bg-pass"
              aria-hidden="true"
              title="Active"
            />
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-ivory/60">
            PR creation always requires final approval. Merge and deploy are
            disabled.
          </p>
        </div>
      </aside>

      <main id="main-content" className="min-h-screen pt-16 md:ml-[228px]">
        {children}
      </main>
    </div>
  );
}
