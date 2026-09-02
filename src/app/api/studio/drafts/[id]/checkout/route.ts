import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "@/lib/auth-redirect";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { assertApiRateLimit, safeApiError } from "@/lib/api";
import { assertSameOrigin } from "@/lib/security";
import { readBoundedJson } from "@/lib/bounded-json";
import { getCustomerSession } from "@/lib/customer-auth";
import { normalizeCustomerEmail } from "@/lib/customer-password";
import { internalGetDraftForCheckout } from "@/lib/studio/draft-public";
import { getOrdersStore, type OrderLine } from "@/lib/studio/orders";
import {
  computeTotals,
  createPaymentLink,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
  onlinePaymentAvailability,
  type PricedLine,
} from "@/lib/studio/valmont-pay";
import {
  customerAccountsEnabled,
  isPaymentMethodId,
} from "@/lib/studio/site-brief/schema";
import { notifyMerchantNewOrder } from "@/lib/studio/notifications";
import { isValidGhanaMobile, normalizeGhanaMobile } from "@/lib/studio/bundles";

const CHECKOUT_BODY_LIMIT_BYTES = 100_000;

/**
 * The checkout payload the browser sends. Deliberately minimal: the customer
 * chooses items and a quantity, but never a price. Every amount is recomputed
 * on the server from the stored catalogue so a tampered request cannot change
 * what is charged.
 */
const checkoutSchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().max(64),
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .min(1, "Your basket is empty.")
    .max(100),
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().min(6).max(30),
  customerEmail: z.string().email().max(254).optional().or(z.literal("")),
  customerAddress: z.string().trim().max(500).optional().or(z.literal("")),
  paymentMethod: z.string().max(30),
  note: z.string().max(500).optional().or(z.literal("")),
});

function accessCode(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Public checkout remains guest-accessible. On websites whose owner enabled
 * customer accounts, a verified customer session is attached automatically
 * when the checkout email is blank or matches the account; a mismatched email
 * stays a guest order. Websites without the feature never attach a session. Security rests on (1) the
 * draft id being an unguessable UUID, (2) a same-origin check, (3) the server
 * re-pricing the basket against the stored catalogue, and (4) an unguessable
 * per-order access code guarding the payment page and webhook.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    assertApiRateLimit(request, "studio-checkout", 20);

    const { id } = await params;
    const body = (await readBoundedJson(
      request as unknown as Request,
      CHECKOUT_BODY_LIMIT_BYTES,
    )) as Record<string, unknown>;
    const payload = checkoutSchema.parse(body);

    const draft = await internalGetDraftForCheckout(id);
    if (!draft) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const payments = draft.brief.payments;
    if (!payments.enabled) {
      return NextResponse.json(
        { error: "This shop is not accepting orders yet." },
        { status: 409 },
      );
    }

    if (
      !isPaymentMethodId(payload.paymentMethod) ||
      !payments.methods.includes(payload.paymentMethod)
    ) {
      return NextResponse.json(
        { error: "That payment method is not available for this shop." },
        { status: 400 },
      );
    }

    // Ghana mobile validation for data-bundles sites: 02x/05x only, saved as 0240000001, landline 030 refuses
    const isBundleSite = draft.brief.category === "data-bundles";
    let normalizedPhone = payload.customerPhone.trim();
    if (isBundleSite) {
      if (!isValidGhanaMobile(payload.customerPhone)) {
        const cleaned = payload.customerPhone.replace(/[\s\-()]/g, "");
        const isLandline =
          /^(?:\+?233|0)3\d{8}$/.test(cleaned) ||
          /^(?:\+?233|0)3\d{7}$/.test(cleaned);
        if (isLandline) {
          return NextResponse.json(
            {
              error:
                "Landline numbers (030) are not supported. Please use a Ghana mobile number starting with 02x or 05x.",
            },
            { status: 400 },
          );
        }
        return NextResponse.json(
          {
            error:
              "Please enter a Ghana mobile number starting with 02x or 05x, e.g. 0240000001",
          },
          { status: 400 },
        );
      }
      const norm = normalizeGhanaMobile(payload.customerPhone);
      if (norm) normalizedPhone = norm;
    }

    const catalogue = new Map(draft.brief.items.map((item) => [item.id, item]));
    const lines: OrderLine[] = [];
    const pricedLines: PricedLine[] = [];
    for (const line of payload.lines) {
      const item = catalogue.get(line.itemId);
      if (!item || item.price === undefined) {
        return NextResponse.json(
          { error: "One of the items in your basket is no longer available." },
          { status: 409 },
        );
      }
      lines.push({
        itemId: item.id,
        name: item.name,
        price: item.price,
        quantity: line.quantity,
        image: item.image,
      });
      pricedLines.push({ price: item.price, quantity: line.quantity });
    }

    const totals = computeTotals(pricedLines, {
      enabled: isBundleSite ? false : payments.delivery.enabled,
      fee: payments.delivery.fee,
      minimumOrder: payments.delivery.minimumOrder,
      freeDeliveryAbove: payments.delivery.freeDeliveryAbove,
    });

    if (
      !isBundleSite &&
      payments.delivery.minimumOrder > 0 &&
      totals.subtotal < payments.delivery.minimumOrder
    ) {
      return NextResponse.json(
        {
          error: `The minimum order for this shop is ${payments.delivery.minimumOrder} ${draft.brief.currency}.`,
        },
        { status: 400 },
      );
    }

    if (
      !isBundleSite &&
      payments.delivery.enabled &&
      (!payload.customerAddress || payload.customerAddress.trim() === "")
    ) {
      return NextResponse.json(
        { error: "Please add a delivery address." },
        { status: 400 },
      );
    }

    const needsOnlinePayment =
      payload.paymentMethod === "valmont_pay" ||
      payload.paymentMethod === "card";

    const availability = await onlinePaymentAvailability();
    if (needsOnlinePayment && !availability.available) {
      return NextResponse.json(
        { error: ONLINE_PAYMENT_UNAVAILABLE_MESSAGE },
        { status: 409 },
      );
    }
    const paymentMode = needsOnlinePayment ? availability.mode : "live";

    const code = accessCode();
    const isCod = payload.paymentMethod === "cod";
    const accountsEnabled = customerAccountsEnabled(draft.brief);
    const customerSession = accountsEnabled
      ? await getCustomerSession().catch(() => null)
      : null;
    const customerAccountId =
      customerSession &&
      (!payload.customerEmail ||
        normalizeCustomerEmail(payload.customerEmail) ===
          normalizeCustomerEmail(customerSession.account.email))
        ? customerSession.account.id
        : undefined;
    const orderCustomerEmail = customerAccountId
      ? customerSession?.account.email
      : payload.customerEmail || undefined;

    const order = await getOrdersStore().create({
      ownerId: draft.ownerId,
      draftId: draft.id,
      accessCode: code,
      status: isCod ? "cod_pending" : "pending",
      currency: draft.brief.currency,
      subtotal: totals.subtotal,
      deliveryFee: totals.deliveryFee,
      total: totals.total,
      lines,
      customerName: payload.customerName,
      customerPhone: normalizedPhone,
      customerEmail: orderCustomerEmail,
      customerAddress: payload.customerAddress || undefined,
      customerAccountId,
      paymentMethod: payload.paymentMethod,
      paymentMode,
      merchantNote: payload.note || undefined,
    });

    const origin = publicOrigin(request.url);

    void notifyMerchantNewOrder({
      order,
      brief: draft.brief,
      origin,
    }).catch(() => {
      /* Never fail checkout because a notification did not send. */
    });

    if (!needsOnlinePayment) {
      return NextResponse.json({
        orderId: order.id,
        accessCode: code,
        paymentLink: null,
        status: order.status,
      });
    }

    const payment = await createPaymentLink({
      accessCode: code,
      amount: totals.total,
      currency: draft.brief.currency,
      reference: order.id,
      description: `${draft.brief.businessName} order`,
      customerName: payload.customerName,
      customerEmail: orderCustomerEmail,
      customerPhone: normalizedPhone,
      callbackUrl: `${origin}/api/payments/webhook?access_code=${code}`,
    });

    return NextResponse.json({
      orderId: order.id,
      accessCode: code,
      paymentLink: payment.paymentLink,
      live: payment.live,
      status: order.status,
    });
  } catch (e) {
    return safeApiError(e);
  }
}
