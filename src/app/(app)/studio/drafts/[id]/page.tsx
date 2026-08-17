import { requireSessionUser } from "@/lib/auth";
import { getStudioDraftStore } from "@/lib/studio/draft-store";
import { Wizard } from "@/components/studio/wizard";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await params;
  const draft = await getStudioDraftStore().get(user, id);
  if (!draft) return <div className="p-6">Draft not found</div>;
  return <Wizard id={id} initial={draft} />;
}
