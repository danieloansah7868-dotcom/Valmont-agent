/* eslint-disable */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertCsrf } from "@/lib/security";
import { requireApiSessionUser } from "@/lib/auth";
import { safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const user = await requireApiSessionUser();
    const json = (await readBoundedJson(
      request as unknown as Request,
      25_000_000,
    )) as any;
    if (json.backupVersion !== 1 && json.backupVersion !== 2)
      throw new Error("Unsupported backup version");
    // basic validation then delegate to chat import; studio import best-effort
    const { getChatStore } = await import("@/lib/chat-store");
    if (json.sessions || json.chat) {
      const chatData = json.chat || json;
      if (chatData.sessions) {
        await getChatStore().importUser(user.id, {
          sessions: chatData.sessions,
          memories: chatData.memories || [],
          memoryEnabled: chatData.memoryEnabled,
        });
      }
    }
    if (json.studio?.drafts) {
      const { getStudioDraftStore } = await import("@/lib/studio/draft-store");
      const store = getStudioDraftStore();
      for (const d of json.studio.drafts) {
        try {
          await store.create(user, d.brief);
        } catch {}
      }
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return safeApiError(e);
  }
}
