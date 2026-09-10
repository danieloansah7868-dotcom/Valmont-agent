/**
 * Stage 7b — the crash window between the wallet debit and markPaid must
 * never strand money, and the recovery path must be exactly what the pages
 * do.
 *
 * These two tests run the REAL seam end to end: the agent buy route
 * (POST /api/a/[id]/orders) against real SQLite stores, a forcibly stuck
 * order (purchase entry written, order still "pending" — the exact state a
 * crash between the debit and markPaid would leave, simulated with raw SQL
 * because no legal store path produces it), then the two calls the agent
 * order page makes on load (getForAgent + settleAgentOrder — the page's
 * exact lines), and finally the owner's refund route. Only the two
 * environment answers are mocked (payment-rail mode, live-delivery
 * availability), exactly like the buy-route test: the dispatch itself stays
 * real and lands on the simulator provider, so nothing here hits a network,
 * writes .data, calls a model, or sends email.
 *
 * A stuck checkout settles on the FIRST page load that sees it — marked
 * paid through the only channel allowed (markPaid with a wallet:<entry>
 * reference), delivered by the same engine public orders use, with the
 * wallet debited exactly once. And the refund afterwards returns the money
 * exactly once: a second attempt 409s before it can credit again.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { resetRateLimitForTests } from "@/lib/security";
import { SHOP_AGENT_SESSION_COOKIE } from "@/lib/shop-agent/auth";
import { SHOP_SESSION_COOKIE } from "@/lib/shop-admin/auth";
import { SqliteShopAdminStore } from "@/lib/shop-admin/store";
import { SqliteShopAgentStore } from "@/lib/shop-agent/store";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { SqliteOrdersStore, type OrderRecord } from "@/lib/studio/orders";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import type { CatalogItem } from "@/lib/studio/site-brief/schema";
import { recheckBundleDeliveriesForOrder } from "@/lib/studio/bundle-delivery";
import { AGENT_WALLET_PAYMENT_METHOD, settleAgentOrder } from "./orders";
import { POST as buy } from "@/app/api/a/[id]/orders/route";
import { POST as refundWallet } from "@/app/api/manage/[id]/orders/[orderId]/refund-wallet/route";

const mocks = vi.hoisted(() => ({
  onlinePaymentAvailability: vi.fn(),
  bundleDeliveryAvailabilityForDraft: vi.fn(),
}));

vi.mock("@/lib/studio/valmont-pay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio/valmont-pay")>()),
  onlinePaymentAvailability: mocks.onlinePaymentAvailability,
}));

vi.mock("@/lib/studio/bundle-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio/bundle-delivery")>()),
  bundleDeliveryAvailabilityForDraft: mocks.bundleDeliveryAvailabilityForDraft,
}));

const agency: SessionUser = { id: "7007", login: "kofi", name: "Kofi" };
const password = "correct horse battery";
const csrf = "csrf-token-for-stuck-settle-tests";
let dir: string;
let dbPath: string;
let agentStore: SqliteShopAgentStore;
let adminStore: SqliteShopAdminStore;
let ordersStore: SqliteOrdersStore;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onlinePaymentAvailability.mockResolvedValue({
    available: true,
    mode: "test",
  });
  mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
    provider: "simulator",
    live: false,
  });
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-stuck-settle-"));
  dbPath = path.join(dir, "chat.sqlite");
  setSqliteChatStoreForTests(
    new SqliteChatStore(dbPath, path.join(dir, "chat.json")),
  );
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  resetRateLimitForTests();
  agentStore = new SqliteShopAgentStore();
  adminStore = new SqliteShopAdminStore();
  ordersStore = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
});

async function makeShop(): Promise<string> {
  const drafts = new SqliteStudioDraftStore();
  const item = {
    id: "bundle-00",
    name: "MTN 1GB",
    price: 10,
    bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
  } as CatalogItem;
  const brief = {
    ...createDefaultBrief({
      businessName: "Data GH",
      category: "data-bundles" as never,
      items: [item],
    }),
    plan: "command_center" as never,
  };
  // Payments on (the default brief ships with them off) and the public rail
  // present — the agent buy route still never touches a payment link.
  brief.payments = {
    ...brief.payments,
    enabled: true,
    methods: ["valmont_pay"] as never,
  };
  return (await drafts.create(agency, brief)).id;
}

/** One active agent with GHS 50.00 in the wallet, plus their session. */
async function makeAgent(draftId: string) {
  const invite = await agentStore.createInvite({
    draftId,
    email: "agent@example.com",
    name: "Agent One",
    invitedBy: "owner",
  });
  const inviteToken = await agentStore.createInviteToken(invite.id);
  const agent = await agentStore.acceptInvite(
    inviteToken.token,
    "Agent One",
    password,
  );
  if (!agent) throw new Error("expected an active agent");
  await agentStore.credit({
    agentId: agent.id,
    amountMinor: 5000,
    note: "opening",
    createdBy: "owner",
  });
  const session = await agentStore.createSession(agent.id);
  return { agent, cookie: session.token };
}

/** The shop's owner login with a session (the refund route is owner-only). */
async function makeOwner(draftId: string) {
  const ownerInvite = await adminStore.createOwnerInvite({
    draftId,
    email: "owner@example.com",
    name: "Owner",
    invitedBy: "owner",
  });
  const owner = await adminStore.acceptInvite(
    ownerInvite.token,
    "Owner",
    password,
  );
  if (!owner) throw new Error("expected the owner");
  const session = await adminStore.createSession(owner.id);
  return { owner, cookie: session.token };
}

function buyRequest(id: string, agentCookie: string) {
  return new NextRequest(`http://localhost/api/a/${id}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SHOP_AGENT_SESSION_COOKIE}=${agentCookie}; valmont_csrf=${csrf}`,
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify({
      lines: [{ itemId: "bundle-00", quantity: 1 }],
      recipientPhone: "024 000 0001",
    }),
  });
}

function refundRequest(id: string, orderId: string, ownerCookie: string) {
  return new NextRequest(
    `http://localhost/api/manage/${id}/orders/${orderId}/refund-wallet`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SHOP_SESSION_COOKIE}=${ownerCookie}; valmont_csrf=${csrf}`,
        "x-valmont-csrf": csrf,
      },
      body: JSON.stringify({}),
    },
  );
}

/**
 * Simulate the crash: the wallet debit landed (purchase entry exists), the
 * process died before markPaid and before any delivery row was written. No
 * store method can express that (markPaid and the ledger never expose an
 * undo), so the window is recreated with raw SQL — the same bytes a killed
 * process would have left on disk.
 */
function forceStuck(order: OrderRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT status_history_json FROM studio_orders WHERE id = ?")
      .get(order.id) as { status_history_json: string } | undefined;
    expect(row, "the bought order exists on disk").toBeTruthy();
    const history = JSON.parse(row!.status_history_json) as unknown[];
    db.prepare(
      `UPDATE studio_orders
         SET status = 'pending', payment_ref = NULL, paid_at = NULL,
             status_history_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(history.slice(0, 1)),
      new Date().toISOString(),
      order.id,
    );
    db.prepare("DELETE FROM studio_deliveries WHERE order_id = ?").run(
      order.id,
    );
  } finally {
    db.close();
  }
}

interface StuckWorld {
  shopId: string;
  agent: { id: string };
  agentCookie: string;
  ownerCookie: string;
  orderId: string;
}

/** Buy one GHS 10 bundle for real, then rewind the order into the window. */
async function setupStuckOrder(): Promise<StuckWorld> {
  const shopId = await makeShop();
  const { agent, cookie: agentCookie } = await makeAgent(shopId);
  const { cookie: ownerCookie } = await makeOwner(shopId);
  const response = await buy(buyRequest(shopId, agentCookie), {
    params: Promise.resolve({ id: shopId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    orderId: string;
    status: string;
    balanceAfter: number;
  };
  expect(body.status).toBe("paid");
  expect(body.balanceAfter).toBe(40);
  const bought = await ordersStore.getById(body.orderId);
  expect(bought?.status).toBe("paid");
  expect(bought?.paymentMethod).toBe(AGENT_WALLET_PAYMENT_METHOD);
  forceStuck(bought!);
  const stuck = await ordersStore.getById(body.orderId);
  expect(stuck?.status).toBe("pending");
  expect(stuck?.paidAt).toBeFalsy();
  expect(stuck?.paymentRef).toBeFalsy();
  return {
    shopId,
    agent: { id: agent.id },
    agentCookie,
    ownerCookie,
    orderId: body.orderId,
  };
}

describe("Forced stuck agent wallet checkout settles on agent page load", () => {
  it("settles through markPaid only — once — and delivers through the same engine", async () => {
    const world = await setupStuckOrder();

    // ===================== what /a/[id]/orders/[orderId] does on load ====
    const found = await ordersStore.getForAgent(world.agent.id, world.orderId);
    expect(found?.status).toBe("pending");
    const settled = await settleAgentOrder(found!);
    // =====================================================================

    expect(settled.status).toBe("paid");
    // Marked paid through the ONLY legal channel: paidAt set, and the
    // reference names the wallet entry, never a payment link (R4, R7).
    expect(settled.paidAt).toBeTruthy();
    const entry = await agentStore.getEntryForOrder(world.orderId, "purchase");
    expect(entry).toBeTruthy();
    expect(settled.paymentRef).toBe(`wallet:${entry!.id}`);

    // The wallet was debited exactly once — the debit was BEFORE the crash,
    // the settle must never re-run it. One purchase entry, balance GHS 40.
    expect(
      (await agentStore.listEntries(world.agent.id)).filter(
        (row) => row.kind === "purchase",
      ),
    ).toHaveLength(1);
    expect((await agentStore.getById(world.agent.id))?.balance).toBe(40);

    // Delivered by the same engine public orders use (simulator here):
    // the page's next line, recheck, sees the rows settle created.
    const deliveries = await recheckBundleDeliveriesForOrder(settled.id);
    expect(deliveries.length).toBeGreaterThan(0);
    for (const delivery of deliveries) {
      expect(delivery.status).toBe("delivered");
    }
    const deliveryCount = deliveries.length;

    // A second page load is a no-op: same single entry, no extra rows.
    const again = await ordersStore.getForAgent(world.agent.id, world.orderId);
    const settledTwice = await settleAgentOrder(again!);
    expect(settledTwice.status).toBe("paid");
    expect(
      (await agentStore.listEntries(world.agent.id)).filter(
        (row) => row.kind === "purchase",
      ),
    ).toHaveLength(1);
    expect(
      (await recheckBundleDeliveriesForOrder(settledTwice.id)).length,
    ).toBe(deliveryCount);
    expect((await agentStore.getById(world.agent.id))?.balance).toBe(40);
  });

  it("… and refund returns money once", async () => {
    const world = await setupStuckOrder();
    const found = await ordersStore.getForAgent(world.agent.id, world.orderId);
    const settled = await settleAgentOrder(found!);
    expect(settled.status).toBe("paid");

    // The owner refunds the delivered-and-settled order to the wallet.
    const first = await refundWallet(
      refundRequest(world.shopId, world.orderId, world.ownerCookie),
      {
        params: Promise.resolve({
          id: world.shopId,
          orderId: world.orderId,
        }),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      order: { status: string; ownerId?: string };
      entry: { kind: string; amount: number; balanceAfter: number };
    };
    expect(firstBody.order.status).toBe("refunded");
    // The shop never receives the agency's owner id.
    expect(firstBody.order.ownerId).toBeUndefined();
    expect(firstBody.entry).toMatchObject({
      kind: "refund",
      amount: 10,
      balanceAfter: 50,
    });
    expect((await agentStore.getById(world.agent.id))?.balance).toBe(50);
    expect((await ordersStore.getById(world.orderId))?.status).toBe("refunded");
    expect(
      (await agentStore.listEntries(world.agent.id)).filter(
        (row) => row.kind === "refund",
      ),
    ).toHaveLength(1);

    // A second click — refresh, double tap, retry — 409s at the transition
    // gate BEFORE the wallet could be credited again: money moved once.
    const second = await refundWallet(
      refundRequest(world.shopId, world.orderId, world.ownerCookie),
      {
        params: Promise.resolve({
          id: world.shopId,
          orderId: world.orderId,
        }),
      },
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe(
      "This order cannot move from refunded to refunded.",
    );
    expect((await agentStore.getById(world.agent.id))?.balance).toBe(50);
    expect(
      (await agentStore.listEntries(world.agent.id)).filter(
        (row) => row.kind === "refund",
      ),
    ).toHaveLength(1);
  });
});
