import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import {
  safeCustomerReturnPath,
  setCustomerSessionCookie,
} from "@/lib/customer-auth";
import { getCustomerAccountStore } from "@/lib/customer-account-store";
import { normalizeCustomerEmail } from "@/lib/customer-password";

const BODY_LIMIT_BYTES = 16_000;
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  next: z.string().max(500).optional(),
});

class InvalidCustomerCredentialsError extends Error {
  readonly status = 401;

  constructor() {
    super("The email or password is incorrect.");
    this.name = "InvalidCustomerCredentialsError";
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BODY_LIMIT_BYTES,
    )) as unknown;
    const parsed = loginSchema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    assertCustomerRateLimit(request, "customer-login", email, 10);
    const store = getCustomerAccountStore();
    const account = await store.verifyPassword(email, parsed.password);
    if (!account || !account.emailVerifiedAt) {
      // Keep both unknown and unverified accounts on the same response path.
      throw new InvalidCustomerCredentialsError();
    }

    const session = await store.createSession(account.id);
    const response = NextResponse.json({
      ok: true,
      next: safeCustomerReturnPath(parsed.next),
    });
    setCustomerSessionCookie(response, session.token);
    return response;
  } catch (error) {
    return safeApiError(error);
  }
}
