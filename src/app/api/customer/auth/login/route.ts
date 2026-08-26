import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
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

class UnverifiedCustomerEmailError extends Error {
  readonly status = 403;

  constructor() {
    super("Please verify your email address before signing in.");
    this.name = "UnverifiedCustomerEmailError";
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "customer-login", 10);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BODY_LIMIT_BYTES,
    )) as unknown;
    const parsed = loginSchema.parse(body);
    const store = getCustomerAccountStore();
    const account = await store.verifyPassword(
      normalizeCustomerEmail(parsed.email),
      parsed.password,
    );
    if (!account) throw new InvalidCustomerCredentialsError();
    if (!account.emailVerifiedAt) throw new UnverifiedCustomerEmailError();

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
