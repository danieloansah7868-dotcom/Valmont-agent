"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  FileSearch,
  FolderGit2,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
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
}: {
  repositories: RepositorySummary[];
  initialRepositoryId?: string;
}) {
  const router = useRouter();
  const initial =
    repositories.find((repo) => repo.id === initialRepositoryId) ??
    repositories[0];
  const [repositoryId, setRepositoryId] = useState(initial?.id ?? "");
  const [baseBranch, setBaseBranch] = useState(
    initial?.defaultBranch ?? "main",
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const repository = repositories.find((repo) => repo.id === repositoryId);

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
                setRepositoryId(id);
                setBaseBranch(
                  repositories.find((item) => item.id === id)?.defaultBranch ??
                    "main",
                );
              }}
              required
            >
              {repositories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.fullName}
                  {item.demo ? " (demo)" : ""}
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
              required
            >
              <option value={repository?.defaultBranch ?? "main"}>
                {repository?.defaultBranch ?? "main"}
              </option>
              {repository?.demo && repository.defaultBranch !== "develop" && (
                <option value="develop">develop</option>
              )}
            </select>
          </label>
        </div>

        {repository?.demo && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DemoBadge />
            <span className="text-[10px] text-copper-700">
              No GitHub request will be made for this repository.
            </span>
          </div>
        )}

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
            disabled={submitting || !repositoryId}
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
