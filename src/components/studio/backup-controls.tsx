"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { csrfToken } from "@/lib/client-api";

/**
 * Mirrors `ImportSummary` in `@/lib/studio/backup`, plus the `notice` the route
 * adds. Every field the server reports is rendered somewhere below: a count the
 * client quietly drops is a count the owner is never told about, which is the
 * exact failure this restore flow was corrected for.
 */
interface ImportSummary {
  sourceVersion: 1 | 2;
  chatSessions: number;
  memories: number;
  skippedMemories: number;
  studioDrafts: number;
  remappedDraftIds: number;
  customerAccounts: number;
  skippedCustomerAccounts: number;
  customerSessions: number;
  customerTokens: number;
  atomicity: "single-transaction" | "coordinated";
  notice?: string;
}

/**
 * The 500 body sent only when the import failed AND rolling it back also
 * failed — the exceptional case where the durable recovery record will finish
 * the rollback on a later attempt.
 */
interface PartialFailure {
  error: string;
  partial: true;
  committed: { chat: boolean; studio: boolean };
}

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; summary: ImportSummary }
  | { kind: "failed"; message: string }
  | { kind: "partial"; failure: PartialFailure };

/** Download a complete backup, or restore one into your own account. */
export function BackupControls() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function importFile(file: File) {
    const confirmed = window.confirm(
      "Importing adds everything in this file to your account. Nothing you already have is deleted, and any draft with a clashing id is added as a separate copy. Continue?",
    );
    if (!confirmed) return;

    setStatus({ kind: "working" });
    try {
      const response = await fetch("/api/backup/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-valmont-csrf": csrfToken(),
        },
        body: await file.text(),
      });

      // The response is always checked. A failed import is never reported as
      // a success.
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as
          (Partial<PartialFailure> & { error?: string }) | null;

        // A partial response is sent only when the rollback itself failed.
        // Surface exactly which halves are known to have landed so the owner
        // does not retry blindly and duplicate data before recovery finishes.
        if (problem?.partial && problem.committed) {
          setStatus({
            kind: "partial",
            failure: {
              error: problem.error ?? "The import did not finish.",
              partial: true,
              committed: problem.committed,
            },
          });
          router.refresh();
          return;
        }

        throw new Error(
          problem?.error ?? `Import failed (status ${response.status}).`,
        );
      }

      const summary = (await response.json()) as ImportSummary;
      setStatus({ kind: "done", summary });
      router.refresh();
    } catch (cause) {
      setStatus({
        kind: "failed",
        message:
          cause instanceof Error
            ? cause.message
            : "Import failed. The file may not be a Valmont backup.",
      });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-3">
        <a
          href="/api/backup/export"
          className="btn-secondary text-sm"
          data-testid="download-backup"
        >
          Download a complete backup
        </a>
        <label className="btn-secondary cursor-pointer text-sm">
          Restore from a backup file
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="import-backup"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
        </label>
      </div>

      <p className="text-xs text-slate-500">
        The backup holds your chats, memories and website drafts. Older
        chat-only backups still work.
      </p>

      <p role="status" aria-live="polite" className="text-sm">
        {status.kind === "working" && "Restoring your backup…"}
        {status.kind === "done" && (
          <span data-testid="import-result" className="text-green-800">
            Restored {status.summary.chatSessions} chat
            {status.summary.chatSessions === 1 ? "" : "s"},{" "}
            {status.summary.memories} memor
            {status.summary.memories === 1 ? "y" : "ies"} and{" "}
            {status.summary.studioDrafts} draft
            {status.summary.studioDrafts === 1 ? "" : "s"}
            {status.summary.remappedDraftIds > 0
              ? ` (${status.summary.remappedDraftIds} draft${
                  status.summary.remappedDraftIds === 1 ? "" : "s"
                } added as a separate copy)`
              : ""}
            {status.summary.customerAccounts > 0 ||
            status.summary.customerSessions > 0 ||
            status.summary.customerTokens > 0
              ? `, plus ${status.summary.customerAccounts} customer account${
                  status.summary.customerAccounts === 1 ? "" : "s"
                }`
              : ""}
            .
          </span>
        )}
      </p>

      {/* Accounts already on this machine are deliberately left untouched —
          a restore never overwrites a customer's current password. */}
      {status.kind === "done" && status.summary.skippedCustomerAccounts > 0 && (
        <p
          role="status"
          data-testid="import-skipped-customers"
          className="text-sm text-amber-800"
        >
          {status.summary.skippedCustomerAccounts} customer account
          {status.summary.skippedCustomerAccounts === 1 ? "" : "s"} already
          existed here and were left unchanged.
        </p>
      )}

      {/* Skipped memories are reported next to the success, not hidden by it.
          The counts above are what was written; this is what was not. */}
      {status.kind === "done" && status.summary.skippedMemories > 0 && (
        <p
          role="status"
          data-testid="import-skipped"
          className="text-sm text-amber-800"
        >
          {status.summary.notice ??
            `${status.summary.skippedMemories} memor${
              status.summary.skippedMemories === 1 ? "y was" : "ies were"
            } not restored because the text looked like a password or key.`}
        </p>
      )}

      {status.kind === "partial" && (
        <div
          role="alert"
          data-testid="import-partial"
          className="grid gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <strong>
            Your restore did not finish, and rolling it back also failed.
          </strong>
          <span>{status.failure.error}</span>
          <span>
            Chats and memories:{" "}
            {status.failure.committed.chat ? "may be restored" : "not restored"}
            . Website drafts:{" "}
            {status.failure.committed.studio
              ? "may be restored"
              : "not restored"}
            .
          </span>
          <span>
            The recovery record is safe on disk and the next import attempt will
            roll everything back before it starts, so wait for that before
            retrying — importing the same file again could otherwise create
            duplicate copies.
          </span>
        </div>
      )}

      {status.kind === "failed" && (
        <p
          role="alert"
          data-testid="import-error"
          className="text-sm text-red-700"
        >
          {status.message}
        </p>
      )}
    </div>
  );
}
