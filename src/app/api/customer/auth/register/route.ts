import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
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
import { publicGetDraft } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import { customerAccountsEnabled } from "@/lib/studio/site-brief/schema";

const BODY_LIMIT_BYTES = 16_000;

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  claimAccessCode: z.string().trim().max(128).optional().or(z.literal("")),
});

class InvalidOrderClaimError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderClaimError";
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCsrf(request);
    const body = (await readBoundedJson(
      request as unknown as Request,
      BODY_LIMIT_BYTES,
    )) as unknown;
    const parsed = registerSchema.parse(body);
    const email = normalizeCustomerEmail(parsed.email);
    assertCustomerRateLimit(request, "customer-register", email, 5);
    assertCustomerEmailDeliveryReady();
    const claimAccessCode = parsed.claimAccessCode || undefined;
    const orders = getOrdersStore();

    // Validate the claim before creating the account. An order can be claimed
    // only once, and checkout must have captured an email that matches exactly.
    if (claimAccessCode) {
      const order = await orders.getByAccessCode(claimAccessCode);
      if (!order)
        throw new InvalidOrderClaimError("That order link is invalid.");
      const draft = await publicGetDraft(order.draftId);
      if (!draft || !customerAccountsEnabled(draft.brief)) {
        throw new InvalidOrderClaimError(
          "This website does not offer customer accounts.",
        );
      }
      if (order.customerAccountId) {
        throw new InvalidOrderClaimError(
          "That order has already been linked to an account.",
        );
      }
      if (!order.customerEmail) {
        throw new InvalidOrderClaimError(
          "This guest order has no email address to verify, so it cannot be linked to an account.",
        );
      }
      if (normalizeCustomerEmail(order.customerEmail) !== email) {
        throw new InvalidOrderClaimError(
          "Use the email address entered at checkout to link this order.",
        );
      }
    }

    const store = getCustomerAccountStore();
    if (await store.getByEmail(email)) {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 409 },
      );
    }

    const account = await store.createAccount({
      email,
      name: parsed.name,
      password: parsed.password,
    });

    const token = await store.createToken(
      account.id,
      "verify_email",
      CUSTOMER_VERIFICATION_TTL_MS,
      claimAccessCode,
    );
    const verificationLink = new URL(
      "/api/customer/auth/verify",
      request.nextUrl.origin,
    );
    verificationLink.searchParams.set("token", token);
    const delivery = await sendCustomerEmail({
      to: account.email,
      name: account.name,
      subject: "Verify your Valmont customer account",
      text: `Verify your Valmont customer account: ${verificationLink.toString()}`,
      html: customerEmailHtml(
        "Verify your Valmont account",
        account.name,
        "Please verify your email address to finish setting up your customer account.",
        "Verify email address",
        verificationLink.toString(),
      ),
      developmentLink: verificationLink.toString(),
    });

    return NextResponse.json(
      {
        ok: true,
        message:
          "Your account is ready. Check your email to verify the address before signing in.",
        ...(delivery.developmentLink
          ? { verificationLink: delivery.developmentLink }
          : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    return safeApiError(error);
  }
}
