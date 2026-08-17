import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import { getCategory } from "@/lib/studio/categories";
import { BackupControls } from "@/components/studio/backup-controls";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const user = await requireSessionUser();
  const drafts = await getStudioDraftStore().list(user);

  return (
    <div className="mx-auto w-full max-w-[980px] p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-navy">Website Studio</h1>
      <p className="mt-2 text-sm text-slate">
        Plan a website: choose the type, the package, the look, and fill in your
        business details. Everything saves as you type, and you can come back to
        it later on any device.
      </p>

      <Link
        href="/studio/drafts/new"
        className="btn-primary mt-5 inline-flex w-full justify-center sm:w-auto"
        data-testid="start-new-website"
      >
        Start new website
      </Link>

      <section className="mt-8" aria-labelledby="your-drafts">
        <h2 id="your-drafts" className="text-lg font-semibold text-navy">
          Your drafts
        </h2>
        {drafts.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            You have no drafts yet. Use “Start new website” above to make your
            first one.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3" data-testid="draft-list">
            {drafts.map((draft) => {
              const completeness = computeBriefCompleteness(draft.brief);
              const category = getCategory(draft.brief.category);
              return (
                <li
                  key={draft.id}
                  className="rounded-xl border border-line bg-white p-4"
                >
                  <Link
                    href={`/studio/drafts/${draft.id}`}
                    className="text-base font-semibold text-navy underline"
                  >
                    {draft.brief.businessName}
                  </Link>
                  <p className="mt-1 text-xs text-slate-600">
                    {category?.label ?? draft.brief.category} · Brief{" "}
                    {completeness.score}% complete ·{" "}
                    {completeness.missingRequired.length} required item
                    {completeness.missingRequired.length === 1 ? "" : "s"} left
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Last saved{" "}
                    {new Date(draft.updatedAt).toLocaleString("en-GB", {
                      timeZone: "Africa/Accra",
                    })}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="backup-heading">
        <h2 id="backup-heading" className="text-lg font-semibold text-navy">
          Backup
        </h2>
        <div className="mt-3">
          <BackupControls />
        </div>
      </section>

      <section
        className="mt-8 rounded-xl border border-line bg-white p-4"
        aria-labelledby="not-yet-heading"
      >
        <h2 id="not-yet-heading" className="text-sm font-semibold">
          Not working yet — planned for later phases
        </h2>
        <ul className="mt-2 list-disc pl-4 text-xs text-slate-600">
          <li>Logo and photo uploads — Phase 2</li>
          <li>Building the real website code — Phase 5</li>
          <li>
            Payments and checkout (Mobile Money, Paystack, Valmont Pay, cards) —
            Phase 3. Anything you record now is a note about your preferences
            only; nothing can take a payment.
          </li>
          <li>Publishing the website online — Phase 6</li>
        </ul>
      </section>

      <p className="mt-4 text-xs text-slate-500">
        Drafts are stored in the same database file as your chats, or in
        PostgreSQL when DATABASE_URL is set.
      </p>
    </div>
  );
}
