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
import type { ChatMessage, ChatSession, RepositorySummary } from "@/lib/types";

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

const GENERAL_HEADLINES = [
  "What's on your mind?",
  "Where should we start?",
  "Good to see you. What are we into today?",
  "I'm all ears.",
];

const GENERAL_STARTERS = [
  "Help me think through a decision I'm weighing",
  "Explain a concept to me in plain language",
  "Brainstorm ideas with me for a project",
  "Poke holes in a rough plan I have",
];

const REPOSITORY_STARTERS = [
  "Give me a quick tour of how this repository is organized",
  "Where would I start to understand the main flow?",
  "What parts of this codebase look the most complex?",
  "Walk me through the tests and how they are organized",
];

function stablePick<T>(items: T[], seed: string): T {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return items[Math.abs(hash) % items.length] as T;
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
  const [pendingMessage, setPendingMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length, pendingMessage, sending]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
  }, [content]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = content.trim();
    if (!session || !value || sending) return;
    setSending(true);
    setError("");
    setPendingMessage(value);
    setContent("");
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
      router.refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Valmont could not send the message.",
      );
      setContent(value);
    } finally {
      setPendingMessage("");
      setSending(false);
    }
  }

  function useStarter(prompt: string) {
    setContent(prompt);
    textareaRef.current?.focus();
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
    <div className="mx-auto flex h-[calc(100dvh-8rem)] max-w-[1440px] flex-col overflow-hidden md:h-[calc(100dvh-4rem)] lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line bg-white lg:h-full lg:w-[280px] lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 lg:py-4">
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
          className="flex min-h-0 gap-2 overflow-x-auto p-2.5 lg:block lg:flex-1 lg:space-y-1 lg:overflow-x-hidden lg:overflow-y-auto lg:p-3"
          aria-label="Chat sessions"
        >
          {sessionList.length === 0 ? (
            <div className="min-w-56 rounded-xl border border-dashed border-line px-4 py-4 text-center lg:min-w-0">
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
                  className={`block min-w-56 rounded-xl border px-3 py-2.5 transition-colors lg:min-w-0 ${
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
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ivory-50">
          <header className="shrink-0 border-b border-line bg-white px-4 py-3 sm:px-6">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
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
                className="btn-quiet size-9 min-h-9 px-0 text-slate hover:text-fail disabled:opacity-50"
                aria-label="Delete chat"
                title="Delete chat"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <div className="mx-auto max-w-3xl">
              {session.messages.length === 0 && !pendingMessage && !sending ? (
                <ChatWelcome session={session} onStarter={useStarter} />
              ) : (
                <MessageList
                  messages={session.messages}
                  pendingMessage={pendingMessage}
                  sending={sending}
                />
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="shrink-0 border-t border-line bg-white px-4 pt-3 pb-3 sm:px-6">
            <form onSubmit={sendMessage} className="mx-auto max-w-3xl">
              {error ? (
                <p
                  className="mb-2 rounded-lg border border-fail/25 bg-fail-soft px-3 py-2 text-[11px] text-fail-strong"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <div className="flex items-end gap-2 rounded-2xl border border-line bg-white p-2 shadow-sm transition focus-within:border-brandblue-200 focus-within:ring-2 focus-within:ring-brandblue-100">
                <label htmlFor="chat-message" className="sr-only">
                  Message Valmont
                </label>
                <textarea
                  id="chat-message"
                  ref={textareaRef}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={8_000}
                  rows={1}
                  disabled={sending}
                  autoFocus
                  aria-describedby="chat-composer-hint"
                  className="block max-h-44 min-h-10 w-full flex-1 resize-none self-center bg-transparent px-2 py-2.5 text-[13px] leading-5 text-navy outline-none placeholder:text-slate-400 disabled:opacity-60"
                  placeholder="Message Valmont…"
                />
                <button
                  type="submit"
                  disabled={sending || !content.trim()}
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-copper-600 text-white transition hover:bg-copper-700 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Send message"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </button>
              </div>
              <p
                id="chat-composer-hint"
                className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-[9px] text-slate-400"
              >
                <span>Enter to send · Shift+Enter for a new line</span>
                <span
                  className="hidden size-0.5 rounded-full bg-slate-300 sm:inline-block"
                  aria-hidden="true"
                />
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="size-3" aria-hidden="true" />
                  Chat is read-only. Repository changes require a separate
                  coding task and approval.
                </span>
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

function MessageList({
  messages,
  pendingMessage,
  sending,
}: {
  messages: ChatMessage[];
  pendingMessage: string;
  sending: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const firstOfGroup = !previous || previous.role !== message.role;
        const next = messages[index + 1];
        const lastOfGroup = !next || next.role !== message.role;
        return (
          <MessageBubble
            key={message.id}
            content={message.content}
            createdAt={message.createdAt}
            firstOfGroup={firstOfGroup}
            lastOfGroup={lastOfGroup}
            role={message.role}
          />
        );
      })}
      {pendingMessage ? (
        <MessageBubble
          content={pendingMessage}
          firstOfGroup
          lastOfGroup
          role="user"
        />
      ) : null}
      {sending ? <TypingIndicator /> : null}
    </div>
  );
}

function MessageBubble({
  content,
  createdAt,
  firstOfGroup,
  lastOfGroup,
  role,
}: {
  content: string;
  createdAt?: string;
  firstOfGroup: boolean;
  lastOfGroup: boolean;
  role: "user" | "assistant";
}) {
  const isUser = role === "user";
  return (
    <article
      className={`flex gap-2.5 ${isUser ? "justify-end" : "justify-start"} ${
        firstOfGroup ? "pt-3 first:pt-0" : ""
      }`}
    >
      {!isUser ? (
        firstOfGroup ? (
          <span className="flex size-7 shrink-0 items-center justify-center self-start rounded-full bg-navy text-ivory">
            <Bot className="size-3.5" aria-hidden="true" />
          </span>
        ) : (
          <span className="size-7 shrink-0" aria-hidden="true" />
        )
      ) : null}
      <div
        className={`max-w-[min(88%,42rem)] rounded-2xl px-3.5 py-2.5 text-[13px] leading-6 shadow-sm ${
          isUser
            ? `bg-brandblue text-white ${lastOfGroup ? "rounded-br-md" : ""}`
            : `border border-line bg-white text-navy ${lastOfGroup ? "rounded-bl-md" : ""}`
        }`}
      >
        <p className="break-words whitespace-pre-wrap">{content}</p>
        {lastOfGroup && createdAt ? (
          <time
            className={`mt-1 block text-[9px] ${
              isUser ? "text-white/60" : "text-slate-400"
            }`}
            dateTime={createdAt}
            suppressHydrationWarning
          >
            {formatMessageTime(createdAt)}
          </time>
        ) : null}
      </div>
    </article>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 pt-3" role="status" aria-live="polite">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-navy text-ivory">
        <Bot className="size-3.5" aria-hidden="true" />
      </span>
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-line bg-white px-3.5 py-3 shadow-sm">
        <span className="sr-only">Valmont is typing</span>
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 animate-bounce rounded-full bg-slate-400"
            style={{ animationDelay: `${dot * 150}ms` }}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

function ChatWelcome({
  onStarter,
  session,
}: {
  onStarter: (prompt: string) => void;
  session: ChatSession;
}) {
  const headline = session.repository
    ? `Let's talk about ${session.repository.name}.`
    : stablePick(GENERAL_HEADLINES, session.id);
  const starters = session.repository ? REPOSITORY_STARTERS : GENERAL_STARTERS;

  return (
    <div className="mx-auto max-w-xl px-2 py-6 sm:py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-navy text-ivory shadow-sm">
          <Bot className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-navy">
            {headline}
          </h2>
          <p className="mt-0.5 text-[12px] leading-5 text-slate">
            {session.repository
              ? `Read-only context from ${session.repository.fullName} on ${session.repository.baseBranch}. Ask away.`
              : "Anything goes — ideas, plans, tricky decisions, or code when you want it."}
          </p>
        </div>
      </div>
      <ul className="mt-5 grid gap-2 sm:grid-cols-2" aria-label="Suggestions">
        {starters.map((starter) => (
          <li key={starter}>
            <button
              type="button"
              onClick={() => onStarter(starter)}
              className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-left text-[12px] leading-5 text-navy shadow-sm transition hover:border-copper-300 hover:bg-copper-50"
            >
              {starter}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex items-start gap-1.5 text-[10px] leading-4 text-slate">
        <ShieldCheck
          className="mt-0.5 size-3 shrink-0 text-slate-400"
          aria-hidden="true"
        />
        Chatting never changes files. When you want something built, Create
        coding task hands this conversation to an approval-gated workflow.
      </p>
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
    <section className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto bg-ivory-50 px-4 py-8 sm:items-center sm:px-7">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-navy text-ivory shadow-sm">
            <MessageSquareText className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold tracking-[0.16em] text-copper uppercase">
              New conversation
            </p>
            <h2 className="mt-0.5 text-xl font-bold tracking-tight text-navy">
              Chat with Valmont
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-slate">
              Talk about anything, or attach a repository and branch for
              read-only context.
            </p>
          </div>
        </div>

        <form onSubmit={createChat} className="card mt-5 space-y-5 p-5 sm:p-6">
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
              className="rounded-lg border border-fail/25 bg-fail-soft px-3 py-2 text-[11px] text-fail-strong"
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
