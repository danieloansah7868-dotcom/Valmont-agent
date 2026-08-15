"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  FileSearch,
  FolderGit2,
  LockKeyhole,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import { EmptyState, InlineError } from "@/components/states";
import { apiMutation } from "@/lib/client-api";
import type { CodingTask, RepositorySummary } from "@/lib/types";

const QUICK_STARTS = [
  {
    label: "Business website",
    title: "Build a production-ready business website",
    description:
      "Create a polished, accessible, mobile-first business website with a strong hero, service sections, trust signals, contact and quotation calls to action, SEO metadata, responsive navigation, helpful empty/error states, and focused tests. Reuse the repository's existing stack and design conventions.",
  },
  {
    label: "Online store",
    title: "Build a responsive online storefront",
    description:
      "Create a mobile-first storefront with product browsing, clear pricing, cart and checkout entry points, trustworthy payment messaging, accessible interaction states, SEO metadata, and focused tests. Preserve existing payment and backend boundaries; do not deploy or add credentials.",
  },
  {
    label: "Dashboard / portal",
    title: "Build the approved dashboard experience",
    description:
      "Implement a clear responsive dashboard using the repository's existing data layer and components. Include loading, error and empty states, accessible navigation, useful summary cards, and focused tests without changing deployment or database settings.",
  },
] as const;

export function NewTaskForm({
  repositories,
  initialRepositoryId,
  initialBaseBranch,
  initialTitle = "",
  initialDescription = "",
  sourceChatTitle,
}: {
  repositories: RepositorySummary[];
  initialRepositoryId?: string;
  initialBaseBranch?: string;
  initialTitle?: string;
  initialDescription?: string;
  sourceChatTitle?: string;
}) {
  const router = useRouter();
  const initial =
    repositories.find((repo) => repo.id === initialRepositoryId) ??
    repositories[0];
  const [repositoryId, setRepositoryId] = useState(initial?.id ?? "");
  const preferredInitialBranch =
    initial?.id === initialRepositoryId ? initialBaseBranch : undefined;
  const [baseBranch, setBaseBranch] = useState(
    preferredInitialBranch ?? initial?.defaultBranch ?? "main",
  );
  const [branches, setBranches] = useState<string[]>(
    initial ? [preferredInitialBranch ?? initial.defaultBranch] : [],
  );
  const [branchesLoading, setBranchesLoading] = useState(Boolean(initial));
  const [branchError, setBranchError] = useState("");
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const selected = repositories.find((item) => item.id === repositoryId);
    if (!selected) return;

    const controller = new AbortController();
    void fetch(
      `/api/repositories/${encodeURIComponent(selected.id)}/branches`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          branches?: unknown;
          defaultBranch?: unknown;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(data.error ?? "Branches could not be loaded");
        }
        if (
          !Array.isArray(data.branches) ||
          !data.branches.every((branch) => typeof branch === "string") ||
          typeof data.defaultBranch !== "string"
        ) {
          throw new Error("GitHub returned an invalid branch list");
        }
        return {
          branches: data.branches,
          defaultBranch: data.defaultBranch,
        };
      })
      .then((data) => {
        const ordered = [
          data.defaultBranch,
          ...data.branches.filter((branch) => branch !== data.defaultBranch),
        ];
        setBranches([...new Set(ordered)]);
        const preferred =
          selected.id === initialRepositoryId &&
          initialBaseBranch &&
          data.branches.includes(initialBaseBranch)
            ? initialBaseBranch
            : data.defaultBranch;
        setBaseBranch(preferred);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        setBranchError(
          caught instanceof Error
            ? caught.message
            : "Branches could not be loaded",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBranchesLoading(false);
      });

    return () => controller.abort();
  }, [initialBaseBranch, initialRepositoryId, repositories, repositoryId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await apiMutation<{ task: CodingTask }>("/api/tasks", {
        title,
        description,
        repositoryId,
        baseBranch,
      });
      router.push(`/tasks/${result.task.id}`);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create task",
      );
      setSubmitting(false);
    }
  }

  if (repositories.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={FolderGit2}
          title="No authorized repositories"
          description="Valmont needs at least one repository authorized through GitHub before a task can be created."
          action={
            <a href="/api/auth/github" className="btn-primary text-xs">
              Refresh GitHub authorization
            </a>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_315px]">
      <form onSubmit={submit} className="card p-5 sm:p-7">
        {sourceChatTitle ? (
          <div className="mb-5 flex gap-3 rounded-xl border border-brandblue-200 bg-brandblue-50 p-4">
            <MessageSquareText
              className="mt-0.5 size-4 shrink-0 text-brandblue"
              aria-hidden="true"
            />
            <div>
              <p className="text-[11px] font-bold text-navy">
                Conversation copied for review
              </p>
              <p className="mt-1 text-[10px] leading-4 text-slate">
                “{sourceChatTitle}” supplied this editable draft. The original
                chat remains separate, and creating this task does not authorize
                code changes.
              </p>
            </div>
          </div>
        ) : null}
        <div className="border-b border-line pb-5">
          <h2 className="text-sm font-bold text-navy">Task details</h2>
          <p className="mt-1 text-[12px] text-slate">
            Describe the outcome, not the implementation. Valmont will inspect
            the repository first.
          </p>
        </div>

        {error && (
          <div className="mt-5">
            <InlineError message={error} />
          </div>
        )}

        <div className="mt-5">
          <span className="label">Quick start</span>
          <div className="flex flex-wrap gap-2">
            {QUICK_STARTS.map((template) => (
              <button
                key={template.label}
                type="button"
                className="rounded-full border border-line bg-ivory-50 px-3 py-1.5 text-[10px] font-bold text-slate-700 transition-colors hover:border-copper hover:bg-copper-50 hover:text-copper-700"
                onClick={() => {
                  setTitle(template.title);
                  setDescription(template.description);
                }}
              >
                {template.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <label>
            <span className="label">Repository</span>
            <select
              className="select"
              value={repositoryId}
              onChange={(event) => {
                const id = event.target.value;
                const nextRepository = repositories.find(
                  (item) => item.id === id,
                );
                const nextDefault = nextRepository?.defaultBranch ?? "main";
                setRepositoryId(id);
                setBaseBranch(nextDefault);
                setBranches([nextDefault]);
                setBranchesLoading(true);
                setBranchError("");
              }}
              required
            >
              {repositories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.fullName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Base branch</span>
            <select
              className="select"
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
              aria-describedby="base-branch-status"
              disabled={branchesLoading}
              required
            >
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
            <span
              id="base-branch-status"
              className={`mt-1.5 block text-[10px] ${branchError ? "text-fail" : "text-slate"}`}
              role={branchError ? "alert" : undefined}
            >
              {branchesLoading
                ? "Loading authorized GitHub branches…"
                : branchError ||
                  `${branches.length} authorized branch${branches.length === 1 ? "" : "es"} available`}
            </span>
          </label>
        </div>

        <label className="mt-6 block">
          <span className="label">Task title</span>
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            minLength={5}
            maxLength={160}
            required
            placeholder="e.g. Add an empty state to the projects dashboard"
          />
          <span className="mt-1.5 block text-right text-[10px] text-slate-400">
            {title.length} / 160
          </span>
        </label>

        <label className="mt-4 block">
          <span className="label">What should change?</span>
          <textarea
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            minLength={20}
            maxLength={8000}
            required
            placeholder="Explain the desired behavior, acceptance criteria, and any constraints. Do not include credentials, customer data, or secrets."
          />
          <span className="mt-1.5 block text-[10px] leading-4 text-slate">
            Be specific about expected behavior and tests. Valmont excludes
            sensitive paths and redacts secret patterns.
          </span>
        </label>

        <div className="mt-6 flex flex-col-reverse items-stretch gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-[10px] text-slate">
            <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />{" "}
            Creating a task does not authorize code changes.
          </p>
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting || branchesLoading || !repositoryId}
          >
            {submitting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Inspecting
                repository…
              </>
            ) : (
              <>
                Create task &amp; plan{" "}
                <ArrowRight className="size-4" aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </form>

      <aside className="space-y-4">
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-copper" aria-hidden="true" />
            <h2 className="text-[13px] font-bold text-navy">
              What happens next
            </h2>
          </div>
          <ol className="mt-5 space-y-5">
            {[
              [
                "1",
                "Inspect",
                "Filtered repository files and docs are retrieved.",
              ],
              ["2", "Plan", "A structured implementation plan is prepared."],
              ["3", "Wait", "Nothing changes until you approve the plan."],
            ].map(([number, label, detail], index) => (
              <li key={label} className="relative flex gap-3">
                {index < 2 && (
                  <span
                    className="absolute top-7 bottom-[-20px] left-[13px] w-px bg-line"
                    aria-hidden="true"
                  />
                )}
                <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-brandblue-50 text-[10px] font-bold text-brandblue">
                  {number}
                </span>
                <div>
                  <p className="text-[11px] font-bold text-navy">{label}</p>
                  <p className="mt-1 text-[10px] leading-4 text-slate">
                    {detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-xl border border-line bg-ivory-100 p-4">
          <div className="flex gap-3">
            <FileSearch
              className="mt-0.5 size-4 shrink-0 text-copper"
              aria-hidden="true"
            />
            <div>
              <p className="text-[11px] font-bold text-navy">
                Retrieval safeguards
              </p>
              <ul className="mt-2 space-y-1.5 text-[10px] text-slate">
                {[
                  "No .env, tokens, or private keys",
                  "No binaries, dependencies, or build output",
                  "Only task-relevant context is selected",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-1.5">
                    <Check
                      className="size-3 shrink-0 text-copper"
                      aria-hidden="true"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
