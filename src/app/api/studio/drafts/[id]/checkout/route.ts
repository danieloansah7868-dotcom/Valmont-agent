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
import {
  validateGhanaMobile,
  normalizeGhanaMobile,
} from "@/lib/studio/bundles";

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
  customerPhone: z.string().trim().max(30).optional().or(z.literal("")),
  recipientPhone: z.string().trim().max(30).optional().or(z.literal("")),
  customerEmail: z.string().email().max(254).optional().or(z.literal("")),
  customerAddress: z.string().trim().max(500).optional().or(z.literal("")),
  paymentMethod: z.string().max(30),
  note: z.string().max(500).optional().or(z.literal("")),
});

function accessCode(): string {
  // 32 lowercase hex chars — unguessable, URL-safe, no ambiguous characters.
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

    // The chosen method must be one the shop has switched on.
    if (
      !isPaymentMethodId(payload.paymentMethod) ||
      !payments.methods.includes(payload.paymentMethod)
    ) {
      return NextResponse.json(
        { error: "That payment method is not available for this shop." },
        { status: 400 },
      );
    }

    // Ghana mobile validation for data-bundles sites: 02x/05x only, saved as 0240000001, landline 030 refused
    // Uses single explainer from bundles.ts — no duplicated regexes.
    const isBundleSite = draft.brief.category === "data-bundles";
    let normalizedPhone = (payload.customerPhone ?? "").trim();
    let normalizedRecipient: string | undefined;

    // Bundle shops are online-only: only valmont_pay, no delivery
    if (isBundleSite) {
      if (payload.paymentMethod !== "valmont_pay") {
        return NextResponse.json(
          { error: "This shop accepts only online payments." },
          { status: 400 },
        );
      }
      if (draft.brief.payments.delivery.enabled) {
        return NextResponse.json(
          { error: "Delivery is not available for data bundle shops." },
          { status: 400 },
        );
      }
      const recipientRaw = (payload.recipientPhone ?? "").trim();
      if (!recipientRaw) {
        return NextResponse.json(
          { error: "Recipient phone number is required." },
          { status: 400 },
        );
      }
      const recipientError = validateGhanaMobile(recipientRaw);
      if (recipientError) {
        return NextResponse.json({ error: recipientError }, { status: 400 });
      }
      const normRecipient = normalizeGhanaMobile(recipientRaw);
      normalizedRecipient = normRecipient ?? recipientRaw;
      // customerPhone is the buyer's own contact, optional — falls back to the
      // recipient number. It accepts a number from any country: plenty of
      // bundle buyers are in the diaspora paying for family in Ghana, and they
      // need to be reachable on the number they actually use. Only the
      // recipient is held to the Ghana-mobile rule, because that is the number
      // the bundle is delivered to. A Ghana mobile is still normalised to
      // 0240000001; anything else is stored as typed.
      if (!normalizedPhone) {
        normalizedPhone = normalizedRecipient;
      } else {
        if (normalizedPhone.length < 6) {
          return NextResponse.json(
            { error: "Please enter a phone number with at least 6 digits." },
            { status: 400 },
          );
        }
        const normBuyer = normalizeGhanaMobile(normalizedPhone);
        if (normBuyer) normalizedPhone = normBuyer;
      }
    } else {
      // Non-bundle shops: customerPhone required, and at least 6 characters —
      // the same floor the field has always had. The route schema went
      // optional for bundle shops (where the buyer contact may be blank), so
      // the length floor has to be enforced here or a one-digit number would
      // be accepted for every other shop type.
      if (!normalizedPhone) {
        return NextResponse.json(
          { error: "Phone number is required." },
          { status: 400 },
        );
      }
      if (normalizedPhone.length < 6) {
        return NextResponse.json(
          { error: "Please enter a phone number with at least 6 digits." },
          { status: 400 },
        );
      }
    }

    // Re-price every line from the server-side catalogue. A line whose item is
    // unknown or has no price is rejected — never silently priced at zero.
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
        // Stage 4: data-bundles lines snapshot their delivery metadata into
        // the order so a later catalogue edit can never change what a paid
        // order must deliver. Undefined for every other website type, so
        // nothing about non-bundle orders changes (JSON drops the key).
        bundle: item.bundle,
      });
      pricedLines.push({ price: item.price, quantity: line.quantity });
    }

    const totals = computeTotals(pricedLines, {
      enabled: isBundleSite ? false : payments.delivery.enabled,
      fee: payments.delivery.fee,
      minimumOrder: payments.delivery.minimumOrder,
      freeDeliveryAbove: payments.delivery.freeDeliveryAbove,
    });

    // Enforce the minimum order on the goods subtotal, before delivery.
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

    // A delivery order needs somewhere to deliver to.
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

    // Cash on delivery and manual methods (bank/momo without Valmont Pay) take
    // no online payment now: the customer is sent straight to a confirmation
    // page with instructions.
    const needsOnlinePayment =
      payload.paymentMethod === "valmont_pay" ||
      payload.paymentMethod === "card";

    // Decide the payment rail BEFORE the order row exists. When the merchant
    // has selected Live but the setup is incomplete, the simulator must not
    // quietly take over (its confirmation would be refused by the fail-closed
    // webhook and the order would sit at "pending" forever), so online
    // methods are refused with a clear message instead of creating an orphan.
    const availability = await onlinePaymentAvailability();
    if (needsOnlinePayment && !availability.available) {
      return NextResponse.json(
        { error: ONLINE_PAYMENT_UNAVAILABLE_MESSAGE },
        { status: 409 },
      );
    }
    // Manual and cash orders are real goods for real money regardless of the
    // simulator, so only online orders inherit the test marker.
    const paymentMode = needsOnlinePayment ? availability.mode : "live";

    const code = accessCode();
    const isCod = payload.paymentMethod === "cod";
    // Customer accounts are an owner opt-in per website; when the website has
    // not enabled them, checkout stays purely guest and never reads a session.
    // An account-store outage must never take guest checkout down with it.
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
      recipientPhone: normalizedRecipient,
      customerEmail: orderCustomerEmail,
      customerAddress: payload.customerAddress || undefined,
      customerAccountId,
      paymentMethod: payload.paymentMethod,
      paymentMode,
      merchantNote: payload.note || undefined,
    });

    // Absolute links (merchant alert, Valmont Pay callback) must use the
    // deployment's public origin, never the bind address or Host header.
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
