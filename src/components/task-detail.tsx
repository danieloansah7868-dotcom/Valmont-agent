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
        className="mb-5 inline-flex items-center gap-1.5 text-[11px] font-bold text-[#6e7b75] hover:text-[#24644c]"
      >
        <ArrowLeft className="size-3.5" /> Back to tasks
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge state={task.state} />
            {task.demo && <DemoBadge compact />}
            <span className="text-[10px] font-medium text-[#8a958f]">
              {task.id.slice(0, 18)}
            </span>
          </div>
          <h1 className="mt-3 text-[25px] leading-8 font-bold tracking-[-0.035em] sm:text-[29px]">
            {task.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[#718078]">
            <span className="flex items-center gap-1.5 font-semibold text-[#4c5d55]">
              <GitBranch className="size-3.5" />
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
            <GitPullRequest className="size-4" /> View pull request result
          </Link>
        )}
      </div>

      <Progress state={task.state} />
      {error && (
        <div
          role="alert"
          className="mt-5 flex items-center gap-2 rounded-lg border border-[#efc5c1] bg-[#fff3f2] p-3 text-xs font-medium text-[#993936]"
        >
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-5">
          <section className="card p-5 sm:p-6">
            <p className="text-[10px] font-bold tracking-[0.08em] text-[#78857f] uppercase">
              Requested outcome
            </p>
            <p className="mt-3 text-[13px] leading-6 text-[#45544d]">
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
            <div className="rounded-xl border border-[#d8dfda] bg-[#f1f3f1] p-5">
              <div className="flex items-center gap-2 text-[#4f5d56]">
                <X className="size-4" />
                <h2 className="text-sm font-bold">Task cancelled</h2>
              </div>
              <p className="mt-2 text-[11px] text-[#78837e]">
                No pull request was created. Start a new task to propose a
                revised approach.
              </p>
              <Link href="/tasks/new" className="btn-secondary mt-4 text-xs">
                <RotateCcw className="size-3.5" /> Start a new task
              </Link>
            </div>
          )}
          {task.state === "failed" && (
            <div className="rounded-xl border border-[#e7bfba] bg-[#fff3f2] p-5">
              <div className="flex items-center gap-2 text-[#923a34]">
                <AlertCircle className="size-5" />
                <h2 className="text-sm font-bold">Task stopped safely</h2>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-[#7b5a56]">
                Review the latest audit event for the failure reason. No pull
                request was merged or deployed.
              </p>
              <Link href="/tasks/new" className="btn-secondary mt-4 text-xs">
                <RotateCcw className="size-3.5" /> Start a revised task
              </Link>
            </div>
          )}
          {task.state === "completed" && (
            <div className="rounded-xl border border-[#bcdaca] bg-[#eef8f2] p-5">
              <div className="flex items-center gap-2 text-[#216044]">
                <CheckCircle2 className="size-5" />
                <h2 className="text-sm font-bold">
                  Pull request created for human review
                </h2>
              </div>
              <p className="mt-2 text-[11px] text-[#557566]">
                Valmont has finished. It did not merge or deploy the changes.
              </p>
              <Link
                href={`/tasks/${task.id}/result`}
                className="btn-primary mt-4 text-xs"
              >
                View result <ExternalLink className="size-3.5" />
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
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${index < current ? "bg-[#287155] text-white" : index === current ? "bg-[#173f32] text-white ring-4 ring-[#dcebe3]" : "bg-[#edf1ee] text-[#89958f]"}`}
            >
              {index < current ? <Check className="size-3.5" /> : index + 1}
            </span>
            <span
              className={`ml-2 text-[10px] font-bold ${index <= current ? "text-[#34483f]" : "text-[#929c97]"}`}
            >
              {step}
            </span>
            {index < steps.length - 1 && (
              <span
                className={`mx-3 h-px flex-1 ${index < current ? "bg-[#4d9275]" : "bg-[#dfe5e1]"}`}
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
      <div className="flex items-start justify-between border-b border-[#e2e8e4] px-5 py-4 sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <FileCode2 className="size-4 text-[#316b54]" />
            <h2 className="text-sm font-bold">Implementation plan</h2>
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-[#77837d]">
            {plan.summary}
          </p>
        </div>
        <span
          className={`ml-4 rounded-full px-2 py-1 text-[9px] font-bold uppercase ${plan.risk === "low" ? "bg-[#e8f5ed] text-[#277052]" : "bg-[#fff2da] text-[#94601c]"}`}
        >
          {plan.risk} risk
        </span>
      </div>
      <ol className="divide-y divide-[#e7ece9]">
        {plan.steps.map((step, index) => (
          <li key={step.title} className="flex gap-4 px-5 py-4 sm:px-6">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#edf4ef] text-[10px] font-bold text-[#2f6a52]">
              {index + 1}
            </span>
            <div className="min-w-0">
              <h3 className="text-[12px] font-bold">{step.title}</h3>
              <p className="mt-1.5 text-[11px] leading-5 text-[#707d76]">
                {step.description}
              </p>
              {step.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {step.files.map((file) => (
                    <code
                      key={file}
                      className="rounded bg-[#f0f3f1] px-1.5 py-1 text-[9px] text-[#526159]"
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
      <div className="border-t border-[#e4e9e6] bg-[#fafbfa] px-5 py-3.5 sm:px-6">
        <span className="text-[10px] font-bold text-[#69766f]">
          Approved validation
        </span>
        <div className="mt-2 flex flex-wrap gap-2">
          {plan.validationCommands.map((command) => (
            <code
              key={command}
              className="rounded-md border border-[#dce4df] bg-white px-2 py-1 text-[9px] text-[#405148]"
            >
              $ {command}
            </code>
          ))}
        </div>
      </div>
    </section>
  );
}

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
    <section className="overflow-hidden rounded-xl border border-[#e5ca91] bg-[#fffbf1] shadow-[0_3px_12px_rgba(111,78,22,0.06)]">
      <div className="flex gap-3 p-5 sm:p-6">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#fff0c9] text-[#9b6118]">
          <LockKeyhole className="size-[17px]" />
        </span>
        <div>
          <p className="text-[10px] font-bold tracking-[0.09em] text-[#97621f] uppercase">
            Explicit approval boundary
          </p>
          <h2 className="mt-1 text-[14px] font-bold text-[#49391f]">
            {final
              ? "Review the complete patch before creating a PR"
              : "Review the plan before execution"}
          </h2>
          <p className="mt-2 max-w-2xl text-[11px] leading-5 text-[#776346]">
            {final
              ? "Approving will authorize a valmont/* branch, commit, and pull request. Valmont will not merge or deploy it."
              : "Approving allows the agent to modify files and run only the validation commands listed above. It does not authorize a pull request."}
          </p>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-[#ecd9b0] bg-[#fff8e8] px-5 py-4 sm:flex-row sm:justify-end">
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
              <span className="size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />{" "}
              Working…
            </>
          ) : (
            <>
              <ShieldCheck className="size-4" />
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
      <div className="flex items-center justify-between border-b border-[#e2e8e4] px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-[#365f77]" />
          <h2 className="text-sm font-bold">Validation results</h2>
        </div>
        <span
          className={`flex items-center gap-1 text-[10px] font-bold ${allPassed ? "text-[#277052]" : "text-[#a24b33]"}`}
        >
          {allPassed ? (
            <CheckCircle2 className="size-3.5" />
          ) : (
            <AlertCircle className="size-3.5" />
          )}
          {allPassed ? "All checks passed" : "Review failed checks"}
        </span>
      </div>
      <div className="divide-y divide-[#e6ebe8]">
        {task.validations.map((result) => (
          <details key={result.command} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 sm:px-6">
              {result.status === "passed" ? (
                <CheckCircle2 className="size-4 text-[#2d7958]" />
              ) : (
                <AlertCircle className="size-4 text-[#b04d3b]" />
              )}
              <code className="flex-1 text-[11px] font-bold text-[#394a42]">
                {result.command}
              </code>
              <span className="text-[9px] text-[#89948f]">
                {(result.durationMs / 1000).toFixed(1)}s
              </span>
              <ChevronDown className="size-3.5 text-[#87938d] transition-transform group-open:rotate-180" />
            </summary>
            <pre className="overflow-x-auto border-t border-[#e1e6e3] bg-[#17241f] p-4 text-[10px] leading-5 text-[#d0ded7]">
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
      <div className="flex items-center justify-between border-b border-[#e2e8e4] px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Code2 className="size-4 text-[#665f87]" />
          <h2 className="text-sm font-bold">Git diff</h2>
        </div>
        <span className="text-[10px] font-semibold text-[#77837d]">
          {fileCount} {fileCount === 1 ? "file" : "files"} ·{" "}
          <span className="text-[#278156]">+{additions}</span>{" "}
          <span className="text-[#b84b49]">−{removals}</span>
        </span>
      </div>
      <div className="code-scroll max-h-[560px] overflow-auto bg-[#14211d] py-3">
        {diff.split("\n").map((line, index) => {
          const style =
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-line-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-line-remove"
                : line.startsWith("@@") ||
                    line.startsWith("diff ") ||
                    line.startsWith("index ")
                  ? "diff-line-meta"
                  : "text-[#becbc5]";
          return (
            <div
              key={index}
              className={`flex min-w-max font-mono text-[10px] leading-[19px] ${style}`}
            >
              <span className="w-11 shrink-0 pr-3 text-right text-[#586a62] select-none">
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
      <div className="flex items-center justify-between border-b border-[#e2e8e4] px-4 py-3.5">
        <div className="flex items-center gap-2">
          <CircleDot className="size-4 text-[#316e54]" />
          <h2 className="text-[12px] font-bold">Live activity</h2>
        </div>
        <span className="flex items-center gap-1.5 text-[9px] font-semibold text-[#718078]">
          <span className="size-1.5 rounded-full bg-[#3f9a70]" />
          Up to date
        </span>
      </div>
      <ol className="max-h-[440px] space-y-0 overflow-y-auto px-4 py-2">
        {events
          .slice()
          .reverse()
          .map((event, index) => (
            <li key={event.id} className="relative flex gap-3 py-3">
              {index < events.length - 1 && (
                <span className="absolute top-7 bottom-[-12px] left-[7px] w-px bg-[#e0e6e2]" />
              )}
              <span
                className={`relative z-10 mt-1 size-[15px] shrink-0 rounded-full border-[4px] border-white ${event.type === "approval" ? "bg-[#d08a2f]" : event.type === "error" ? "bg-[#c9504c]" : event.actor === "agent" ? "bg-[#39795e]" : "bg-[#8a9790]"}`}
              />
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[10px] font-bold leading-4 text-[#384840]">
                    {event.title}
                  </p>
                  <time className="shrink-0 text-[8px] text-[#98a19d]">
                    {timeOnly(event.createdAt)}
                  </time>
                </div>
                <p className="mt-1 text-[9px] leading-4 text-[#7a8780]">
                  {event.detail}
                </p>
              </div>
            </li>
          ))}
      </ol>
    </section>
  );
}

function ToolActions({ tools }: { tools: ToolExecution[] }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#e2e8e4] px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Wrench className="size-3.5 text-[#536e61]" />
          <h2 className="text-[12px] font-bold">Tool actions</h2>
        </div>
        <span className="text-[9px] font-semibold text-[#89948f]">
          {tools.length} calls
        </span>
      </div>
      <div className="divide-y divide-[#e8ece9]">
        {tools
          .slice()
          .reverse()
          .slice(0, 8)
          .map((tool) => (
            <details key={tool.id} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#edf2ef]">
                  <Wrench className="size-3 text-[#567064]" />
                </span>
                <div className="min-w-0 flex-1">
                  <code className="block truncate text-[9px] font-bold text-[#3f5148]">
                    {tool.tool}
                  </code>
                  <p className="mt-0.5 truncate text-[8px] text-[#909a95]">
                    {tool.durationMs}ms · {tool.status}
                  </p>
                </div>
                <ChevronDown className="size-3 text-[#929d97] transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-[#e5eae7] bg-[#fafbfa] px-4 py-3 text-[9px] leading-4">
                <p>
                  <strong className="text-[#596860]">Input:</strong>{" "}
                  <span className="text-[#7c8882]">{tool.inputSummary}</span>
                </p>
                <p className="mt-1.5">
                  <strong className="text-[#596860]">Output:</strong>{" "}
                  <span className="text-[#7c8882]">{tool.outputSummary}</span>
                </p>
              </div>
            </details>
          ))}
      </div>
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
