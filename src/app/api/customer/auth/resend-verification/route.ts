import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import {
  CUSTOMER_VERIFICATION_TTL_MS,
  getCustomerAccountStore,
} from "@/lib/customer-account-store";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { customerEmailHtml, sendCustomerEmail } from "@/lib/customer-email";
import { assertCsrf } from "@/lib/security";

const resendSchema = z.object({
  email: z.string().trim().email().max(254),
});

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    assertApiRateLimit(request, "customer-resend-verification", 5);
    const body = (await readBoundedJson(
      request as unknown as Request,
      16_000,
    )) as unknown;
    const { email } = resendSchema.parse(body);
    const store = getCustomerAccountStore();
    const account = await store.getByEmail(normalizeCustomerEmail(email));
    let verificationLink: string | undefined;

    if (account && !account.emailVerifiedAt) {
      const token = await store.createToken(
        account.id,
        "verify_email",
        CUSTOMER_VERIFICATION_TTL_MS,
      );
      const link = new URL("/api/customer/auth/verify", request.nextUrl.origin);
      link.searchParams.set("token", token);
      const delivery = await sendCustomerEmail({
        to: account.email,
        name: account.name,
        subject: "Verify your Valmont customer account",
        text: `Verify your Valmont customer account: ${link.toString()}`,
        html: customerEmailHtml(
          "Verify your Valmont account",
          account.name,
          "Here is a fresh link to verify your email address.",
          "Verify email address",
          link.toString(),
        ),
        developmentLink: link.toString(),
      });
      verificationLink = delivery.developmentLink;
    }

    return NextResponse.json({
      ok: true,
      message:
        "If that account needs verification, we have sent a fresh email.",
      ...(verificationLink ? { verificationLink } : {}),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
