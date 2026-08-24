"use client";

import { useState } from "react";
import { publicSitePath } from "@/lib/studio/catalog";

export function ShareLinkButton({
  draftId,
  compact = false,
}: {
  draftId: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}${publicSitePath(draftId)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link to share your website", url);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        data-testid="copy-share-link"
        className={compact ? "btn-quiet min-h-9 px-3 text-sm" : "btn-secondary"}
      >
        {copied ? "Copied!" : "Copy share link"}
      </button>
      <a
        href={publicSitePath(draftId)}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-semibold text-brandblue underline"
      >
        Open public site
      </a>
    </div>
  );
}
