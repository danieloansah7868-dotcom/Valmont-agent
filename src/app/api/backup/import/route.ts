import { NextResponse, type NextRequest } from "next/server";
import { assertCsrf } from "@/lib/security";
import { requireApiSessionUser } from "@/lib/auth";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { BACKUP_BODY_LIMIT_BYTES, readBoundedJson } from "@/lib/bounded-json";
import {
  importBackup,
  parseBackup,
  PartialImportError,
} from "@/lib/studio/backup";

/**
 * Restores a backup file into the signed-in person's own account.
 *
 * Order matters: the version is checked and the entire file validated *before*
 * a single row is written. Owner ids inside the file are ignored — everything
 * is filed under the person doing the import.
 *
 * The success body reports `atomicity`. On SQLite the whole import is one
 * transaction. On PostgreSQL chat lives in SQLite and drafts in PostgreSQL, so
 * the two halves commit separately; if the second half fails this returns 500
 * with `committed`, naming exactly what was written, rather than implying
 * nothing happened.
 */
export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "backup-import", 5);
    const user = await requireApiSessionUser();

    const raw = await readBoundedJson(
      request as unknown as Request,
      BACKUP_BODY_LIMIT_BYTES,
    );
    // Throws before any write when the version is unknown or the file is bad.
    const backup = parseBackup(raw);

    const summary = await importBackup(user, backup);
    return NextResponse.json(summary, { status: 200 });
  } catch (error) {
    if (error instanceof PartialImportError) {
      return NextResponse.json(
        {
          error: error.message,
          partial: true,
          committed: error.committed,
        },
        { status: error.status },
      );
    }
    return safeApiError(error);
  }
}
