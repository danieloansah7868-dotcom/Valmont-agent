import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { getOrdersStore } from "@/lib/studio/orders";
import { verifyWebhookSignature } from "@/lib/studio/valmont-pay";

const WEBHOOK_BODY_LIMIT_BYTES = 50_000;

const webhookSchema = z.object({
  // "success" marks the order paid; anything else marks it failed. The local
  // simulator sends exactly these two.
  event: z.enum(["payment.success", "payment.failed"]).optional(),
  status: z.enum(["success", "failed", "paid"]).optional(),
  reference: z.string().max(200).optional(),
});

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

    const raw = await request.text();
    if (raw.length > WEBHOOK_BODY_LIMIT_BYTES) {
      return NextResponse.json({ error: "Body too large" }, { status: 413 });
    }
    if (
      !(await verifyWebhookSignature(raw, {
        valmont: request.headers.get("x-valmont-signature"),
        paystack: request.headers.get("x-paystack-signature"),
      }))
    ) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const body = raw ? (JSON.parse(raw) as unknown) : {};
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

    return NextResponse.json({ ok: true, status: order?.status });
  } catch (e) {
    return safeApiError(e);
  }
}
