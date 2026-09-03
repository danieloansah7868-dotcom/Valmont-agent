import { Lightbulb } from "lucide-react";
import { IdeaBoard } from "@/components/idea-board";
import { requireSessionUser } from "@/lib/auth";
import { getIdeaStore } from "@/lib/idea-store";

export const dynamic = "force-dynamic";

export default async function IdeasPage() {
  const user = await requireSessionUser();
  const initialIdeas = await getIdeaStore().list(user.id);

  return (
    <div className="mx-auto max-w-[940px] px-4 py-7 sm:px-7 sm:py-9">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold tracking-[0.16em] text-copper uppercase">
            Private notebook
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-navy">
            Ideas &amp; future plans
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate">
            Private to your account. Nothing here is sent to the chat model.
          </p>
        </div>
        <Lightbulb className="size-8 text-copper" aria-hidden="true" />
      </div>
      <IdeaBoard initialIdeas={initialIdeas} />
    </div>
  );
}
