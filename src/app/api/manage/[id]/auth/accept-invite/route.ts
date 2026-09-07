import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { InvalidShopAdminLinkError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { setShopSessionCookie } from "@/lib/shop-admin/auth";

/**
 * Accept an invite: the one-time link becomes a name, a password and a
 * signed-in session. The token is burnt before anything else happens, so a
 * second submission of the same link is a plain "invalid or expired" — even
 * when the first one is still in flight.
 */

const BODY_LIMIT_BYTES = 16_000;

const acceptSchema = z.object({
  token: z.string().min(16).max(256),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(128),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "shop-accept-invite", 10);
    const { id } = await params;
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = acceptSchema.parse(body);

    const store = getShopAdminStore();
    const admin = await store.acceptInvite(
      parsed.token,
      parsed.name,
      parsed.password,
    );
    // A token minted for another shop's login is not valid *here*.
    if (!admin || admin.draftId !== id) throw new InvalidShopAdminLinkError();

    const session = await store.createSession(admin.id);
    await store.touchLastLogin(admin.id);
    const response = NextResponse.json({
      ok: true,
      admin: { id: admin.id, name: admin.name, role: admin.role },
    });
    setShopSessionCookie(response, session.token);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
