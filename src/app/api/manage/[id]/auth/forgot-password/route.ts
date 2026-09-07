import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { CustomerEmailDeliveryError } from "@/lib/api-errors";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { getShopAdminStore } from "@/lib/shop-admin/store";
import { shopResetLink } from "@/lib/shop-admin/auth";
import { deliverShopAdminLink } from "@/lib/shop-admin/email";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { publicGetDraft } from "@/lib/studio/draft-public";

/**
 * Forgot password. Always answers 200 with the same sentence, whether or not
 * the email belongs to a login on this shop, so the endpoint cannot be used
 * to enumerate staff. When email is not configured the reset link is *not*
 * returned here — an anonymous caller must never receive a one-time link.
 * The shop owner asks the agency for a link from Studio in that case.
 */

const BODY_LIMIT_BYTES = 16_000;
const NEUTRAL_MESSAGE = "If that email exists, we sent a link.";
const RATE_LIMIT_PER_HOUR = 5;

const forgotSchema = z.object({
  email: z.string().trim().email().max(254),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCsrf(request);
    const { id } = await params;
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = forgotSchema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    // 5 per email per hour, plus the usual per-network ceiling.
    assertHourlyRateLimit("shop-forgot-password", email, RATE_LIMIT_PER_HOUR);
    assertApiRateLimit(request, "shop-forgot-password-ip", 30);

    const draft = await publicGetDraft(id);
    const store = getShopAdminStore();
    const admin = draft ? await store.getByEmail(id, email) : null;
    if (draft && admin && admin.status === "active") {
      const issued = await store.createResetToken(admin.id);
      try {
        await deliverShopAdminLink({
          kind: "reset",
          to: admin.email,
          name: admin.name,
          shopName: draft.brief.businessName,
          link: shopResetLink(request.url, id, issued.token),
        });
      } catch (error) {
        // A provider outage must not reveal that the address exists.
        if (!(error instanceof CustomerEmailDeliveryError)) throw error;
      }
    }
    return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE });
  } catch (error) {
    return safeApiError(error);
  }
}
