"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderGit2,
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

export function AppNav() {
  const pathname = usePathname();
  const isActive = useIsActive(pathname);
  return (
    <>
      {/* Desktop sidebar: navy surface, copper primary action, blue active state. */}
      <nav
        className="hidden flex-1 flex-col gap-1 px-3 pt-5 md:flex"
        aria-label="Main navigation"
      >
        <Link href="/tasks/new" className="btn-primary mb-4 w-full">
          <Plus className="size-4" aria-hidden="true" /> New coding task
        </Link>
        {links.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-semibold transition-colors ${
                active
                  ? "bg-brandblue text-ivory"
                  : "text-ivory/65 hover:bg-ivory/10 hover:text-ivory"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon
                className="size-[17px]"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Mobile tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center justify-around border-t border-navy-700 bg-navy px-2 md:hidden"
        aria-label="Mobile navigation"
      >
        {mobileLinks.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex min-w-16 flex-col items-center gap-1 rounded-md py-1 text-[10px] font-semibold transition-colors ${
                active ? "text-copper-300" : "text-ivory/60"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="size-5" aria-hidden="true" />
              {href === "/chat" ? "Chat" : label}
            </Link>
          );
        })}
        <Link
          href="/tasks/new"
          className="flex min-w-16 flex-col items-center gap-1 rounded-md py-1 text-[10px] font-semibold text-ivory"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-copper-600 text-white">
            <Plus className="size-4" aria-hidden="true" />
          </span>
          New task
        </Link>
      </nav>
    </>
  );
}
