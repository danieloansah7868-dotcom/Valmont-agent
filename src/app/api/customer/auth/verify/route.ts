import { NextResponse, type NextRequest } from "next/server";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { getCustomerAccountStore } from "@/lib/customer-account-store";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { getOrdersStore } from "@/lib/studio/orders";
import { customerAccountsEnabled } from "@/lib/studio/site-brief/schema";

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get("token")?.trim();
    const loginUrl = new URL("/account/login", request.nextUrl.origin);
    if (!token || token.length > 200) {
      loginUrl.searchParams.set("verified", "invalid");
      return NextResponse.redirect(loginUrl);
    }
    assertCustomerRateLimit(request, "customer-verify", token, 20);

    const store = getCustomerAccountStore();
    const consumed = await store.consumeToken(token, "verify_email");
    if (!consumed) {
      loginUrl.searchParams.set("verified", "invalid");
      return NextResponse.redirect(loginUrl);
    }

    await store.verifyEmail(consumed.accountId);

    // Registration only records a checkout claim in the verification token. The
    // order is linked after the customer proves control of the email address;
    // an unverified account can never reserve somebody else's guest order.
    if (consumed.context) {
      const account = await store.getById(consumed.accountId);
      const order = await getOrdersStore().getByAccessCode(consumed.context);
      const draft = order ? await publicGetDraft(order.draftId) : null;
      if (
        account &&
        order &&
        draft &&
        customerAccountsEnabled(draft.brief) &&
        !order.customerAccountId &&
        order.customerEmail &&
        normalizeCustomerEmail(order.customerEmail) ===
          normalizeCustomerEmail(account.email)
      ) {
        await getOrdersStore().claimForCustomer(account.id, consumed.context);
      }
    }

    loginUrl.searchParams.set("verified", "success");
    return NextResponse.redirect(loginUrl);
  } catch (error) {
    return safeApiError(error);
  }
}
