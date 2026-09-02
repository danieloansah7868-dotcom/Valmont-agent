import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "@/lib/auth-redirect";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedText } from "@/lib/bounded-json";
import { getOrdersStore } from "@/lib/studio/orders";
import { verifyWebhookSignature } from "@/lib/studio/valmont-pay";
import { notifyCustomerOrderStatus } from "@/lib/customer-order-notifications";

const WEBHOOK_BODY_LIMIT_BYTES = 50_000;

const webhookSchema = z
  .object({
    // "success" marks the order paid; "failed" marks it failed. The local
    // simulator sends exactly these two, while Valmont Pay may send the event
    // form. A body with neither outcome must never silently mark an order
    // failed.
    event: z.enum(["payment.success", "payment.failed"]).optional(),
    status: z.enum(["success", "failed", "paid"]).optional(),
    reference: z.string().max(200).optional(),
  })
  .refine(
    (value) => value.event !== undefined || value.status !== undefined,
    "Webhook body is missing a payment outcome",
  );

/**
 * Payment confirmation webhook. Valmont Pay (or, in test mode, the local
 * simulator) calls this when a payment settles or fails. The order is
 * identified by the unguessable `access_code` query parameter, which acts as
 * the shared secret for the callback. In live mode the request signature is
 * also verified.
 */
export async function POST(request: NextRequest) {
  try {
    const accessCode = request.nextUrl.searchParams.get("access_code");
    if (!accessCode) {
      return NextResponse.json(
        { error: "Missing access code" },
        { status: 400 },
      );
    }

    // Streamed with a byte ceiling: an oversized body is cut off as it
    // arrives instead of being buffered whole and measured afterwards. The
    // exact raw bytes are kept because the HMAC check below covers them.
    const raw = await readBoundedText(
      request as unknown as Request,
      WEBHOOK_BODY_LIMIT_BYTES,
    );
    if (
      !(await verifyWebhookSignature(raw, {
        valmont: request.headers.get("x-valmont-signature"),
        paystack: request.headers.get("x-paystack-signature"),
      }))
    ) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
    }
    const parsed = webhookSchema.parse(body);

    const store = getOrdersStore();
    const existing = await store.getByAccessCode(accessCode);
    if (!existing) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const succeeded =
      parsed.event === "payment.success" ||
      parsed.status === "success" ||
      parsed.status === "paid";

    const order = succeeded
      ? await store.markPaid(accessCode, parsed.reference)
      : await store.markFailed(accessCode);

    if (order && existing.status !== order.status) {
      await notifyCustomerOrderStatus({
        order,
        origin: publicOrigin(request.url),
      }).catch(() => "failed");
    }

    return NextResponse.json({ ok: true, status: order?.status });
  } catch (e) {
    return safeApiError(e);
  }
}
