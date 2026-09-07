import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { assertCsrf } from "@/lib/security";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import {
  clearShopSessionCookie,
  SHOP_SESSION_COOKIE,
} from "@/lib/shop-admin/auth";

/**
 * Shop admin sign-out. Revokes the server-side session (so the cookie value
 * is dead even if a copy survives somewhere) and clears the cookie. Always
 * succeeds: signing out with no session is not an error.
 */
export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const token = request.cookies.get(SHOP_SESSION_COOKIE)?.value;
    if (token) await getShopAdminStore().revokeSession(token);
    const response = NextResponse.json({ ok: true });
    clearShopSessionCookie(response);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
