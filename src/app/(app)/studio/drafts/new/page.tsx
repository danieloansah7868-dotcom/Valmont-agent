import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { NewDraftForm } from "@/components/studio/new-draft-form";
import { isCategoryId } from "@/lib/studio/categories";
import {
  defaultTemplateForCategory,
  getTemplate,
} from "@/lib/studio/templates";

export const dynamic = "force-dynamic";

/**
 * The "start a new website" page. It renders a form; the draft itself is only
 * created when the form is submitted.
 *
 * `?type=` arrives from the "Start from a Valmont template" list on the Studio
 * dashboard and pre-selects the website type, so a new client website is two
 * clicks away from the dashboard. An unknown or missing type simply means "no
 * pre-selection" — the form's own default applies.
 */
export default async function NewDraftPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await requireSessionUser();
  const { type } = await searchParams;
  const initialCategory = type && isCategoryId(type) ? type : undefined;
  const starterTemplate = initialCategory
    ? getTemplate(defaultTemplateForCategory(initialCategory))
    : undefined;

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
      {initialCategory && starterTemplate && (
        <p className="mt-2 text-sm text-slate-600">
          Valmont will start this website on the “{starterTemplate.label}”
          layout from its template library. Change the website type and Valmont
          picks the layout that suits it instead; step 3 lets you change both.
        </p>
      )}
      <div className="mt-6 rounded-xl border border-line bg-white p-4 sm:p-6">
        <NewDraftForm initialCategory={initialCategory} />
      </div>
    </div>
  );
}
