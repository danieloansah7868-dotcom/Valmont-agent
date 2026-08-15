"use client";
import Link from "next/link";
import { ChangeEvent, useState } from "react";
import { Archive, Pencil, Trash2 } from "lucide-react";
import { apiDelete, apiPatch } from "@/lib/client-api";
import type { ChatMemory } from "@/lib/chat-store";
import type { ChatSession } from "@/lib/types";
export function MemoryControls({
  initialMemories,
  initialEnabled,
  sessions,
}: {
  initialMemories: ChatMemory[];
  initialEnabled: boolean;
  sessions: ChatSession[];
}) {
  const [memories, setMemories] = useState(initialMemories);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [conversations, setConversations] = useState(sessions);
  const [error, setError] = useState("");
  async function toggle() {
    const next = !enabled;
    try {
      await apiPatch("/api/memories", { enabled: next });
      setEnabled(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update memory");
    }
  }
  async function forget(id: string) {
    if (!confirm("Forget this saved memory? This cannot be undone.")) return;
    try {
      await apiDelete(`/api/memories/${id}`);
      setMemories((current) => current.filter((m) => m.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not forget memory");
    }
  }
  async function edit(memory: ChatMemory) {
    const content = prompt("Edit memory", memory.content);
    if (!content?.trim()) return;
    try {
      await apiPatch(`/api/memories/${memory.id}`, { content });
      setMemories((current) =>
        current.map((item) =>
          item.id === memory.id ? { ...item, content } : item,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not edit memory");
    }
  }
  async function archive(id: string) {
    try {
      await apiPatch(`/api/chats/${id}`, { action: "archive" });
      setConversations((current) => current.filter((c) => c.id !== id));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not archive conversation",
      );
    }
  }
  async function remove(id: string) {
    if (
      !confirm(
        "Permanently delete this conversation, its messages, search entries, and memories derived only from it? This cannot be undone.",
      )
    )
      return;
    try {
      await apiDelete(`/api/chats/${id}`);
      setConversations((current) => current.filter((c) => c.id !== id));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not delete conversation",
      );
    }
  }
  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(
      "Import is intentionally disabled until a backup can be verified and merged without overwriting local history.",
    );
    event.target.value = "";
  }
  return (
    <>
      <section className="card mt-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-navy">Cross-chat memory</h2>
            <p className="mt-1 text-[11px] text-slate">
              {enabled
                ? "Enabled. Only redacted user statements that match stable preference, fact, decision, or project patterns are saved."
                : "Disabled. Existing memories stay private and are not used for new replies."}
            </p>
          </div>
          <button
            onClick={() => void toggle()}
            className="btn-secondary min-h-8 text-[11px]"
          >
            Turn {enabled ? "off" : "on"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            className="btn-secondary min-h-8 text-[11px]"
            href="/api/memories/export"
          >
            Export backup
          </Link>
          <label className="btn-secondary min-h-8 cursor-pointer text-[11px]">
            Import backup
            <input
              className="sr-only"
              type="file"
              accept="application/json"
              onChange={importBackup}
            />
          </label>
        </div>
      </section>
      {error ? (
        <p className="mt-3 text-[11px] text-fail" role="alert">
          {error}
        </p>
      ) : null}
      <section className="card mt-6 overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-bold text-navy">Saved memories</h2>
        </div>
        {memories.length ? (
          <ul className="divide-y divide-line">
            {memories.map((memory) => (
              <li
                key={memory.id}
                className="flex items-start justify-between gap-3 px-5 py-4"
              >
                <div>
                  <span className="rounded-full bg-brandblue-50 px-2 py-0.5 text-[9px] font-bold text-brandblue">
                    {memory.scope} · {memory.category}
                  </span>
                  <p className="mt-2 text-[12px] text-navy">{memory.content}</p>
                </div>
                <div className="flex gap-1">
                  <button
                    className="btn-quiet size-8 min-h-8 px-0"
                    onClick={() => void edit(memory)}
                    aria-label="Edit memory"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    className="btn-quiet size-8 min-h-8 px-0 text-fail"
                    onClick={() => void forget(memory.id)}
                    aria-label="Forget memory"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-[12px] text-slate">
            No memories saved yet.
          </p>
        )}
      </section>
      <section className="card mt-6 overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-bold text-navy">Conversations</h2>
          <p className="mt-1 text-[11px] text-slate">
            Archive hides a conversation but preserves it. Permanent deletion
            removes its transcript, search records, and memories derived only
            from it.
          </p>
        </div>
        <ul className="divide-y divide-line">
          {conversations.map((chat) => (
            <li
              key={chat.id}
              className="flex items-center justify-between gap-3 px-5 py-3"
            >
              <span className="truncate text-[12px] font-bold text-navy">
                {chat.title}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => void archive(chat.id)}
                  className="btn-quiet size-8 min-h-8 px-0"
                  aria-label="Archive conversation"
                >
                  <Archive className="size-3.5" />
                </button>
                <button
                  onClick={() => void remove(chat.id)}
                  className="btn-quiet size-8 min-h-8 px-0 text-fail"
                  aria-label="Permanently delete conversation"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
