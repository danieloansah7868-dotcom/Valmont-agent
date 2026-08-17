import { requireSessionUser } from "@/lib/auth";
import Link from "next/link";

export default async function StudioPage() {
  await requireSessionUser();
  return (
    <div className="mx-auto max-w-[980px] p-6">
      <h1 className="text-2xl font-bold text-navy">Website Studio</h1>
      <p className="mt-2 text-sm text-slate">
        Create a professional website draft. Deferred features are marked Coming
        Soon.
      </p>
      <div className="mt-6 rounded-xl border border-line bg-white p-4">
        <p className="text-sm font-semibold">Coming Soon — not working yet</p>
        <ul className="mt-2 text-xs text-slate-600 list-disc pl-4">
          <li>Logo & photo uploads — Phase 2</li>
          <li>Repository generation — Phase 5</li>
          <li>Payments & checkout — Phase 3</li>
          <li>Production deploy — Phase 6</li>
        </ul>
      </div>
      <Link href="/studio/drafts/new" className="btn-primary mt-6 inline-flex">
        Start new website
      </Link>
      <p className="mt-4 text-xs text-slate-500">
        Draft list loads via API — sign in to see your drafts.
      </p>
    </div>
  );
}
