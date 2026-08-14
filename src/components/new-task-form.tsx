"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Check,
  FileSearch,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
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

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_315px]">
      <form onSubmit={submit} className="card p-5 sm:p-7">
        <div className="border-b border-[#e3e8e5] pb-5">
          <h2 className="text-sm font-bold">Task details</h2>
          <p className="mt-1 text-[12px] text-[#79867f]">
            Describe the outcome, not the implementation. Valmont will inspect
            the repository first.
          </p>
        </div>
        {error && (
          <div
            role="alert"
            className="mt-5 flex gap-2.5 rounded-lg border border-[#efc6c2] bg-[#fff4f3] p-3 text-[12px] text-[#9a3734]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        )}
        <div className="mt-5">
          <span className="label">Quick start</span>
          <div className="flex flex-wrap gap-2">
            {QUICK_STARTS.map((template) => (
              <button
                key={template.label}
                type="button"
                className="rounded-full border border-[#d6e0da] bg-[#f8faf8] px-3 py-1.5 text-[10px] font-bold text-[#4c6258] transition-colors hover:border-[#9fb9aa] hover:bg-[#edf5f0] hover:text-[#215e46]"
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
          <div className="mt-3">
            <DemoBadge />
            <span className="ml-2 text-[10px] text-[#8a765a]">
              No GitHub request will be made.
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
          <span className="mt-1.5 block text-right text-[10px] text-[#939d98]">
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
          <span className="mt-1.5 block text-[10px] leading-4 text-[#87928d]">
            Be specific about expected behavior and tests. Valmont excludes
            sensitive paths and redacts secret patterns.
          </span>
        </label>
        <div className="mt-6 flex flex-col-reverse items-stretch gap-3 border-t border-[#e3e8e5] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-[10px] text-[#7d8983]">
            <LockKeyhole className="size-3.5" /> Creating a task does not
            authorize code changes.
          </p>
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting || !repositoryId}
          >
            {submitting ? (
              <>
                <span className="size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />{" "}
                Inspecting repository…
              </>
            ) : (
              <>
                Create task & plan <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </div>
      </form>
      <aside className="space-y-4">
        <div className="card p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-[#2e7357]" />
            <h2 className="text-[13px] font-bold">What happens next</h2>
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
                  <span className="absolute top-7 bottom-[-20px] left-[13px] w-px bg-[#dbe4de]" />
                )}
                <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-[#eaf3ed] text-[10px] font-bold text-[#27654d]">
                  {number}
                </span>
                <div>
                  <p className="text-[11px] font-bold">{label}</p>
                  <p className="mt-1 text-[10px] leading-4 text-[#7b8781]">
                    {detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-xl border border-[#dce5df] bg-[#f0f6f2] p-4">
          <div className="flex gap-3">
            <FileSearch className="mt-0.5 size-4 shrink-0 text-[#3f715d]" />
            <div>
              <p className="text-[11px] font-bold text-[#325847]">
                Retrieval safeguards
              </p>
              <ul className="mt-2 space-y-1.5 text-[10px] text-[#687a71]">
                {[
                  "No .env, tokens, or private keys",
                  "No binaries, dependencies, or build output",
                  "Only task-relevant context is selected",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-1.5">
                    <Check className="size-3 text-[#397458]" />
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
