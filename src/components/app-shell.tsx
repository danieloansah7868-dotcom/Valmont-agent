"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleHelp, Menu, ShieldCheck, X } from "lucide-react";
import { AppNav } from "@/components/app-nav";
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
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

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
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-lg focus:bg-navy focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-ivory"
      >
        Skip to content
      </a>

      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-navy/55 backdrop-blur-[2px]"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <header className="fixed inset-x-0 top-0 z-50 flex h-16 items-center border-b border-line bg-ivory-50/95 px-4 backdrop-blur sm:px-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="btn-header"
            aria-label="Open navigation menu"
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
          >
            <Menu className="size-5" aria-hidden="true" />
            <span className="hidden sm:inline">Menu</span>
          </button>
          <div className="pl-1">
            <Logo />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Link href="/" className="btn-header hidden sm:inline-flex">
            <span className="text-copper" aria-hidden="true">
              ◆
            </span>
            Portfolio
          </Link>
          <Link
            href="/docs/security"
            className="btn-header"
            aria-label="Security model and setup help"
            title="Help"
          >
            <CircleHelp className="size-[18px]" aria-hidden="true" />
            <span className="hidden sm:inline">Help</span>
          </Link>
          <div className="mx-1 h-6 w-px bg-line-strong" aria-hidden="true" />
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-lg border border-line-strong bg-white px-2 py-1 transition-colors hover:border-copper hover:bg-copper-50"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-brandblue text-[10px] font-bold text-ivory">
              {initials || "VA"}
            </span>
            <span className="hidden text-left lg:block">
              <span className="block max-w-32 truncate text-[11px] font-bold text-navy">
                {user.name}
              </span>
              <span className="block text-[10px] text-slate">
                @{user.login}
              </span>
            </span>
          </Link>
          <SignOutButton />
        </div>
      </header>

      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[86vw] flex-col border-r border-navy-700 bg-navy shadow-2xl transition-transform duration-300 ease-in-out ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Main navigation"
        aria-hidden={!navOpen}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-navy-700 px-4">
          <Logo
            inverse
            href="/dashboard"
            onClick={() => setNavOpen(false)}
          />
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            className="btn-inverse size-9 min-h-9 px-0"
            aria-label="Close navigation menu"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <AppNav onNavigate={() => setNavOpen(false)} />
        <div className="m-3 shrink-0 rounded-xl border border-ivory/15 bg-ivory/5 p-3.5">
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

      <main id="main-content" className="min-h-dvh pt-16">
        {children}
      </main>
    </div>
  );
}
