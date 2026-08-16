import { NextResponse } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { getChatStore } from "@/lib/chat-store";
import { safeApiError } from "@/lib/api";
export async function GET() {
  try {
    const user = await requireApiSessionUser();
    const backup = await getChatStore().exportUser(user.id);
    return new NextResponse(JSON.stringify(backup, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition":
          'attachment; filename="valmont-chat-backup.json"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return safeApiError(error);
  }
}
