import { NextResponse } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { safeApiError } from "@/lib/api";

export async function GET() {
  try {
    const user = await requireApiSessionUser();
    const chat = await getChatStore().exportUser(user.id);
    // studio draft export attempt - best effort
    let studio: unknown = { version: 1, schemaVersion: 1, drafts: [] };
    try {
      const { getStudioDraftStore } = await import("@/lib/studio/draft-store");
      const drafts = await getStudioDraftStore().list(user);
      studio = { version: 1, schemaVersion: 1, drafts };
    } catch {}
    return NextResponse.json({
      backupVersion: 2,
      exportedAt: new Date().toISOString(),
      chat,
      studio,
    });
  } catch (e) {
    return safeApiError(e);
  }
}
