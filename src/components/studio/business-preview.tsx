"use client";

import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import type { SiteBriefV1 } from "@/lib/studio/site-brief/schema";
import { getTemplate } from "@/lib/studio/templates";
import { getTheme } from "@/lib/studio/themes";
import { Storefront } from "./storefront";

/**
 * A preview of the future website. It shows only what the owner typed. When
 * the shop has payments on and at least one priced item, the same basket and
 * checkout a real customer will use is live inside the preview.
 */
export function BusinessPreview({
  brief,
  draftId,
}: {
  brief: Partial<SiteBriefV1>;
  draftId?: string;
}) {
  const completeness = computeBriefCompleteness(brief);
  const theme = brief.selectedTheme ? getTheme(brief.selectedTheme) : undefined;
  const template = brief.selectedTemplate
    ? getTemplate(brief.selectedTemplate)
    : undefined;
  const shopOpen = Boolean(brief.payments?.enabled);

  return (
    <section
      aria-label="Website preview"
      data-testid="business-preview"
      className="overflow-hidden rounded-xl border border-line bg-white"
    >
      <p className="px-4 pt-3 text-[11px] uppercase tracking-wide text-slate-500">
        Preview{template ? ` · ${template.label}` : ""}
        {theme ? ` · ${theme.label}` : ""}
      </p>
      <Storefront brief={brief} draftId={draftId} variant="preview" />
      <footer className="border-t border-line bg-slate-50 p-3 text-xs text-slate-600">
        Brief completeness: {completeness.score}% ·{" "}
        {completeness.missingRequired.length} required item
        {completeness.missingRequired.length === 1 ? "" : "s"} still needed.
        {shopOpen
          ? " This shop can take orders."
          : " This is a plan, not a live website — nothing here can take orders or payments."}
      </footer>
    </section>
  );
}
