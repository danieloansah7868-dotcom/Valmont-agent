import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "@/lib/auth-redirect";
import { z } from "zod";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import {
  CUSTOMER_VERIFICATION_TTL_MS,
  getCustomerAccountStore,
} from "@/lib/customer-account-store";
import {
  hashCustomerPassword,
  normalizeCustomerEmail,
} from "@/lib/customer-password";
import {
  assertCustomerEmailDeliveryReady,
  customerEmailHtml,
  sendCustomerEmail,
} from "@/lib/customer-email";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import { customerAccountsEnabled } from "@/lib/studio/site-brief/schema";
import {
  CustomerAccountExistsError,
  CustomerEmailDeliveryError,
  InvalidOrderClaimError,
} from "@/lib/api-errors";

const BODY_LIMIT_BYTES = 16_000;

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  claimAccessCode: z.string().trim().max(128).optional().or(z.literal("")),
});

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
    const origin = publicOrigin(request.url);

    // Registration must not reveal whether an address already has an account.
    // An existing address gets the SAME response as a new one; the difference
    // happens only in the inbox, which only the address owner can read: an
    // unverified account receives a fresh verification link, a verified one a
    // note that someone tried to sign up with it. A creation race (two
    // registrations at once) lands in the same branch via the unique index.
    let account = null;
    const existing = await store.getByEmail(email);
    if (!existing) {
      try {
        account = await store.createAccount({
          email,
          name: parsed.name,
          password: parsed.password,
        });
      } catch (error) {
        if (!(error instanceof CustomerAccountExistsError)) throw error;
      }
    }
    if (!account) {
      // Creating an account costs one scrypt hash; spend the same work here so
      // the response time cannot distinguish the two branches either.
      await hashCustomerPassword(parsed.password);
      await notifyExistingAccount(store, email, origin);
      return NextResponse.json(
        { ok: true, message: REGISTRATION_MESSAGE },
        { status: 201 },
      );
    }

    const token = await store.createToken(
      account.id,
      "verify_email",
      CUSTOMER_VERIFICATION_TTL_MS,
      claimAccessCode,
    );
    const verificationLink = new URL("/api/customer/auth/verify", origin);
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
        message: REGISTRATION_MESSAGE,
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

/** One message for every outcome, so the response cannot be used to enumerate. */
const REGISTRATION_MESSAGE =
  "Check your email to finish setting up your account. If you already had one, we have sent instructions for signing in instead.";

/**
 * Tells the real owner of an already-registered address what happened. Only
 * transport failures are swallowed — a broken sender must still stay neutral
 * — while configuration errors (503) propagate exactly as they would for a
 * brand-new address, so the two branches remain indistinguishable.
 */
async function notifyExistingAccount(
  store: ReturnType<typeof getCustomerAccountStore>,
  email: string,
  origin: string,
): Promise<void> {
  const account = await store.getByEmail(email);
  if (!account) return;
  try {
    if (!account.emailVerifiedAt) {
      const token = await store.createToken(
        account.id,
        "verify_email",
        CUSTOMER_VERIFICATION_TTL_MS,
      );
      const link = new URL("/api/customer/auth/verify", origin);
      link.searchParams.set("token", token);
      await sendCustomerEmail({
        to: account.email,
        name: account.name,
        subject: "Verify your Valmont customer account",
        text: `Verify your Valmont customer account: ${link.toString()}`,
        html: customerEmailHtml(
          "Verify your Valmont account",
          account.name,
          "Someone — probably you — tried to create an account with this address. It already exists but has not been verified yet, so here is a fresh verification link.",
          "Verify email address",
          link.toString(),
        ),
        developmentLink: link.toString(),
      });
      return;
    }
    const login = new URL("/account/login", origin);
    const reset = new URL("/account/forgot-password", origin);
    await sendCustomerEmail({
      to: account.email,
      name: account.name,
      subject: "You already have a Valmont customer account",
      text: [
        "Someone tried to create a Valmont customer account with this email address, but you already have one.",
        `Sign in: ${login.toString()}`,
        `Forgot your password? ${reset.toString()}`,
        "If this was not you, no action is needed — nothing about your account has changed.",
      ].join("\n"),
      html: customerEmailHtml(
        "You already have an account",
        account.name,
        "Someone tried to create a Valmont customer account with this email address, but you already have one. If it was you, simply sign in; if you have forgotten your password, use the reset link on the sign-in page. If this was not you, nothing about your account has changed.",
        "Sign in",
        login.toString(),
      ),
      developmentLink: login.toString(),
    });
  } catch (error) {
    if (!(error instanceof CustomerEmailDeliveryError)) throw error;
  }
}
