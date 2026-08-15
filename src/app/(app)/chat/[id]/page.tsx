import { notFound } from "next/navigation";
import { ChatWorkspace } from "@/components/chat-workspace";
import { requireSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";

export const dynamic = "force-dynamic";

export default async function ChatSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSessionUser();
  const { id } = await params;
  const store = getChatStore();
  const [session, sessions] = await Promise.all([
    store.get(id, user.id),
    store.list(user.id),
  ]);
  if (!session) notFound();

  return (
    <ChatWorkspace
      key={session.id}
      activeSession={session}
      repositories={[]}
      sessions={sessions}
    />
  );
}
