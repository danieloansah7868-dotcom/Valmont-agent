import Link from "next/link";
import { Brain, ShieldCheck } from "lucide-react";
import { MemoryControls } from "@/components/memory-controls";
import { requireSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
export const dynamic = "force-dynamic";
export default async function MemorySettingsPage() {
  const user = await requireSessionUser();
  const store = getChatStore();
  const [memories, enabled, sessions] = await Promise.all([
    store.memories(user.id),
    store.memoryEnabled(user.id),
    store.list(user.id),
  ]);
  return (
    <div className="mx-auto max-w-[940px] px-4 py-7 sm:px-7 sm:py-9">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold tracking-[0.16em] text-copper uppercase">
            Chat privacy
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-navy">
            Long-term memory
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate">
            Saved memories are local to this Valmont installation and scoped to
            your account. Repository memories never cross into general chats or
            another repository.
          </p>
        </div>
        <Brain className="size-8 text-copper" aria-hidden="true" />
      </div>
      <MemoryControls
        initialMemories={memories}
        initialEnabled={enabled}
        sessions={sessions}
      />
      <div className="mt-6 flex items-start gap-2 rounded-xl border border-line bg-ivory-50 p-4 text-[11px] leading-5 text-slate">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-copper" />
        <span>
          Memory never grants repository access or write capabilities. Chat
          remains read-only and implementation still requires the approval-gated
          task handoff.{" "}
          <Link href="/settings" className="link-brand">
            Back to settings
          </Link>
        </span>
      </div>
    </div>
  );
}
