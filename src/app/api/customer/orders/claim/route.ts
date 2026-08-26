import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertCustomerRateLimit, safeApiError } from "@/lib/api";
import { readBoundedJson } from "@/lib/bounded-json";
import { requireCustomerSession } from "@/lib/customer-auth";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { assertCsrf } from "@/lib/security";
import { getOrdersStore } from "@/lib/studio/orders";

const claimSchema = z.object({
  accessCode: z.string().trim().min(16).max(128),
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
    const session = await requireCustomerSession();
    assertCustomerRateLimit(
      request,
      "customer-order-claim",
      session.account.id,
      10,
    );
    const body = (await readBoundedJson(
      request as unknown as Request,
      8_000,
    )) as unknown;
    const { accessCode } = claimSchema.parse(body);
    const orders = getOrdersStore();
    const order = await orders.getByAccessCode(accessCode);
    if (!order) throw new InvalidOrderClaimError("That order link is invalid.");
    if (!order.customerEmail) {
      throw new InvalidOrderClaimError(
        "This guest order has no email address to verify, so it cannot be linked to an account.",
      );
    }
    if (
      normalizeCustomerEmail(order.customerEmail) !==
      normalizeCustomerEmail(session.account.email)
    ) {
      throw new InvalidOrderClaimError(
        "This order was checked out with a different email address.",
      );
    }
    if (
      order.customerAccountId &&
      order.customerAccountId !== session.account.id
    ) {
      throw new InvalidOrderClaimError(
        "That order has already been linked to another account.",
      );
    }
    const claimed = await orders.claimForCustomer(
      session.account.id,
      accessCode,
    );
    if (!claimed) {
      throw new InvalidOrderClaimError("That order could not be linked.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return safeApiError(error);
  }
}
