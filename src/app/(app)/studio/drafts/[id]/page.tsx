import { requireSessionUser } from "@/lib/auth";

export default async function DraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSessionUser();
  const { id } = await params;
  return (
    <div className="mx-auto max-w-[980px] p-6">
      <h1 className="text-xl font-bold">Draft {id}</h1>
      <p className="mt-2 text-sm text-slate">
        Wizard coming — brief editing via API is ready. Preview, revision
        concurrency and delete are tested at the API layer.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Brief completeness is computed from the stored brief and shown in the
        preview component.
      </p>
    </div>
  );
}
