import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "@/lib/auth-redirect";
import { z } from "zod";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import {
  CUSTOMER_RESET_TTL_MS,
  getCustomerAccountStore,
} from "@/lib/customer-account-store";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import {
  assertCustomerEmailDeliveryReady,
  customerEmailHtml,
  sendCustomerEmail,
} from "@/lib/customer-email";
import { CustomerEmailDeliveryError } from "@/lib/api-errors";

const BODY_LIMIT_BYTES = 16_000;
const forgotSchema = z.object({
  email: z.string().trim().email().max(254),
});

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BODY_LIMIT_BYTES,
    )) as unknown;
    const parsed = forgotSchema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    assertCustomerRateLimit(request, "customer-forgot-password", email, 5);
    // Validate required production configuration BEFORE account lookup so a
    // broken sender fails clearly and consistently with 503 for both known
    // and unknown addresses.
    assertCustomerEmailDeliveryReady();
    const store = getCustomerAccountStore();
    const account = await store.getByEmail(email);

    // Keep the response identical whether the address exists. The local link
    // is intentionally the only development exception and is never returned
    // by a production deployment without a configured provider.
    let developmentLink: string | undefined;
    if (account) {
      const token = await store.createToken(
        account.id,
        "reset_password",
        CUSTOMER_RESET_TTL_MS,
      );
      const resetLink = new URL(
        "/account/reset-password",
        publicOrigin(request.url),
      );
      resetLink.searchParams.set("token", token);
      try {
        const delivery = await sendCustomerEmail({
          to: account.email,
          name: account.name,
          subject: "Reset your Valmont customer password",
          text: `Reset your Valmont customer password: ${resetLink.toString()}`,
          html: customerEmailHtml(
            "Reset your Valmont password",
            account.name,
            "We received a request to reset the password for your customer account.",
            "Choose a new password",
            resetLink.toString(),
          ),
          developmentLink: resetLink.toString(),
        });
        developmentLink = delivery.developmentLink;
      } catch (error) {
        // Suppress only expected typed delivery failures to prevent account
        // enumeration. Configuration failures (503) and programming errors must
        // NOT be swallowed.
        if (error instanceof CustomerEmailDeliveryError) {
          // Remain neutral — still return ok.
        } else {
          throw error;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      message:
        "If an account exists for that email, we have sent password-reset instructions.",
      ...(developmentLink ? { resetLink: developmentLink } : {}),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
