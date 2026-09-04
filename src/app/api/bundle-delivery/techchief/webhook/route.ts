import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import { readBoundedText } from "@/lib/bounded-json";
import {
  consumeTechChiefBudget,
  getIntegrationById,
  getIntegrationsStore,
} from "@/lib/studio/integrations";
import {
  getBundleDeliveriesStore,
  type BundleDeliveryRecord,
} from "@/lib/studio/bundle-delivery";
import { getOrdersStore } from "@/lib/studio/orders";
import { publicGetDraft } from "@/lib/studio/draft-public";
import {
  notifyMerchantDeliveryFailed,
  type MerchantDeliveryFailureInput,
} from "@/lib/studio/notifications";
import {
  getTechChiefStatus,
  type TechChiefOrderStatus,
} from "@/lib/studio/techchief";

/** TechChief's webhook payloads are tiny; anything bigger is not theirs. */
const WEBHOOK_BODY_LIMIT_BYTES = 20_000;

/**
 * How long the unsigned path may spend confirming with TechChief before we
 * answer anyway. TechChief requires a 2xx within 8 seconds and retries at 5,
 * 30 and 120 minutes, so a slow confirmation is abandoned rather than allowed
 * to time the callback out — the retry, and the shop's own status polling,
 * pick the delivery up.
 */
const UNSIGNED_CONFIRM_DEADLINE_MS = 6_000;

/** Signature header TechChief signs the raw body with (HMAC-SHA256, hex). */
const SIGNATURE_HEADER = "x-techchiefx-signature";

const webhookSchema = z.object({
  /** Their event label. Informational: `status` is what we act on. */
  event: z.string().max(100).optional(),
  /** The reference our own order call returned — the only key we look up by. */
  order_ref: z.string().min(1).max(200),
  status: z
    .enum(["accepted", "processing", "delivered", "failed", "refunded"])
    .optional(),
  network: z.string().max(40).optional(),
  size_gb: z.number().optional(),
  recipient: z.string().max(40).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

function timingSafeHexEqual(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  // Lengths leak through timing either way; only equal-length buffers are
  // compared, and an unequal length fails closed.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** hex HMAC-SHA256 of the raw body under the account's webhook secret. */
export function techChiefWebhookSignature(
  rawBody: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Races work against a deadline so the 8-second answer is never at risk. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * TechChief delivery callback (Stage 5).
 *
 * `POST /api/bundle-delivery/techchief/webhook?integration=<uuid>` — no
 * session, because the caller is TechChief. The connection id in the query
 * string says which shop's key and secret to use; it is not a secret itself
 * (it grants nothing without the signature, and every row it can reach is
 * checked against that connection's own draft).
 *
 * Trust is graded, and the grading is the whole design:
 *
 *  - **With a webhook secret** the payload is authenticated: the hex
 *    HMAC-SHA256 of the RAW body is compared in constant time, a mismatch is a
 *    401 with no side effect, and a match is allowed to change the row
 *    directly. No external call is made on this path, so the answer always
 *    lands well inside TechChief's 8 seconds.
 *  - **Without a secret** the payload is treated as a rumour. We answer 200
 *    and change nothing until `dev_status.php` — an authenticated call with
 *    the shop's own key — confirms the same outcome. That confirmation costs
 *    one slot of the shop's hourly budget and is abandoned at
 *    {@link UNSIGNED_CONFIRM_DEADLINE_MS} rather than risk the callback
 *    window.
 *
 * Whichever path runs, the row rules are the engine's: `delivered` is terminal
 * (I3 — a later "failed" event cannot undo a delivered top-up), only a row
 * that was not already failed produces a merchant alert, unknown references
 * are ignored with a 200 so a replay or a stray call is a no-op, and a
 * reference belonging to another shop's order is ignored too.
 */
export async function POST(request: NextRequest) {
  try {
    const integrationId = request.nextUrl.searchParams.get("integration");
    if (!integrationId) {
      return NextResponse.json(
        { error: "Missing integration" },
        { status: 400 },
      );
    }

    const integration = await getIntegrationById(integrationId);
    if (!integration) {
      // An unknown connection is answered like a known-but-unmatched one: a
      // 200 that changes nothing, so this endpoint cannot be used to probe
      // which ids exist.
      return NextResponse.json({ ok: true, ignored: true });
    }

    const raw = await readBoundedText(
      request as unknown as Request,
      WEBHOOK_BODY_LIMIT_BYTES,
    );

    const authenticated = Boolean(integration.webhookSecret);
    if (integration.webhookSecret) {
      const presented = request.headers.get(SIGNATURE_HEADER)?.trim() ?? "";
      const expected = techChiefWebhookSignature(
        raw,
        integration.webhookSecret,
      );
      if (!presented || !timingSafeHexEqual(presented, expected)) {
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 401 },
        );
      }
    }

    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const parsed = webhookSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const deliveries = getBundleDeliveriesStore();
    const orders = getOrdersStore();

    // Lookup is by OUR row's provider reference, never by the recipient or
    // size in the payload, and the row's order must belong to this
    // connection's own website.
    const candidates = await deliveries.listByProviderRef(
      parsed.data.order_ref,
    );
    const row = await findOwnRow(candidates, integration.draftId, orders);
    if (!row) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    let status = parsed.data.status ?? null;

    if (!authenticated) {
      // Unsigned: believe nothing until TechChief itself says so.
      const confirmed = await withDeadline(
        confirmWithTechChief(integration, parsed.data.order_ref),
        UNSIGNED_CONFIRM_DEADLINE_MS,
      );
      if (!confirmed) {
        // Not confirmed in time: answer 200, change nothing, and let their
        // retry (or the shop's own polling) settle it.
        return NextResponse.json({ ok: true, confirmed: false });
      }
      status = confirmed;
    }

    const outcome = await applyStatus(row, status, {
      deliveries,
      orders,
      draftId: integration.draftId,
    });

    return NextResponse.json({
      ok: true,
      status: outcome.status,
      changed: outcome.changed,
    });
  } catch (error) {
    return safeApiError(error);
  }
}

/**
 * Asks TechChief what really happened to one reference (unsigned path only).
 *
 * The confirmation is a real request against the shop's key, so it comes out
 * of the same hourly budget as everything else: an unsigned flood can spend
 * the budget, but never more than the budget, and once it is spent the
 * confirmation simply does not happen and the row is left alone.
 */
async function confirmWithTechChief(
  integration: { id: string; apiKey: string },
  orderRef: string,
): Promise<TechChiefOrderStatus | null> {
  const store = getIntegrationsStore();
  const budget = await consumeTechChiefBudget(store, integration.id, "poll");
  if (!budget.allowed) return null;
  if (!integration.apiKey) return null;

  const result = await getTechChiefStatus(integration.apiKey, orderRef);
  if (!result.ok) return null;
  return result.data.status;
}

/** The first candidate whose order belongs to this connection's website. */
async function findOwnRow(
  candidates: BundleDeliveryRecord[],
  draftId: string,
  orders: ReturnType<typeof getOrdersStore>,
): Promise<BundleDeliveryRecord | null> {
  for (const row of candidates) {
    const order = await orders.getById(row.orderId);
    if (order && order.draftId === draftId) return row;
  }
  return null;
}

/**
 * Applies one confirmed outcome to a row, under the engine's invariants.
 *
 * `delivered` is terminal (I3): a delivered row is never modified again, so a
 * late or replayed "failed" event is ignored. `failed`/`refunded` marks the
 * row and alerts the merchant — but only when the row was not already failed,
 * so a duplicate event cannot send a second alert. `accepted`/`processing`
 * changes nothing.
 */
async function applyStatus(
  row: BundleDeliveryRecord,
  status: string | null,
  ctx: {
    deliveries: ReturnType<typeof getBundleDeliveriesStore>;
    orders: ReturnType<typeof getOrdersStore>;
    draftId: string;
  },
): Promise<{ status: string; changed: boolean }> {
  if (row.status === "delivered") {
    return { status: "delivered", changed: false };
  }

  if (status === "delivered") {
    const updated = await ctx.deliveries.markDelivered(row.id);
    return { status: "delivered", changed: Boolean(updated) };
  }

  if (status === "failed" || status === "refunded") {
    const alreadyFailed = row.status === "failed";
    const updated = await ctx.deliveries.markFailed(row.id, {
      error:
        status === "refunded"
          ? "TechChief refunded this top-up."
          : "TechChief reported this top-up as failed.",
    });
    if (updated && !alreadyFailed) {
      await alertMerchant(updated, ctx).catch(() => "failed");
    }
    return { status: "failed", changed: !alreadyFailed };
  }

  return { status: row.status, changed: false };
}

/**
 * One aggregated merchant alert for a callback that failed a top-up, using the
 * same notifier — and therefore the same wording and channels — as the engine.
 * Best-effort: the row is already correct, and an alert must never turn a
 * successful callback into an error answer.
 */
async function alertMerchant(
  row: BundleDeliveryRecord,
  ctx: { orders: ReturnType<typeof getOrdersStore>; draftId: string },
): Promise<void> {
  const order = await ctx.orders.getById(row.orderId);
  if (!order) return;
  const draft = await publicGetDraft(ctx.draftId).catch(() => null);
  if (!draft) return;
  const deliveries = getBundleDeliveriesStore();
  const total = (await deliveries.listForOrder(order.id)).length;
  const input: MerchantDeliveryFailureInput = {
    order,
    brief: draft.brief,
    deliveries: [row],
    total,
  };
  await notifyMerchantDeliveryFailed(input).catch(() => "failed");
}
