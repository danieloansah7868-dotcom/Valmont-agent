import { notFound } from "next/navigation";
import { TaskDetail } from "@/components/task-detail";
import { requireSessionUser } from "@/lib/auth";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSessionUser();
  const task = await getTaskStore(user).get(id);
  if (!task) notFound();
  return <TaskDetail initialTask={task} />;
}
