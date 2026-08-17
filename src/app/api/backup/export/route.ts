import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { buildBackup } from "@/lib/studio/backup";

/**
 * Downloads everything this signed-in person has: chat history, memories and
 * website drafts, in one version 2 file. Failures are reported, never quietly
 * turned into an empty export.
 */
export async function GET(request: NextRequest) {
  try {
    assertApiRateLimit(request, "backup-export", 10);
    const user = await requireApiSessionUser();
    const backup = await buildBackup(user);
    const stamp = backup.exportedAt.slice(0, 10);
    return NextResponse.json(backup, {
      headers: {
        "content-disposition": `attachment; filename="valmont-backup-${stamp}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return safeApiError(error);
  }
}
