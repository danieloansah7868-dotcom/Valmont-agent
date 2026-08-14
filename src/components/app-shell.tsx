import Link from "next/link";
import { Bell, ChevronDown, CircleHelp } from "lucide-react";
import { AppNav } from "@/components/app-nav";
import { DemoBadge } from "@/components/demo-badge";
import { Logo } from "@/components/logo";
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
    <div className="min-h-screen bg-[#f5f7f5] pb-16 md:pb-0">
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center border-b border-[#dbe3de] bg-white/95 px-4 backdrop-blur md:left-[228px] md:px-7">
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
            href="/settings"
            className="btn-quiet size-9 min-h-9 px-0"
            aria-label="Help and setup"
          >
            <CircleHelp className="size-[17px]" />
          </Link>
          <button
            className="btn-quiet relative size-9 min-h-9 px-0"
            aria-label="Notifications"
          >
            <Bell className="size-[17px]" />
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[#c46a2c]" />
          </button>
          <div className="mx-1 h-6 w-px bg-[#e1e7e3]" />
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-[#f1f4f2]"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-[#dbeae2] text-[10px] font-bold text-[#225c46]">
              {initials || "VA"}
            </span>
            <span className="hidden text-left lg:block">
              <span className="block max-w-32 truncate text-[11px] font-bold text-[#26362f]">
                {user.name}
              </span>
              <span className="block text-[10px] text-[#7b8781]">
                {user.demo ? "Demo workspace" : `@${user.login}`}
              </span>
            </span>
            <ChevronDown className="hidden size-3.5 text-[#849089] lg:block" />
          </Link>
        </div>
      </header>
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-[228px] flex-col border-r border-[#dbe3de] bg-[#f9faf9] md:flex">
        <div className="flex h-16 items-center border-b border-[#dbe3de] px-5">
          <Logo />
        </div>
        <AppNav />
        <div className="m-3 rounded-xl border border-[#dae3dd] bg-white p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#33433c]">
              Safety boundaries
            </span>
            <span className="size-2 rounded-full bg-[#3d9a70]" />
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-[#76827c]">
            PR creation always requires final approval. Merge and deploy are
            disabled.
          </p>
        </div>
      </aside>
      <main className="min-h-screen pt-16 md:ml-[228px]">{children}</main>
    </div>
  );
}
