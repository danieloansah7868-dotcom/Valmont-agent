"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LinkProps } from "next/link";
import {
  FolderGit2,
  Home,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Plus,
  Settings,
} from "lucide-react";

const links = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/chat", label: "Chat with Valmont", icon: MessageSquareText },
  { href: "/repositories", label: "Repositories", icon: FolderGit2 },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
];

const mobileLinks = links.filter(({ href }) =>
  ["/dashboard", "/chat", "/tasks"].includes(href),
);

function useIsActive(pathname: string) {
  return (href: string) =>
    pathname === href ||
    (href !== "/dashboard" && pathname.startsWith(`${href}/`));
}

type NavProps = {
  collapsed?: boolean;
  onNavigate?: () => void;
};

/** Link that also fires onNavigate so the mobile drawer can close on tap. */
function NavLink({
  onNavigate,
  ...props
}: LinkProps & {
  children: React.ReactNode;
  className?: string;
  title?: string;
  "aria-current"?: "page" | undefined;
  "aria-label"?: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) onNavigate?.();
      }}
    />
  );
}

export function AppNav({ collapsed = false, onNavigate }: NavProps) {
  const pathname = usePathname();
  const isActive = useIsActive(pathname);

  return (
    <>
      {/* Desktop / drawer nav list */}
      <nav
        className="hidden flex-1 flex-col gap-1 overflow-y-auto px-3 pt-5 md:flex"
        aria-label="Main navigation"
      >
        <NavLink
          href="/tasks/new"
          onNavigate={onNavigate}
          className={`btn-primary mb-4 w-full ${collapsed ? "min-h-10 px-0" : ""}`}
          title={collapsed ? "New coding task" : undefined}
          aria-label={collapsed ? "New coding task" : undefined}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          {!collapsed && "New coding task"}
        </NavLink>
        {links.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <NavLink
              key={href}
              href={href}
              onNavigate={onNavigate}
              className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-semibold transition-colors ${
                collapsed ? "justify-center" : ""
              } ${
                active
                  ? "bg-brandblue text-ivory"
                  : "text-ivory/65 hover:bg-ivory/10 hover:text-ivory"
              }`}
              aria-current={active ? "page" : undefined}
              title={collapsed ? label : undefined}
            >
              <Icon
                className="size-[17px] shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              {!collapsed && <span className="truncate">{label}</span>}
            </NavLink>
          );
        })}

        <div className="my-2 h-px bg-ivory/10" aria-hidden="true" />

        <NavLink
          href="/"
          onNavigate={onNavigate}
          className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-semibold text-copper-300 transition-colors hover:bg-copper/10 hover:text-copper ${
            collapsed ? "justify-center" : ""
          }`}
          title={collapsed ? "Valmont Portfolio" : undefined}
        >
          <Home
            className="size-[17px] shrink-0"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {!collapsed && <span className="truncate">Portfolio home</span>}
        </NavLink>
      </nav>

      {/* Mobile drawer nav (full-width list, only inside the slide-over) */}
      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pt-5 md:hidden"
        aria-label="Mobile navigation"
      >
        <NavLink
          href="/tasks/new"
          onNavigate={onNavigate}
          className="btn-primary mb-4 w-full"
        >
          <Plus className="size-4" aria-hidden="true" /> New coding task
        </NavLink>
        {links.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <NavLink
              key={href}
              href={href}
              onNavigate={onNavigate}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-[14px] font-semibold transition-colors ${
                active
                  ? "bg-brandblue text-ivory"
                  : "text-ivory/80 hover:bg-ivory/10 hover:text-ivory"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon
                className="size-[18px] shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              {label}
            </NavLink>
          );
        })}
        <div className="my-2 h-px bg-ivory/10" aria-hidden="true" />
        <NavLink
          href="/"
          onNavigate={onNavigate}
          className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-[14px] font-semibold text-copper-300 transition-colors hover:bg-copper/10 hover:text-copper"
        >
          <Home className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
          Portfolio home
        </NavLink>
      </nav>

      {/* Mobile bottom tab bar (visible when the drawer is closed) */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center justify-around border-t border-navy-700 bg-navy px-2 md:hidden"
        aria-label="Mobile quick navigation"
      >
        {mobileLinks.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <NavLink
              key={href}
              href={href}
              onNavigate={onNavigate}
              className={`flex min-w-16 flex-col items-center gap-1 rounded-md py-1 text-[10px] font-semibold transition-colors ${
                active ? "text-copper-300" : "text-ivory/60"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="size-5" aria-hidden="true" />
              {href === "/chat" ? "Chat" : label}
            </NavLink>
          );
        })}
        <NavLink
          href="/tasks/new"
          onNavigate={onNavigate}
          className="flex min-w-16 flex-col items-center gap-1 rounded-md py-1 text-[10px] font-semibold text-ivory"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-copper-600 text-white">
            <Plus className="size-4" aria-hidden="true" />
          </span>
          New task
        </NavLink>
      </nav>
    </>
  );
}
