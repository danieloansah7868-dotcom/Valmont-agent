"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  GitBranch,
  MessageSquareText,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { apiDelete, apiMutation } from "@/lib/client-api";
import type { ChatSession, RepositorySummary } from "@/lib/types";

interface ChatWorkspaceProps {
  activeSession?: ChatSession;
  repositories: RepositorySummary[];
  repositoryLoadError?: string;
  sessions: ChatSession[];
}

interface BranchResponse {
  branches: string[];
  defaultBranch: string;
}

interface MessageResponse {
  session: ChatSession;
}

export function ChatWorkspace({
  activeSession,
  repositories,
  repositoryLoadError,
  sessions,
}: ChatWorkspaceProps) {
  const router = useRouter();
  const [sessionList, setSessionList] = useState(sessions);
  const [session, setSession] = useState(activeSession);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length, sending]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = content.trim();
    if (!session || !value || sending) return;
    setSending(true);
    setError("");
    try {
      const response = await apiMutation<MessageResponse>(
        `/api/chats/${session.id}/messages`,
        { content: value },
      );
      setSession(response.session);
      setSessionList((current) => [
        response.session,
        ...current.filter((item) => item.id !== response.session.id),
      ]);
      setContent("");
      router.refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Valmont could not send the message.",
      );
    } finally {
      setSending(false);
    }
  }

  async function deleteSession() {
    if (!session || deleting) return;
    if (
      !window.confirm(
        "Delete this chat and its messages? This cannot be undone.",
      )
    ) {
      return;
    }
    setDeleting(true);
    setError("");
    try {
      await apiDelete(`/api/chats/${session.id}`);
      router.push("/chat");
      router.refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The chat could not be deleted.",
      );
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-[1440px] lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-white lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-4">
          <div>
            <p className="text-[10px] font-bold tracking-[0.16em] text-copper uppercase">
              Conversations
            </p>
            <h1 className="mt-0.5 text-base font-bold tracking-tight text-navy">
              Chat with Valmont
            </h1>
          </div>
          <Link
            href="/chat"
            className="btn-secondary size-9 min-h-9 px-0"
            aria-label="Start a new chat"
            title="New chat"
          >
            <Plus className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <nav
          className="flex gap-2 overflow-x-auto p-3 lg:block lg:max-h-[calc(100vh-8.5rem)] lg:space-y-1 lg:overflow-y-auto"
          aria-label="Chat sessions"
        >
          {sessionList.length === 0 ? (
            <div className="min-w-56 rounded-xl border border-dashed border-line px-4 py-5 text-center lg:min-w-0">
              <MessageSquareText
                className="mx-auto size-5 text-slate-300"
                aria-hidden="true"
              />
              <p className="mt-2 text-[11px] leading-4 text-slate">
                Your reopenable chats will appear here.
              </p>
            </div>
          ) : (
            sessionList.map((item) => {
              const active = item.id === session?.id;
              return (
                <Link
                  key={item.id}
                  href={`/chat/${item.id}`}
                  className={`block min-w-56 rounded-xl border px-3 py-3 transition-colors lg:min-w-0 ${
                    active
                      ? "border-brandblue-200 bg-brandblue-50"
                      : "border-transparent hover:border-line hover:bg-ivory-50"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="block truncate text-[12px] font-bold text-navy">
                    {item.title}
                  </span>
                  <span className="mt-1 flex items-center gap-1 truncate text-[10px] text-slate">
                    {item.repository ? (
                      <>
                        <GitBranch
                          className="size-3 shrink-0"
                          aria-hidden="true"
                        />
                        {item.repository.fullName}
                      </>
                    ) : (
                      <>
                        <Sparkles
                          className="size-3 shrink-0"
                          aria-hidden="true"
                        />
                        General chat
                      </>
                    )}
                  </span>
                </Link>
              );
            })
          )}
        </nav>
      </aside>

      {session ? (
        <section className="flex min-h-[620px] min-w-0 flex-col bg-ivory-50 lg:h-[calc(100vh-4rem)]">
          <header className="border-b border-line bg-white px-4 py-3.5 sm:px-6">
            <div className="mx-auto flex max-w-4xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-bold text-navy">
                  {session.title}
                </h2>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] text-slate">
                  {session.repository ? (
                    <>
                      <GitBranch className="size-3" aria-hidden="true" />
                      {session.repository.fullName} ·{" "}
                      {session.repository.baseBranch}
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-3" aria-hidden="true" />
                      General conversation
                    </>
                  )}
                </p>
              </div>
              {session.messages.length > 0 ? (
                <Link
                  href={`/tasks/new?chat=${session.id}`}
                  className="btn-primary min-h-9 px-3 text-[11px]"
                >
                  Create coding task
                </Link>
              ) : null}
              <button
                type="button"
                onClick={deleteSession}
                disabled={deleting}
                className="btn-quiet size-9 min-h-9 px-0 text-slate hover:text-danger disabled:opacity-50"
                aria-label="Delete chat"
                title="Delete chat"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            <div className="mx-auto max-w-4xl space-y-5">
              {session.messages.length === 0 ? (
                <ChatWelcome session={session} />
              ) : (
                session.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {message.role === "assistant" ? (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-navy text-ivory">
                        <Bot className="size-4" aria-hidden="true" />
                      </span>
                    ) : null}
                    <div
                      className={`max-w-[min(90%,46rem)] rounded-2xl px-4 py-3 text-[13px] leading-6 shadow-sm ${
                        message.role === "user"
                          ? "rounded-br-md bg-brandblue text-white"
                          : "rounded-bl-md border border-line bg-white text-navy"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {message.content}
                      </p>
                      <time
                        className={`mt-2 block text-[9px] ${
                          message.role === "user"
                            ? "text-white/60"
                            : "text-slate-400"
                        }`}
                        dateTime={message.createdAt}
                        suppressHydrationWarning
                      >
                        {formatMessageTime(message.createdAt)}
                      </time>
                    </div>
                  </article>
                ))
              )}
              {sending ? (
                <div className="flex gap-3" role="status">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-navy text-ivory">
                    <Bot className="size-4" aria-hidden="true" />
                  </span>
                  <div className="rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3 text-[12px] text-slate shadow-sm">
                    Valmont is thinking<span className="animate-pulse">…</span>
                  </div>
                </div>
              ) : null}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-line bg-white px-4 py-4 sm:px-6">
            <form onSubmit={sendMessage} className="mx-auto max-w-4xl">
              {error ? (
                <p
                  className="mb-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] text-danger"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <div className="relative rounded-2xl border border-line bg-white shadow-sm transition focus-within:border-brandblue-200 focus-within:ring-2 focus-within:ring-brandblue-100">
                <label htmlFor="chat-message" className="sr-only">
                  Message Valmont
                </label>
                <textarea
                  id="chat-message"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={8_000}
                  rows={2}
                  disabled={sending}
                  autoFocus
                  className="block min-h-20 w-full resize-none bg-transparent px-4 pt-3 pr-14 pb-7 text-[13px] leading-5 text-navy outline-none placeholder:text-slate-400 disabled:opacity-60"
                  placeholder="Message Valmont…"
                />
                <button
                  type="submit"
                  disabled={sending || !content.trim()}
                  className="absolute right-3 bottom-3 flex size-8 items-center justify-center rounded-lg bg-copper-600 text-white transition hover:bg-copper-700 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Send message"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </button>
                <span className="absolute bottom-2.5 left-4 text-[9px] text-slate-400">
                  Enter to send · Shift+Enter for a new line
                </span>
              </div>
              <p className="mt-2 flex items-center justify-center gap-1 text-center text-[9px] text-slate-400">
                <ShieldCheck className="size-3" aria-hidden="true" />
                Chat is read-only. Repository changes require a separate coding
                task and approval.
              </p>
            </form>
          </div>
        </section>
      ) : (
        <NewChatPanel
          repositories={repositories}
          repositoryLoadError={repositoryLoadError}
        />
      )}
    </div>
  );
}

function ChatWelcome({ session }: { session: ChatSession }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-navy text-ivory shadow-sm">
        <Bot className="size-6" aria-hidden="true" />
      </span>
      <h2 className="mt-5 text-xl font-bold tracking-tight text-navy">
        What would you like to explore?
      </h2>
      <p className="mt-2 text-[12px] leading-5 text-slate">
        {session.repository
          ? `I can discuss ${session.repository.fullName} using read-only context from ${session.repository.baseBranch}.`
          : "Ask about code, architecture, debugging, product ideas, or anything else. This conversation is not attached to a repository."}
      </p>
      <div className="mt-5 rounded-xl border border-line bg-white px-4 py-3 text-left text-[10px] leading-4 text-slate">
        <strong className="text-navy">Safe by design:</strong> chatting never
        changes files. When you are ready, use Create coding task to review the
        handoff before Valmont starts an approval-gated workflow.
      </div>
    </div>
  );
}

function NewChatPanel({
  repositories,
  repositoryLoadError,
}: {
  repositories: RepositorySummary[];
  repositoryLoadError?: string;
}) {
  const router = useRouter();
  const requestSequence = useRef(0);
  const [title, setTitle] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function selectRepository(nextRepositoryId: string) {
    setRepositoryId(nextRepositoryId);
    setBaseBranch("");
    setBranches([]);
    setError("");
    const sequence = ++requestSequence.current;
    if (!nextRepositoryId) {
      setLoadingBranches(false);
      return;
    }

    setLoadingBranches(true);
    try {
      const response = await fetch(
        `/api/repositories/${encodeURIComponent(nextRepositoryId)}/branches`,
      );
      const data = (await response.json()) as BranchResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || "Branches could not be loaded");
      if (sequence !== requestSequence.current) return;
      setBranches(data.branches);
      setBaseBranch(data.defaultBranch);
    } catch (requestError) {
      if (sequence !== requestSequence.current) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Branches could not be loaded.",
      );
    } finally {
      if (sequence === requestSequence.current) setLoadingBranches(false);
    }
  }

  async function createChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || (repositoryId && !baseBranch)) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await apiMutation<{ session: ChatSession }>(
        "/api/chats",
        {
          title: title.trim() || undefined,
          repositoryId: repositoryId || undefined,
          baseBranch: repositoryId ? baseBranch : undefined,
        },
      );
      router.push(`/chat/${response.session.id}`);
      router.refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The chat could not be created.",
      );
      setSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-[620px] items-center justify-center bg-ivory-50 px-4 py-10 sm:px-7">
      <div className="w-full max-w-xl">
        <div className="text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-navy text-ivory shadow-sm">
            <MessageSquareText className="size-6" aria-hidden="true" />
          </span>
          <p className="mt-5 text-[10px] font-bold tracking-[0.16em] text-copper uppercase">
            New conversation
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-navy">
            Chat with Valmont
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[12px] leading-5 text-slate">
            Start a general conversation, or attach one authorized repository
            and branch for read-only context.
          </p>
        </div>

        <form onSubmit={createChat} className="card mt-7 space-y-5 p-5 sm:p-6">
          <label className="block">
            <span className="label">Conversation title</span>
            <input
              className="input mt-1.5"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              placeholder="Optional — Valmont can name it from your first message"
              autoFocus
            />
          </label>

          {repositoryLoadError ? (
            <p
              className="rounded-lg border border-copper-100 bg-copper-50 px-3 py-2 text-[10px] leading-4 text-copper-700"
              role="status"
            >
              GitHub repositories are temporarily unavailable. You can still
              start a general chat. {repositoryLoadError}
            </p>
          ) : null}

          <label className="block">
            <span className="label">Repository context</span>
            <select
              className="select mt-1.5"
              value={repositoryId}
              onChange={(event) => void selectRepository(event.target.value)}
            >
              <option value="">General chat — no repository</option>
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.fullName}
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-[10px] leading-4 text-slate">
              This association applies only to this session and cannot modify
              files.
            </span>
          </label>

          {repositoryId ? (
            <label className="block">
              <span className="label">Read-only branch</span>
              <select
                className="select mt-1.5"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                disabled={loadingBranches}
                required
              >
                <option value="">
                  {loadingBranches ? "Loading branches…" : "Select a branch"}
                </option>
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {error ? (
            <p
              className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={
              submitting ||
              loadingBranches ||
              Boolean(repositoryId && !baseBranch)
            }
          >
            <Sparkles className="size-4" aria-hidden="true" />
            {submitting ? "Starting chat…" : "Start conversation"}
          </button>
        </form>
      </div>
    </section>
  );
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
