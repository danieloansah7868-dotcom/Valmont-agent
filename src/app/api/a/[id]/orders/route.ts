import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { safeApiError } from "@/lib/api";
import {
  NotFoundError,
  ShopAgentNotSignedInError,
  WalletInsufficientError,
} from "@/lib/api-errors";
import { publicOrigin } from "@/lib/auth-redirect";
import { readBoundedJson } from "@/lib/bounded-json";
import { assertCsrf } from "@/lib/security";
import { assertHourlyRateLimit } from "@/lib/shop-admin/rate-limit";
import { requireShopAgentApi } from "@/lib/shop-agent/auth";
import { shopAgentsAllowed } from "@/lib/shop-agent/gate";
import {
  AGENT_WALLET_PAYMENT_METHOD,
  settleAgentOrder,
} from "@/lib/shop-agent/orders";
import { agentUnitPriceMinor } from "@/lib/shop-agent/pricing";
import {
  getShopAgentStore,
  MAX_WALLET_ENTRY_MINOR,
} from "@/lib/shop-agent/store";
import {
  bundleDeliveryAvailabilityForDraft,
  dispatchBundleDeliveriesForOrder,
  LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE,
} from "@/lib/studio/bundle-delivery";
import {
  bundleOrderCapError,
  normalizeGhanaMobile,
  validateGhanaMobile,
} from "@/lib/studio/bundles";
import { publicGetDraft } from "@/lib/studio/draft-public";
import { notifyMerchantNewOrder } from "@/lib/studio/notifications";
import { getOrdersStore, type OrderLine } from "@/lib/studio/orders";
import { onlinePaymentAvailability } from "@/lib/studio/valmont-pay";

const BODY_LIMIT_BYTES = 16_000;

/**
 * What the agent's browser may send. Deliberately nothing but items,
 * quantities and the customer's phone number: never a price, a name or a
 * payment method — every cedi is recomputed on the server from this shop's
 * own catalogue and agent discount (R1), and zod silently strips anything
 * else a tampered request adds.
 */
const lineSchema = z.object({
  itemId: z.string().max(64),
  quantity: z.number().int().min(1).max(10),
});
const buySchema = z.object({
  lines: z.array(lineSchema).min(1, "Your basket is empty.").max(5),
  recipientPhone: z.string().max(30),
});

/**
 * POST /api/a/[id]/orders — the agent Buy button.
 *
 * The agent picks bundles and types the customer's number; the money leaves
 * the agent's own wallet and the order goes through the SAME delivery engine
 * as public orders. Every refusal happens before any order row exists (R5),
 * the debit and its ledger entry are one transaction (R3), the order is
 * marked paid only through markPaid (R4), and the response never includes
 * the order's access code (R9). The public checkout is unchanged (R10):
 * "agent_wallet" is not a selectable payment method anywhere else.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // 4.1 — the same CSRF double-submit check the 7a agent auth routes use,
    // then the agent session. 401 when not signed in (or no longer active),
    // 404 when the session belongs to another shop (R9).
    assertCsrf(request);
    const { id } = await params;
    const session = await requireShopAgentApi(request, id);
    if (session.agent.status !== "active") {
      throw new ShopAgentNotSignedInError();
    }

    // 4.2 — publicGetDraft, never the checkout-internal reader: an agent
    // order never needs the Valmont Pay key. A shop that cannot have agents
    // (missing, wrong category or package) is a plain 404 here.
    const draft = await publicGetDraft(id);
    if (!draft || !shopAgentsAllowed(draft.brief)) throw new NotFoundError();

    // 4.3 — per-agent hourly ceiling on wallet spends.
    assertHourlyRateLimit("agent-buy", session.agent.id, 60);

    // 4.4 — bounded body, minimal schema; extra fields (price!) are dropped.
    const body = await readBoundedJson(request, BODY_LIMIT_BYTES);
    const parsed = buySchema.parse(body);

    // 4.5 — the same shop-wide switch the public checkout honours.
    if (!draft.brief.payments.enabled) {
      return NextResponse.json(
        { error: "This shop is not accepting orders yet." },
        { status: 409 },
      );
    }

    // 4.6 — the recipient is the number the bundle lands on: Ghana mobile
    // only, stored normalised, with the exact checkout messages.
    const recipientRaw = parsed.recipientPhone.trim();
    const recipientError = validateGhanaMobile(recipientRaw);
    if (recipientError) {
      return NextResponse.json({ error: recipientError }, { status: 400 });
    }
    const recipient = normalizeGhanaMobile(recipientRaw) ?? recipientRaw;

    // 4.7 — re-price on the server (R1). Duplicate item ids merge first so
    // the per-line cap in 4.8 sees the real quantity. Price comes from this
    // draft's own items at THIS shop's agent discount — never from the body.
    const store = getShopAgentStore();
    const settings = await store.getSettings(id);
    const catalogue = new Map(draft.brief.items.map((item) => [item.id, item]));
    const merged = new Map<string, number>();
    for (const line of parsed.lines) {
      merged.set(line.itemId, (merged.get(line.itemId) ?? 0) + line.quantity);
    }
    const lines: OrderLine[] = [];
    let totalMinor = 0;
    for (const [itemId, quantity] of merged) {
      const item = catalogue.get(itemId);
      if (!item || item.price === undefined) {
        return NextResponse.json(
          { error: "One of the items in your basket is no longer available." },
          { status: 409 },
        );
      }
      if (item.paused === true) {
        return NextResponse.json(
          { error: "This bundle is currently unavailable." },
          { status: 400 },
        );
      }
      const unitMinor = agentUnitPriceMinor(
        Math.round(item.price * 100),
        settings.discountPercent,
      );
      totalMinor += unitMinor * quantity;
      lines.push({
        itemId: item.id,
        name: item.name,
        price: unitMinor / 100,
        quantity,
        image: item.image,
        bundle: item.bundle,
      });
    }

    // 4.8 — the same basket caps as the public checkout (10/line, 20/order).
    const capError = bundleOrderCapError(lines);
    if (capError) {
      return NextResponse.json({ error: capError }, { status: 400 });
    }

    // 4.9 — wallet entries are pesewa integers up to GHS 5,000 by design.
    if (totalMinor > MAX_WALLET_ENTRY_MINOR) {
      return NextResponse.json(
        { error: "Orders above GHS 5,000 cannot be paid from a wallet." },
        { status: 400 },
      );
    }

    // 4.10 — the balance is re-read from the store, never trusted from the
    // session object (R2); the session may be hours old. The real guard is
    // the conditional UPDATE inside purchase() — this is the friendly early
    // answer before an order row exists. Insufficient means NO order row.
    const fresh = await store.getById(session.agent.id);
    if (!fresh || fresh.status !== "active") {
      throw new ShopAgentNotSignedInError();
    }
    if (Math.round(fresh.balance * 100) < totalMinor) {
      throw new WalletInsufficientError();
    }

    // 4.11 — the same Test/Live switch as checkout. Live money additionally
    // needs this shop's own delivery answer (verified TechChief or manual
    // delivery), refused before any order row exactly like the public flow.
    const paymentMode = (await onlinePaymentAvailability()).mode;
    if (paymentMode === "live") {
      const bundleDelivery = await bundleDeliveryAvailabilityForDraft(draft.id);
      if (!bundleDelivery.live && !bundleDelivery.manual) {
        return NextResponse.json(
          { error: LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE },
          { status: 409 },
        );
      }
    }

    // 4.12 — the order row, still "pending" and unpaid; create() never
    // writes paid_at. The 32-hex access code is generated here, stored with
    // the order, and never returned to the agent's browser (R9).
    const accessCode = randomBytes(16).toString("hex");
    const order = await getOrdersStore().create({
      ownerId: draft.ownerId,
      draftId: draft.id,
      accessCode,
      status: "pending",
      currency: draft.brief.currency,
      subtotal: totalMinor / 100,
      deliveryFee: 0,
      total: totalMinor / 100,
      lines,
      customerName: session.agent.name,
      customerPhone: session.agent.phone ?? recipient,
      recipientPhone: recipient,
      customerEmail: session.agent.email,
      paymentMethod: AGENT_WALLET_PAYMENT_METHOD,
      paymentMode,
      agentId: session.agent.id,
    });

    // 4.13 — the debit, with its ledger entry in the same transaction (R3).
    // A race lost since 4.10 (two buys at once) lands here as
    // WalletInsufficientError: the order is flipped to payment_failed and the
    // agent gets the 409 — the wallet was NOT charged for it.
    let entry;
    try {
      entry = await store.purchase({
        agentId: session.agent.id,
        orderId: order.id,
        amountMinor: totalMinor,
        createdBy: session.agent.id,
      });
    } catch (error) {
      if (error instanceof WalletInsufficientError) {
        await getOrdersStore()
          .markFailed(accessCode)
          .catch(() => null);
      }
      throw error;
    }

    // 4.14 — settle: markPaid (the only path that sets paidAt; R4), then the
    // delivery engine, through the same recovery helper the pages use.
    const paid = await settleAgentOrder(order);

    // 4.15 — the merchant alert is best-effort, exactly like checkout; it
    // must never fail a paid order.
    void notifyMerchantNewOrder({
      order: paid,
      brief: draft.brief,
      origin: publicOrigin(request.url),
    }).catch(() => "failed");

    // 4.16 — awaited (the agent's next page must be deterministic), inside a
    // swallow: a delivery problem lives on the delivery rows and never
    // un-pays the order; the owner has Retry and Refund to wallet.
    const deliveries = await dispatchBundleDeliveriesForOrder(paid.id).catch(
      () => [],
    );

    // 4.17 — what the agent may know: their order, what they paid, their new
    // balance, and the delivery states. Never the access code (R9).
    return NextResponse.json({
      orderId: paid.id,
      status: paid.status,
      total: paid.total,
      balanceAfter: entry.balanceAfter,
      deliveries: deliveries.map((delivery) => ({ status: delivery.status })),
    });
  } catch (error) {
    return safeApiError(error);
  }
}
