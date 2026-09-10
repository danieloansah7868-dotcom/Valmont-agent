import { NextResponse, type NextRequest } from "next/server";
import { safeApiError } from "@/lib/api";
import { assertCsrf } from "@/lib/security";
import { getShopAgentStore } from "@/lib/shop-agent/store";
import {
  clearShopAgentSessionCookie,
  SHOP_AGENT_SESSION_COOKIE,
} from "@/lib/shop-agent/auth";
import { requireGatedShopDraft } from "@/lib/shop-agent/route-helpers";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    await requireGatedShopDraft(id);
    const token = request.cookies.get(SHOP_AGENT_SESSION_COOKIE)?.value;
    if (token) await getShopAgentStore().revokeSession(token);
    const response = NextResponse.json({ ok: true });
    clearShopAgentSessionCookie(response);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
