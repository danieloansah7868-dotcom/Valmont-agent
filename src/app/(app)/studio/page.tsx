import { requireSessionUser } from "@/lib/auth";

import Link from "next/link";
import { BackupControls } from "@/components/studio/backup-controls";

export default async function StudioPage() {
  await requireSessionUser();
  return (
    <div className="mx-auto max-w-[980px] p-6">
      <h1 className="text-2xl font-bold text-navy">Website Studio</h1>
      <p className="mt-2 text-sm text-slate">
        Create a professional website draft. Phase 1 can save drafts, show Brief
        completeness, and preview. Deferred: uploads, payments, repo generation,
        deploys (Phases 2–6).
      </p>
      <div className="mt-6 rounded-xl border border-line bg-white p-4">
        <p className="text-sm font-semibold">
          Coming Soon — not working yet (Phases 2–6)
        </p>
        <ul className="mt-2 text-xs text-slate-600 list-disc pl-4">
          <li>Logo & photo uploads — Phase 2</li>
          <li>Repository generation — Phase 5</li>
          <li>
            Payments & checkout (MoMo/Paystack/Valmont Pay) — Phase 3, planning
            only
          </li>
          <li>Production deploy — Phase 6</li>
        </ul>
      </div>
      <Link href="/studio/drafts/new" className="btn-primary mt-6 inline-flex">
        Start new website
      </Link>
      <div className="mt-6">
        <BackupControls />
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Drafts are stored in the shared SQLite file (same as Chat) or PostgreSQL
        when DATABASE_URL is set. Backup v2 includes chat + studio.
      </p>
    </div>
  );
}
