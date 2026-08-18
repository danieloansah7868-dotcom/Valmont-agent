import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { Wizard } from "@/components/studio/wizard";

export const dynamic = "force-dynamic";

export default async function DraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSessionUser();
  const { id } = await params;
  // `get` is owner-scoped, so another person's draft and a made-up id produce
  // exactly the same page. Nothing reveals whether the draft exists.
  const draft = await getStudioDraftStore().get(user, id);

  if (!draft) {
    return (
      <div className="mx-auto w-full max-w-[720px] p-6">
        <h1 className="text-xl font-bold text-navy">Draft not found</h1>
        <p className="mt-2 text-sm text-slate">
          This draft does not exist, or it is not one of yours.
        </p>
        <Link href="/studio" className="btn-primary mt-4 inline-flex">
          Back to Website Studio
        </Link>
      </div>
    );
  }

  return <Wizard id={id} initial={draft} />;
}
