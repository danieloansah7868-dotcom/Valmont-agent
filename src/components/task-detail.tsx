"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Code2,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequest,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { DemoBadge } from "@/components/demo-badge";
import { InlineError } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { apiMutation } from "@/lib/client-api";
import type { CodingTask, TaskEvent, ToolExecution } from "@/lib/types";

export function TaskDetail({ initialTask }: { initialTask: CodingTask }) {
  const [task, setTask] = useState(initialTask);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const router = useRouter();

  async function action(
    value: "approve_plan" | "reject_plan" | "approve_final" | "reject_final",
  ) {
    setPending(value);
    setError("");
    try {
      const result = await apiMutation<{ task: CodingTask }>(
        `/api/tasks/${task.id}/actions`,
        { action: value },
      );
      setTask(result.task);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
    } finally {
      setPending(null);
    }
  }

  const atPlan = task.state === "awaiting_plan_approval";
  const atFinal = task.state === "awaiting_final_approval";

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-7 sm:py-8">
      <Link
        href="/tasks"
        className="mb-5 inline-flex items-center gap-1.5 text-[11px] font-bold text-slate transition-colors hover:text-copper-700"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" /> Back to tasks
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge state={task.state} />
            {task.demo && <DemoBadge compact />}
            <span className="text-[10px] font-medium text-slate-400">
              {task.id.slice(0, 18)}
            </span>
          </div>
          <h1 className="mt-3 text-[25px] leading-8 font-bold tracking-[-0.035em] text-navy sm:text-[29px]">
            {task.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate">
            <span className="flex items-center gap-1.5 font-semibold text-navy">
              <GitBranch className="size-3.5" aria-hidden="true" />
              {task.repositoryName}
            </span>
            <span>Base: {task.baseBranch}</span>
            <span>Created {formatDate(task.createdAt)}</span>
          </div>
        </div>
        {task.pullRequest && (
          <Link
            href={`/tasks/${task.id}/result`}
            className="btn-primary shrink-0"
          >
            <GitPullRequest className="size-4" aria-hidden="true" /> View pull
            request result
          </Link>
        )}
      </div>

      <Progress state={task.state} />

      {error && (
        <div className="mt-5">
          <InlineError message={error} />
        </div>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-5">
          <section className="card p-5 sm:p-6">
            <p className="text-[10px] font-bold tracking-[0.09em] text-copper uppercase">
              Requested outcome
            </p>
            <p className="mt-3 text-[13px] leading-6 text-slate-700">
              {task.description}
            </p>
          </section>

          {task.plan && <PlanPanel task={task} />}

          {atPlan && (
            <ApprovalBoundary
              stage="plan"
              pending={pending}
              onApprove={() => action("approve_plan")}
              onReject={() => action("reject_plan")}
            />
          )}

          {task.validations.length > 0 && <ValidationPanel task={task} />}
          {task.diff && <DiffPanel diff={task.diff} />}

          {atFinal && (
            <ApprovalBoundary
              stage="final"
              pending={pending}
              onApprove={() => action("approve_final")}
              onReject={() => action("reject_final")}
            />
          )}

          {task.state === "cancelled" && (
            <div className="rounded-xl border border-line bg-ivory-100 p-5">
              <div className="flex items-center gap-2 text-slate-700">
                <X className="size-4" aria-hidden="true" />
                <h2 className="text-sm font-bold text-navy">Task cancelled</h2>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate">
                No pull request was created. Start a new task to propose a
                revised approach.
              </p>
              <Link href="/tasks/new" className="btn-secondary mt-4 text-xs">
                <RotateCcw className="size-3.5" aria-hidden="true" /> Start a
                new task
              </Link>
            </div>
          )}

          {task.state === "failed" && (
            <div className="rounded-xl border border-fail/30 bg-fail-soft p-5">
              <div className="flex items-center gap-2 text-fail">
                <AlertCircle className="size-5" aria-hidden="true" />
                <h2 className="text-sm font-bold text-fail-strong">
                  Task stopped safely
                </h2>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-700">
                Review the latest audit event for the failure reason. No pull
                request was merged or deployed.
              </p>
              <Link href="/tasks/new" className="btn-secondary mt-4 text-xs">
                <RotateCcw className="size-3.5" aria-hidden="true" /> Start a
                revised task
              </Link>
            </div>
          )}

          {task.state === "completed" && (
            <div className="rounded-xl border border-pass/30 bg-pass-soft p-5">
              <div className="flex items-center gap-2 text-pass">
                <CheckCircle2 className="size-5" aria-hidden="true" />
                <h2 className="text-sm font-bold text-pass-strong">
                  Pull request created for human review
                </h2>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-700">
                Valmont has finished. It did not merge or deploy the changes.
              </p>
              <Link
                href={`/tasks/${task.id}/result`}
                className="btn-primary mt-4 text-xs"
              >
                View result{" "}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          )}
        </div>

        <aside className="space-y-5 lg:sticky lg:top-22">
          <ActivityTimeline events={task.events} />
          <ToolActions tools={task.toolExecutions} />
        </aside>
      </div>
    </div>
  );
}

function Progress({ state }: { state: CodingTask["state"] }) {
  const steps = ["Plan", "Implement", "Validate", "Approve", "Pull request"];
  const indexes: Record<CodingTask["state"], number> = {
    draft: 0,
    planning: 0,
    awaiting_plan_approval: 0,
    executing: 1,
    testing: 2,
    awaiting_final_approval: 3,
    creating_pull_request: 4,
    completed: 5,
    failed: 0,
    cancelled: 0,
  };
  const current = indexes[state];
  return (
    <div className="card mt-7 overflow-x-auto px-5 py-4">
      <ol className="flex min-w-[590px] items-center">
        {steps.map((step, index) => (
          <li
            key={step}
            className={`flex items-center ${index < steps.length - 1 ? "flex-1" : ""}`}
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                index < current
                  ? "bg-copper-600 text-white"
                  : index === current
                    ? "bg-navy text-ivory ring-4 ring-copper-100"
                    : "bg-ivory-200 text-slate"
              }`}
            >
              {index < current ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={`ml-2 text-[10px] font-bold ${index <= current ? "text-navy" : "text-slate-400"}`}
            >
              {step}
            </span>
            {index < steps.length - 1 && (
              <span
                className={`mx-3 h-px flex-1 ${index < current ? "bg-copper" : "bg-line"}`}
                aria-hidden="true"
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function PlanPanel({ task }: { task: CodingTask }) {
  const plan = task.plan!;
  return (
    <section className="card overflow-hidden">
      <div className="flex items-start justify-between border-b border-line px-5 py-4 sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <FileCode2 className="size-4 text-copper" aria-hidden="true" />
            <h2 className="text-sm font-bold text-navy">Implementation plan</h2>
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-slate">
            {plan.summary}
          </p>
        </div>
        <span
          className={`ml-4 shrink-0 rounded-full px-2 py-1 text-[9px] font-bold uppercase ring-1 ring-inset ${
            plan.risk === "low"
              ? "bg-brandblue-50 text-brandblue ring-brandblue-200"
              : "bg-copper-50 text-copper-700 ring-copper-300"
          }`}
        >
          {plan.risk} risk
        </span>
      </div>
      <ol className="divide-y divide-line">
        {plan.steps.map((step, index) => (
          <li key={step.title} className="flex gap-4 px-5 py-4 sm:px-6">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brandblue-50 text-[10px] font-bold text-brandblue">
              {index + 1}
            </span>
            <div className="min-w-0">
              <h3 className="text-[12px] font-bold text-navy">{step.title}</h3>
              <p className="mt-1.5 text-[11px] leading-5 text-slate">
                {step.description}
              </p>
              {step.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {step.files.map((file) => (
                    <code
                      key={file}
                      className="rounded bg-ivory-100 px-1.5 py-1 text-[9px] text-slate-700"
                    >
                      {file}
                    </code>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="border-t border-line bg-ivory-50 px-5 py-3.5 sm:px-6">
        <span className="text-[10px] font-bold text-navy">
          Approved validation
        </span>
        <div className="mt-2 flex flex-wrap gap-2">
          {plan.validationCommands.map((command) => (
            <code
              key={command}
              className="rounded-md border border-line bg-white px-2 py-1 text-[9px] text-slate-700"
            >
              $ {command}
            </code>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The two human gates. Copper is used deliberately: it means "your decision". */
function ApprovalBoundary({
  stage,
  pending,
  onApprove,
  onReject,
}: {
  stage: "plan" | "final";
  pending: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const final = stage === "final";
  return (
    <section
      aria-labelledby={`approval-${stage}`}
      className="overflow-hidden rounded-xl border-2 border-copper bg-copper-50 shadow-[0_6px_20px_rgba(194,110,46,0.12)]"
    >
      <div className="flex gap-3 p-5 sm:p-6">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-copper-600 text-white">
          <LockKeyhole className="size-[17px]" aria-hidden="true" />
        </span>
        <div>
          <p className="text-[10px] font-bold tracking-[0.09em] text-copper-700 uppercase">
            Explicit approval boundary
          </p>
          <h2
            id={`approval-${stage}`}
            className="mt-1 text-[14px] font-bold text-navy"
          >
            {final
              ? "Review the complete patch before creating a PR"
              : "Review the plan before execution"}
          </h2>
          <p className="mt-2 max-w-2xl text-[11px] leading-5 text-slate-700">
            {final
              ? "Approving will authorize a valmont/* branch, commit, and pull request. Valmont will not merge or deploy it."
              : "Approving allows the agent to modify files and run only the validation commands listed above. It does not authorize a pull request."}
          </p>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-copper-300 bg-white/60 px-5 py-4 sm:flex-row sm:justify-end">
        <button
          className="btn-danger"
          onClick={onReject}
          disabled={pending !== null}
        >
          {pending?.startsWith("reject")
            ? "Rejecting…"
            : final
              ? "Reject changes"
              : "Reject plan"}
        </button>
        <button
          className="btn-primary"
          onClick={onApprove}
          disabled={pending !== null}
        >
          {pending?.startsWith("approve") ? (
            <>
              <span className="spinner" aria-hidden="true" /> Working…
            </>
          ) : (
            <>
              <ShieldCheck className="size-4" aria-hidden="true" />
              {final ? "Approve & create pull request" : "Approve & execute"}
            </>
          )}
        </button>
      </div>
    </section>
  );
}

function ValidationPanel({ task }: { task: CodingTask }) {
  const allPassed = task.validations.every(
    (result) => result.status === "passed",
  );
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-brandblue" aria-hidden="true" />
          <h2 className="text-sm font-bold text-navy">Validation results</h2>
        </div>
        {/* Semantic pass/fail colors are intentionally preserved here. */}
        <span
          className={`flex items-center gap-1 text-[10px] font-bold ${allPassed ? "text-pass" : "text-fail"}`}
        >
          {allPassed ? (
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
          ) : (
            <AlertCircle className="size-3.5" aria-hidden="true" />
          )}
          {allPassed ? "All checks passed" : "Review failed checks"}
        </span>
      </div>
      <div className="divide-y divide-line">
        {task.validations.map((result) => (
          <details key={result.command} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 hover:bg-ivory-50 sm:px-6">
              {result.status === "passed" ? (
                <CheckCircle2
                  className="size-4 shrink-0 text-pass"
                  aria-hidden="true"
                />
              ) : (
                <AlertCircle
                  className="size-4 shrink-0 text-fail"
                  aria-hidden="true"
                />
              )}
              <code className="flex-1 truncate text-[11px] font-bold text-navy">
                {result.command}
              </code>
              <span className="text-[9px] text-slate">
                {(result.durationMs / 1000).toFixed(1)}s
              </span>
              <ChevronDown
                className="size-3.5 text-slate-400 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <pre className="code-surface code-scroll overflow-x-auto border-t border-line p-4 text-[10px] leading-5">
              {result.output}
            </pre>
          </details>
        ))}
      </div>
    </section>
  );
}

function DiffPanel({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const fileCount = lines.filter((line) =>
    line.startsWith("diff --git "),
  ).length;
  const additions = lines.filter(
    (line) => line.startsWith("+") && !line.startsWith("+++"),
  ).length;
  const removals = lines.filter(
    (line) => line.startsWith("-") && !line.startsWith("---"),
  ).length;
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Code2 className="size-4 text-brandblue" aria-hidden="true" />
          <h2 className="text-sm font-bold text-navy">Git diff</h2>
        </div>
        <span className="text-[10px] font-semibold text-slate">
          {fileCount} {fileCount === 1 ? "file" : "files"} ·{" "}
          <span className="text-pass">+{additions}</span>{" "}
          <span className="text-fail">-{removals}</span>
        </span>
      </div>
      <div className="code-surface code-scroll max-h-[560px] overflow-auto py-3">
        {lines.map((line, index) => {
          const style =
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-line-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-line-remove"
                : line.startsWith("@@") ||
                    line.startsWith("diff ") ||
                    line.startsWith("index ")
                  ? "diff-line-meta"
                  : "text-[#c3c8d4]";
          return (
            <div
              key={index}
              className={`flex min-w-max font-mono text-[10px] leading-[19px] ${style}`}
            >
              <span className="w-11 shrink-0 pr-3 text-right text-[#5b6480] select-none">
                {index + 1}
              </span>
              <code className="whitespace-pre pr-5">{line || " "}</code>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ActivityTimeline({ events }: { events: TaskEvent[] }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2">
          <CircleDot className="size-4 text-copper" aria-hidden="true" />
          <h2 className="text-[12px] font-bold text-navy">Live activity</h2>
        </div>
        <span className="flex items-center gap-1.5 text-[9px] font-semibold text-slate">
          <span className="size-1.5 rounded-full bg-pass" aria-hidden="true" />
          Up to date
        </span>
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-6 text-center text-[10px] text-slate">
          No activity recorded yet.
        </p>
      ) : (
        <ol className="max-h-[440px] overflow-y-auto px-4 py-2">
          {events
            .slice()
            .reverse()
            .map((event, index) => (
              <li key={event.id} className="relative flex gap-3 py-3">
                {index < events.length - 1 && (
                  <span
                    className="absolute top-7 bottom-[-12px] left-[7px] w-px bg-line"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={`relative z-10 mt-1 size-[15px] shrink-0 rounded-full border-[4px] border-white ${
                    event.type === "approval"
                      ? "bg-copper"
                      : event.type === "error"
                        ? "bg-fail"
                        : event.actor === "agent"
                          ? "bg-brandblue"
                          : "bg-slate-400"
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[10px] leading-4 font-bold text-navy">
                      {event.title}
                    </p>
                    <time className="shrink-0 text-[8px] text-slate-400">
                      {timeOnly(event.createdAt)}
                    </time>
                  </div>
                  <p className="mt-1 text-[9px] leading-4 text-slate">
                    {event.detail}
                  </p>
                </div>
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}

function ToolActions({ tools }: { tools: ToolExecution[] }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Wrench className="size-3.5 text-copper" aria-hidden="true" />
          <h2 className="text-[12px] font-bold text-navy">Tool actions</h2>
        </div>
        <span className="text-[9px] font-semibold text-slate">
          {tools.length} calls
        </span>
      </div>
      {tools.length === 0 ? (
        <p className="px-4 py-6 text-center text-[10px] text-slate">
          No tool calls yet.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {tools
            .slice()
            .reverse()
            .slice(0, 8)
            .map((tool) => (
              <details key={tool.id} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 hover:bg-ivory-50">
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
                      tool.status === "failed"
                        ? "bg-fail-soft text-fail"
                        : "bg-brandblue-50 text-brandblue"
                    }`}
                  >
                    <Wrench className="size-3" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <code className="block truncate text-[9px] font-bold text-navy">
                      {tool.tool}
                    </code>
                    <p className="mt-0.5 truncate text-[8px] text-slate">
                      {tool.durationMs}ms · {tool.status}
                    </p>
                  </div>
                  <ChevronDown
                    className="size-3 text-slate-400 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <div className="border-t border-line bg-ivory-50 px-4 py-3 text-[9px] leading-4">
                  <p>
                    <strong className="text-navy">Input:</strong>{" "}
                    <span className="text-slate">{tool.inputSummary}</span>
                  </p>
                  <p className="mt-1.5">
                    <strong className="text-navy">Output:</strong>{" "}
                    <span className="text-slate">{tool.outputSummary}</span>
                  </p>
                </div>
              </details>
            ))}
        </div>
      )}
    </section>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeOnly(value: string) {
  return new Date(value).toLocaleTimeString("en", {
    hour: "numeric",
    minute: "2-digit",
  });
}
