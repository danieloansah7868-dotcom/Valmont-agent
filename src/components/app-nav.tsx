"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Plus,
  Settings,
} from "lucide-react";

const links = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/repositories", label: "Repositories", icon: FolderGit2 },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <>
      <nav
        className="hidden flex-1 flex-col gap-1 px-3 pt-5 md:flex"
        aria-label="Main navigation"
      >
        <Link href="/tasks/new" className="btn-primary mb-4 w-full">
          <Plus className="size-4" /> New coding task
        </Link>
        {links.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            (href !== "/dashboard" && pathname.startsWith(`${href}/`));
          return (
            <Link
              key={href}
              href={href}
              className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-semibold transition-colors ${active ? "bg-[#e8f1eb] text-[#205e47]" : "text-[#65726c] hover:bg-[#eef2ef] hover:text-[#24332d]"}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="size-[17px]" strokeWidth={1.8} />
              {label}
            </Link>
          );
        })}
      </nav>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center justify-around border-t border-[#dbe3de] bg-white/95 px-2 backdrop-blur md:hidden"
        aria-label="Mobile navigation"
      >
        {links.slice(0, 3).map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            (href !== "/dashboard" && pathname.startsWith(`${href}/`));
          return (
            <Link
              key={href}
              href={href}
              className={`flex min-w-16 flex-col items-center gap-1 text-[10px] font-semibold ${active ? "text-[#1f6b4f]" : "text-[#738079]"}`}
            >
              <Icon className="size-5" />
              {label}
            </Link>
          );
        })}
        <Link
          href="/tasks/new"
          className="flex min-w-16 flex-col items-center gap-1 text-[10px] font-semibold text-[#1f6b4f]"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-[#1f6b4f] text-white">
            <Plus className="size-4" />
          </span>
          New task
        </Link>
      </nav>
    </>
  );
}
