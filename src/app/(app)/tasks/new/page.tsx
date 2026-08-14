import { NewTaskForm } from "@/components/new-task-form";
import { getGitHubProvider } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ repository?: string }>;
}) {
  const [params, provider] = await Promise.all([
    searchParams,
    getGitHubProvider(),
  ]);
  const repositories = await provider.listRepositories();
  return (
    <div className="mx-auto max-w-[1080px] px-4 py-7 sm:px-7 sm:py-9">
      <p className="text-[12px] font-bold tracking-[0.08em] text-[#6c7b74] uppercase">
        New agent task
      </p>
      <h1 className="mt-1.5 text-[29px] font-bold tracking-[-0.035em]">
        What would you like to change?
      </h1>
      <p className="mt-2 mb-7 text-sm text-[#6b7872]">
        Valmont will inspect the selected repository and return a plan for your
        approval.
      </p>
      <NewTaskForm
        repositories={repositories}
        initialRepositoryId={params.repository}
      />
    </div>
  );
}
