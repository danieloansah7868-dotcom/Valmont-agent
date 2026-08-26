import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { getCustomerAccountStore } from "@/lib/customer-account-store";

const BODY_LIMIT_BYTES = 16_000;
const resetSchema = z.object({
  token: z.string().trim().min(32).max(200),
  password: z.string().min(10).max(128),
});

class InvalidPasswordResetError extends Error {
  readonly status = 400;

  constructor() {
    super("This password-reset link is invalid or has expired.");
    this.name = "InvalidPasswordResetError";
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "customer-reset-password", 5);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BODY_LIMIT_BYTES,
    )) as unknown;
    const parsed = resetSchema.parse(body);
    const store = getCustomerAccountStore();
    const consumed = await store.consumeToken(parsed.token, "reset_password");
    if (!consumed) throw new InvalidPasswordResetError();
    await store.updatePassword(consumed.accountId, parsed.password);
    await store.revokeAllSessions(consumed.accountId);
    return NextResponse.json({
      ok: true,
      message: "Your password has been updated. You can now sign in.",
    });
  } catch (error) {
    return safeApiError(error);
  }
}
