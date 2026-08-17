import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { NewDraftForm } from "@/components/studio/new-draft-form";

export const dynamic = "force-dynamic";

/**
 * The "start a new website" page. It renders a form; the draft itself is only
 * created when the form is submitted.
 */
export default async function NewDraftPage() {
  await requireSessionUser();
  return (
    <div className="mx-auto w-full max-w-[720px] p-4 sm:p-6">
      <Link href="/studio" className="text-sm text-slate underline">
        ← Back to Website Studio
      </Link>
      <h1 className="mt-3 text-2xl font-bold text-navy">Start a new website</h1>
      <p className="mt-2 text-sm text-slate">
        Answer two quick questions. You can change everything afterwards, and
        your answers save as you type.
      </p>
      <div className="mt-6 rounded-xl border border-line bg-white p-4 sm:p-6">
        <NewDraftForm />
      </div>
    </div>
  );
}
