"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { LinkProps } from "next/link";
import {
  CircleHelp,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  X,
} from "lucide-react";
import { AppNav } from "@/components/app-nav";
import { Logo } from "@/components/logo";
import { SignOutButton } from "@/components/sign-out-button";
import type { SessionUser } from "@/lib/auth";

const SIDEBAR_WIDTH = 248;
const COLLAPSED_WIDTH = 72;
const COLLAPSE_STORAGE_KEY = "valmont:sidebar-collapsed";

/**
 * A Link that also closes the mobile drawer when clicked. Keeps the
 * "close on navigation" behavior out of a pathname effect, which would
 * otherwise trigger the react-hooks/set-state-in-effect lint rule.
 */
function CloseOnNavLink({
  onNavigate,
  ...props
}: LinkProps & {
  children: React.ReactNode;
  className?: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) onNavigate();
      }}
    />
  );
}

export function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: SessionUser;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Start expanded so the first client render matches the server-rendered
  // HTML; the saved preference is restored after mount (see the rAF effect).
  const [collapsed, setCollapsed] = useState(false);
  // Blocks the persistence effect from writing the mount-time default before
  // the saved preference has been restored.
  const restoredRef = useRef(false);

  // Persist the user's collapse preference.
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // Ignore storage failures (private mode, quota, etc.).
    }
  }, [collapsed]);

  // Animating on the very first client paint can cause a visible width
  // transition from the SSR width. We restore the saved collapse preference
  // in a rAF (which runs asynchronously and keeps effects clean), then gate
  // the transition class until the *next* frame so the restored width snaps
  // into place without a visible animation.
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    let animateFrame: number | undefined;
    const restoreFrame = requestAnimationFrame(() => {
      try {
        setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1");
      } catch {
        // Ignore storage failures (private mode, quota, etc.).
      }
      restoredRef.current = true;
      animateFrame = requestAnimationFrame(() => setAnimate(true));
    });
    return () => {
      cancelAnimationFrame(restoreFrame);
      if (animateFrame !== undefined) cancelAnimationFrame(animateFrame);
    };
  }, []);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const desktopWidth = collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH;
  const transitionClass = animate
    ? "transition-[left,padding,width] duration-300 ease-in-out"
    : "";

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-ivory-50 pb-16 md:pb-0">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-lg focus:bg-navy focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-ivory"
      >
        Skip to content
      </a>

      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-navy/55 backdrop-blur-[2px] md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <header
        className={`fixed inset-x-0 top-0 z-50 flex h-20 items-center border-b border-line bg-ivory-50/95 px-4 backdrop-blur md:px-7 ${transitionClass}`}
        style={{ left: desktopWidth }}
      >
        <div className="flex items-center gap-2">
          {/* Hamburger: opens the mobile slide-over drawer. */}
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="btn-quiet size-10 min-h-10 px-0 md:hidden"
            aria-label="Open navigation menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-sidebar"
          >
            <Menu className="size-6" aria-hidden="true" />
          </button>
          {/* Collapse toggle: desktop only. */}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="btn-quiet hidden size-10 min-h-10 px-0 md:inline-flex"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-6" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-6" aria-hidden="true" />
            )}
          </button>
          <div className="md:hidden">
            <Logo />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <Link
            href="/"
            className="btn-quiet hidden items-center gap-1.5 px-3.5 text-[15px] font-bold sm:inline-flex"
          >
            <span className="text-copper">◆</span> Portfolio
          </Link>
          <Link
            href="/docs/security"
            className="btn-quiet size-10 min-h-10 px-0"
            aria-label="Security model and setup help"
          >
            <CircleHelp className="size-5" aria-hidden="true" />
          </Link>
          <div className="mx-1 h-7 w-px bg-line" aria-hidden="true" />
          <Link
            href="/settings"
            className="flex items-center gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-ivory-100"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-brandblue text-xs font-bold text-ivory">
              {initials || "VA"}
            </span>
            <span className="hidden text-left lg:block">
              <span className="block max-w-40 truncate text-[14px] font-bold text-navy">
                {user.name}
              </span>
              <span className="block text-[12px] font-medium text-slate">
                @{user.login}
              </span>
            </span>
          </Link>
          <SignOutButton />
        </div>
      </header>

      {/* Desktop sidebar (collapsible) */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col overflow-hidden border-r border-navy-700 bg-navy md:flex ${transitionClass}`}
        style={{ width: desktopWidth }}
        aria-label="Main navigation"
      >
        <div className="flex h-20 shrink-0 items-center border-b border-navy-700">
          <CloseOnNavLink
            href="/dashboard"
            onNavigate={() => setMobileOpen(false)}
            className="flex items-center gap-2.5 pl-4"
            aria-label="Valmont Agent dashboard"
          >
            <LogoMarkOnly />
            {!collapsed && (
              <span className="leading-none">
                <span className="block text-[15px] font-bold tracking-[-0.01em] text-ivory">
                  Valmont
                  <span className="text-copper"> Agent</span>
                </span>
                <span className="mt-1 block text-[9px] font-semibold tracking-[0.14em] text-ivory/60 uppercase">
                  Approval-first
                </span>
              </span>
            )}
          </CloseOnNavLink>
        </div>
        <AppNav collapsed={collapsed} onNavigate={() => setMobileOpen(false)} />
        {!collapsed && (
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
        )}
      </aside>

      {/* Mobile slide-over drawer */}
      <aside
        id="mobile-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[82vw] flex-col border-r border-navy-700 bg-navy shadow-2xl transition-transform duration-300 ease-in-out md:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Mobile navigation"
        aria-hidden={!mobileOpen}
      >
        <div className="flex h-20 shrink-0 items-center justify-between border-b border-navy-700 px-4">
          <Logo inverse />
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="btn-inverse size-9 min-h-9 px-0"
            aria-label="Close navigation menu"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <AppNav onNavigate={() => setMobileOpen(false)} />
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

      <main
        id="main-content"
        className={`min-h-[calc(100dvh-5rem)] pt-20 md:min-h-dvh ${transitionClass}`}
        style={{ paddingLeft: desktopWidth }}
      >
        {children}
      </main>
    </div>
  );
}

// Lightweight logo mark used in the collapsed sidebar so we don't depend on
// the full Logo component's label layout.
function LogoMarkOnly() {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-ivory"
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" className="size-[62%]" focusable="false">
        <path
          d="M14 15h10.5l7.5 26.5L39.5 15H50L37 49H27L14 15Z"
          fill="#0A1F44"
        />
        <path d="M24.5 41.5h15L37 49H27l-2.5-7.5Z" fill="#E8822B" />
      </svg>
    </span>
  );
}
