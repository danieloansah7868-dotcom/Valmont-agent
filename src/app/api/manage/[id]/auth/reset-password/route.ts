import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { InvalidShopAdminLinkError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { getShopAdminStore } from "@/lib/shop-admin/store";

/**
 * Reset password with a one-time link. On success every existing session for
 * that login is revoked — whoever prompted the reset wants the old sessions
 * gone — and the person signs in afresh with the new password.
 */

const BODY_LIMIT_BYTES = 16_000;

const resetSchema = z.object({
  token: z.string().min(16).max(256),
  password: z.string().min(10).max(128),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "shop-reset-password", 10);
    const { id } = await params;
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = resetSchema.parse(body);

    const store = getShopAdminStore();
    const adminId = await store.consumeResetToken(parsed.token);
    const admin = adminId ? await store.getById(adminId) : null;
    if (!admin || admin.draftId !== id) throw new InvalidShopAdminLinkError();

    await store.updatePassword(admin.id, parsed.password);
    await store.revokeAllSessions(admin.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return safeApiError(error);
  }
}
