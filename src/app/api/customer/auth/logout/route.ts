import { NextResponse, type NextRequest } from "next/server";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import {
  clearCustomerSessionCookie,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customer-auth";
import { getCustomerAccountStore } from "@/lib/customer-account-store";
import { assertCsrf } from "@/lib/security";

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "customer-logout", 20);
    const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
    if (token) await getCustomerAccountStore().revokeSession(token);
    const response = NextResponse.json({ ok: true });
    clearCustomerSessionCookie(response);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
