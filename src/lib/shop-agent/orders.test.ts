/**
 * Stage 7b — settleAgentOrder: the crash-window closer between the wallet
 * debit and markPaid. An agent order with its purchase entry settles to paid
 * (paidAt set, R4) and dispatches; anything else — no entry, already paid, a
 * public order, a cancelled order — is left exactly as found.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { SqliteShopAgentStore } from "./store";
import { settleAgentOrder } from "./orders";
import { SqliteOrdersStore, type NewOrderInput } from "@/lib/studio/orders";
import { getBundleDeliveriesStore } from "@/lib/studio/bundle-delivery";

let dir: string;
let store: SqliteShopAgentStore;
let orders: SqliteOrdersStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-settle-"));
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat.sqlite"),
      path.join(dir, "chat.json"),
    ),
  );
  delete process.env.DATABASE_URL;
  store = new SqliteShopAgentStore();
  orders = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function agentOrder(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  return {
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: "a".repeat(32),
    status: "pending",
    currency: "GHS",
    subtotal: 9.2,
    deliveryFee: 0,
    total: 9.2,
    lines: [
      {
        itemId: "bundle-00",
        name: "MTN 1GB",
        price: 9.2,
        quantity: 1,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    customerName: "Agent One",
    customerPhone: "0240000001",
    recipientPhone: "0240000001",
    paymentMethod: "agent_wallet",
    paymentMode: "test",
    agentId: "agent-1",
    ...overrides,
  };
}

async function agentWith50() {
  const invite = await store.createInvite({
    draftId: "draft-1",
    email: "agent@example.com",
    name: "Agent One",
    invitedBy: "owner",
  });
  const token = await store.createInviteToken(invite.id);
  const agent = await store.acceptInvite(
    token.token,
    "Agent One",
    "correct horse battery",
  );
  if (!agent) throw new Error("expected an active agent");
  await store.credit({
    agentId: agent.id,
    amountMinor: 5000,
    createdBy: "owner",
  });
  return agent;
}

describe("settleAgentOrder", () => {
  it("a pending order whose wallet already paid becomes paid, with paidAt set and deliveries started", async () => {
    const agent = await agentWith50();
    // The crash: debit happened (the 7b route's step 4.13), markPaid did not.
    const order = await orders.create(agentOrder({ agentId: agent.id }));
    const entry = await store.purchase({
      agentId: agent.id,
      orderId: order.id,
      amountMinor: 920,
      createdBy: agent.id,
    });
    expect(await orders.getById(order.id)).toMatchObject({
      status: "pending",
      paidAt: undefined,
    });

    const settled = await settleAgentOrder(order);
    expect(settled.status).toBe("paid");
    expect(settled.paidAt).toBeTruthy();
    expect(settled.paymentRef).toBe(`wallet:${entry.id}`);
    const stored = await orders.getById(order.id);
    expect(stored?.statusHistory.at(-1)).toMatchObject({ status: "paid" });
    // The simulator engine already made the top-ups for the order.
    const deliveries = await getBundleDeliveriesStore().listForOrder(order.id);
    expect(deliveries).toHaveLength(1);
    expect(["processing", "delivered"]).toContain(deliveries[0]?.status ?? "");

    // Settling is safe to run again: same paid row, same single delivery.
    const again = await settleAgentOrder(settled);
    expect(again.status).toBe("paid");
    expect(
      await getBundleDeliveriesStore().listForOrder(order.id),
    ).toHaveLength(1);
  });

  it("leaves an order without a purchase entry untouched — a refused buy is not revived", async () => {
    const order = await orders.create(agentOrder());
    const result = await settleAgentOrder(order);
    expect(result.status).toBe("pending");
    expect((await orders.getById(order.id))?.status).toBe("pending");
    expect((await orders.getById(order.id))?.paidAt).toBeUndefined();
    expect(await getBundleDeliveriesStore().listForOrder(order.id)).toEqual([]);
  });

  it("never touches a public order, even one still pending", async () => {
    const agent = await agentWith50();
    const order = await orders.create(
      agentOrder({
        agentId: undefined,
        paymentMethod: "valmont_pay",
        status: "pending",
      }),
    );
    // Even a purchase entry pointing at it (which the store shape allows the
    // route to never create) must not flip a public order here.
    await store.purchase({
      agentId: agent.id,
      orderId: order.id,
      amountMinor: 920,
      createdBy: agent.id,
    });
    const result = await settleAgentOrder(order);
    expect(result.status).toBe("pending");
    expect((await orders.getById(order.id))?.paidAt).toBeUndefined();
    expect(await getBundleDeliveriesStore().listForOrder(order.id)).toEqual([]);
  });

  it("leaves cancelled and already-paid agent orders alone", async () => {
    const agent = await agentWith50();
    const cancelled = await orders.create(
      agentOrder({ agentId: agent.id, accessCode: "c".repeat(32) }),
    );
    await store.purchase({
      agentId: agent.id,
      orderId: cancelled.id,
      amountMinor: 920,
      createdBy: agent.id,
    });
    await orders.updateStatus("owner-1", cancelled.id, "cancelled");
    const fished = await orders.getById(cancelled.id);
    expect((await settleAgentOrder(fished!)).status).toBe("cancelled");
    // …and the database agrees it never became paid.
    expect((await orders.getById(cancelled.id))?.paidAt).toBeUndefined();

    const paid = await orders.create(
      agentOrder({ agentId: agent.id, accessCode: "p".repeat(32) }),
    );
    await store.purchase({
      agentId: agent.id,
      orderId: paid.id,
      amountMinor: 920,
      createdBy: agent.id,
    });
    const marked = await orders.markPaid(paid.accessCode, "wallet:x");
    expect((await settleAgentOrder(marked!)).status).toBe("paid");
  });
});
