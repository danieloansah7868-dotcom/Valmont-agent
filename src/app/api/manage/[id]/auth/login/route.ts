import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  assertApiRateLimit,
  assertCustomerRateLimit,
  safeApiError,
} from "@/lib/api";
import { InvalidShopAdminCredentialsError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import {
  safeShopReturnPath,
  setShopSessionCookie,
} from "@/lib/shop-admin/auth";
import { publicGetDraftOwnerId } from "@/lib/studio/draft-public";

/**
 * Shop admin sign-in (Stage 6b).
 *
 * Every negative — unknown shop, unknown email, wrong password, invite not yet
 * accepted, disabled login — is the same 401 with the same words, and every
 * one of them costs the same scrypt derivation (`verifyPassword` compares
 * against a dummy hash when there is nothing real to compare against). The
 * only thing the response reveals is that *this* combination did not work.
 */

const BODY_LIMIT_BYTES = 16_000;

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  next: z.string().max(512).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = loginSchema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    assertCustomerRateLimit(request, "shop-login", email, 10);
    assertApiRateLimit(request, "shop-login-ip", 30);

    const store = getShopAdminStore();
    // The shop must exist, but an unknown id must not short-circuit the
    // password work — otherwise timing would reveal which ids are real.
    const shopExists = (await publicGetDraftOwnerId(id)) !== null;
    const admin = await store.verifyPassword(id, email, parsed.password);
    if (!shopExists || !admin) throw new InvalidShopAdminCredentialsError();

    const session = await store.createSession(admin.id);
    await store.touchLastLogin(admin.id);
    const response = NextResponse.json({
      ok: true,
      admin: { id: admin.id, name: admin.name, role: admin.role },
      next: safeShopReturnPath(id, parsed.next),
    });
    setShopSessionCookie(response, session.token);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
