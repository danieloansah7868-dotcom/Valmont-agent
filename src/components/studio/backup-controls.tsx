"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { csrfToken } from "@/lib/client-api";

interface ImportSummary {
  sourceVersion: 1 | 2;
  chatSessions: number;
  memories: number;
  studioDrafts: number;
  remappedDraftIds: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; summary: ImportSummary }
  | { kind: "failed"; message: string };

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
        const problem = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
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
            .
          </span>
        )}
      </p>

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
