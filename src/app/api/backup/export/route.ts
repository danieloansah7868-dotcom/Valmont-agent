import { NextResponse, type NextRequest } from "next/server";
import { requireApiSessionUser } from "@/lib/auth";
import { assertOwnerRateLimit, safeApiError } from "@/lib/api";
import { canonicalUserId } from "@/lib/user-identity";
import { buildBackup } from "@/lib/studio/backup";

/**
 * Downloads everything this signed-in person has: chat history, memories and
 * website drafts, in one version 2 file. Failures are reported, never quietly
 * turned into an empty export.
 */
export async function GET(request: NextRequest) {
  try {
    void request;
    const user = await requireApiSessionUser();
    assertOwnerRateLimit("backup-export", canonicalUserId(user), 10);
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
