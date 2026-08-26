import { NextResponse, type NextRequest } from "next/server";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import {
  clearCustomerSessionCookie,
  CUSTOMER_SESSION_COOKIE,
} from "@/lib/customer-auth";
import { getCustomerAccountStore } from "@/lib/customer-account-store";
import { assertCsrf } from "@/lib/security";

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const token = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
    assertCustomerRateLimit(
      request,
      "customer-logout",
      token ?? "anonymous",
      20,
    );
    if (token) await getCustomerAccountStore().revokeSession(token);
    const response = NextResponse.json({ ok: true });
    clearCustomerSessionCookie(response);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
