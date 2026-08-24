"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  websiteEditorPath,
  type WebsiteSwitcherOption,
} from "@/lib/studio/websites";

/**
 * The quick switcher on the Studio dashboard.
 *
 * One entry per client website the signed-in owner owns; choosing one opens
 * that website in the editor. The option list is built server-side from the
 * owner's own drafts only (`websitesForOwner` in `@/lib/studio/websites`), so
 * a guessed or foreign draft id can never appear here as a choice.
 */
export function WebsiteSwitcher({
  websites,
  selectedWebsiteId,
}: {
  websites: WebsiteSwitcherOption[];
  selectedWebsiteId?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function switchWebsite(value: string) {
    if (!value) return;
    startTransition(() => {
      router.push(websiteEditorPath(value));
    });
  }

  return (
    <label className="block min-w-0 sm:min-w-72">
      <span className="label">Your websites</span>
      <select
        className="select"
        value={selectedWebsiteId ?? ""}
        onChange={(event) => switchWebsite(event.target.value)}
        disabled={isPending}
        aria-label="Switch website"
        data-testid="website-switcher"
      >
        <option value="">
          {websites.length === 1
            ? "Jump to your website…"
            : `Jump to one of your ${websites.length} websites…`}
        </option>
        {websites.map((website) => (
          <option key={website.id} value={website.id}>
            {website.name}
          </option>
        ))}
      </select>
      {isPending && (
        <span className="mt-1 block text-xs text-slate-500" aria-live="polite">
          Opening…
        </span>
      )}
    </label>
  );
}
