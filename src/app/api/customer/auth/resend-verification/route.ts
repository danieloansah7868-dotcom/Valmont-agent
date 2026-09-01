import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import {
  CUSTOMER_VERIFICATION_TTL_MS,
  getCustomerAccountStore,
} from "@/lib/customer-account-store";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import {
  assertCustomerEmailDeliveryReady,
  customerEmailHtml,
  sendCustomerEmail,
} from "@/lib/customer-email";
import { assertCsrf } from "@/lib/security";
import { CustomerEmailDeliveryError } from "@/lib/api-errors";

const resendSchema = z.object({
  email: z.string().trim().email().max(254),
});

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const body = (await readBoundedJson(
      request as unknown as Request,
      16_000,
    )) as unknown;
    const { email: submittedEmail } = resendSchema.parse(body);
    const email = normalizeCustomerEmail(submittedEmail);
    assertCustomerRateLimit(request, "customer-resend-verification", email, 5);
    // Validate production config before lookup for consistent 503 on broken sender.
    assertCustomerEmailDeliveryReady();
    const store = getCustomerAccountStore();
    const account = await store.getByEmail(email);
    let verificationLink: string | undefined;

    if (account && !account.emailVerifiedAt) {
      const token = await store.createToken(
        account.id,
        "verify_email",
        CUSTOMER_VERIFICATION_TTL_MS,
      );
      const link = new URL("/api/customer/auth/verify", request.nextUrl.origin);
      link.searchParams.set("token", token);
      try {
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
      } catch (error) {
        if (error instanceof CustomerEmailDeliveryError) {
          // Suppress only delivery failures for anti-enumeration.
        } else {
          throw error;
        }
      }
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
