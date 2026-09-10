/**
 * Stage 7b — POST /api/a/[id]/orders, tested against the REAL SQLite stores
 * (draft, agents, wallet, orders, delivery engine) end to end. Only the two
 * environment answers are mocked: which payment rail is selected
 * (onlinePaymentAvailability) and whether THIS shop can deliver live
 * (bundleDeliveryAvailabilityForDraft) — exactly the checkout test's seam.
 * The dispatch itself stays real and lands on the simulator provider, so no
 * network, no .data writes, and no payment attempts happen here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import { SHOP_AGENT_SESSION_COOKIE } from "@/lib/shop-agent/auth";
import { SqliteShopAgentStore } from "@/lib/shop-agent/store";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { SqliteOrdersStore } from "@/lib/studio/orders";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import type { CatalogItem } from "@/lib/studio/site-brief/schema";
import { BUNDLE_ORDER_CAP_MESSAGE } from "@/lib/studio/bundles";
import { LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE } from "@/lib/studio/bundle-delivery";
import { POST as buy } from "./[id]/orders/route";

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

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const password = "correct horse battery";
const csrf = "csrf-token-for-agent-buy-tests";
let dir: string;
let agentStore: SqliteShopAgentStore;
let ordersStore: SqliteOrdersStore;

function bundleItem(
  price: number,
  id = "bundle-00",
  paused = false,
): CatalogItem {
  return {
    id,
    name: `MTN ${price}GHS`,
    price,
    ...(paused ? { paused: true } : {}),
    bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
  } as CatalogItem;
}

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
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-agent-buy-"));
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat.sqlite"),
      path.join(dir, "chat.json"),
    ),
  );
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  resetRateLimitForTests();
  agentStore = new SqliteShopAgentStore();
  ordersStore = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
});

async function makeShop(options: {
  plan?: string;
  category?: string;
  items?: CatalogItem[];
  paymentsEnabled?: boolean;
}) {
  const drafts = new SqliteStudioDraftStore();
  const brief = {
    ...createDefaultBrief({
      businessName: "Data GH",
      category: (options.category ?? "data-bundles") as never,
      items: options.items ?? [bundleItem(10)],
    }),
    plan: (options.plan ?? "command_center") as never,
  };
  // The default brief leaves payments off; this shop accepts orders unless
  // the test says otherwise.
  brief.payments = {
    ...brief.payments,
    enabled: options.paymentsEnabled !== false,
    methods: ["valmont_pay"] as never,
  };
  return (await drafts.create(agency, brief)).id;
}

async function makeAgent(draftId: string, email: string, creditMinor = 5000) {
  const invite = await agentStore.createInvite({
    draftId,
    email,
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
  if (creditMinor > 0) {
    await agentStore.credit({
      agentId: agent.id,
      amountMinor: creditMinor,
      createdBy: "owner",
    });
  }
  const session = await agentStore.createSession(agent.id);
  return { agent, cookie: session.token };
}

function buyRequest(
  id: string,
  body: Record<string, unknown>,
  agentCookie?: string,
) {
  return new NextRequest(`http://localhost/api/a/${id}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SHOP_AGENT_SESSION_COOKIE}=${agentCookie ?? "missing"}; valmont_csrf=${csrf}`,
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function orderBody(overrides: Record<string, unknown> = {}) {
  return {
    lines: [{ itemId: "bundle-00", quantity: 1 }],
    recipientPhone: "024 000 0001",
    ...overrides,
  };
}

async function orderCount(shopId: string) {
  return (
    await ordersStore.listForOwner(canonicalUserId(agency), {
      draftId: shopId,
      limit: 50,
    })
  ).length;
}

describe("POST /api/a/[id]/orders — signing in and gating", () => {
  it("401 without a session, 401 for a disabled agent, 404 for another shop's session", async () => {
    const shopId = await makeShop({});
    const { cookie } = await makeAgent(shopId, "agent@example.com");

    const unsigned = await buy(buyRequest(shopId, orderBody()), params(shopId));
    expect(unsigned.status).toBe(401);

    // A session scoped to a DIFFERENT shop answers like an unknown shop (R9).
    const otherShop = await makeShop({});
    const moved = await buy(
      buyRequest(otherShop, orderBody(), cookie),
      params(otherShop),
    );
    expect(moved.status).toBe(404);

    const second = await makeAgent(shopId, "disabled@example.com");
    await agentStore.setStatus(second.agent.id, "disabled");
    const disabled = await buy(
      buyRequest(shopId, orderBody(), second.cookie),
      params(shopId),
    );
    expect(disabled.status).toBe(401);
    expect(await orderCount(shopId)).toBe(0);
  });

  it("404 when the shop's plan is not command_center, even with a valid agent session there", async () => {
    const autoShop = await makeShop({ plan: "auto_dispatch" });
    const { cookie } = await makeAgent(autoShop, "agent@example.com");
    const response = await buy(
      buyRequest(autoShop, orderBody(), cookie),
      params(autoShop),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/a/[id]/orders — the wallet buys the bundle", () => {
  it("200: server pricing at the shop discount, one purchase entry, paid order, simulated delivery", async () => {
    const shopId = await makeShop({});
    await agentStore.setDiscountPercent(shopId, 8);
    const { agent, cookie } = await makeAgent(shopId, "agent@example.com");

    // A tampered body: any price/total it claims is ignored (R1).
    const response = await buy(
      buyRequest(
        shopId,
        orderBody({ price: 0.01, total: 0.01, name: "forged" }),
        cookie,
      ),
      params(shopId),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "paid",
      total: 9.2,
      balanceAfter: 40.8,
    });
    expect(typeof body.orderId).toBe("string");
    // The access code is the customer's proof — never sent to an agent (R9).
    expect(body).not.toHaveProperty("accessCode");
    expect(JSON.stringify(body)).not.toContain("accessCode");
    expect(body.deliveries).toHaveLength(1);
    expect(["processing", "delivered"]).toContain(body.deliveries[0].status);

    // The order: agent-stamped, wallet-paid, marked paid the only legal way.
    const order = await ordersStore.getById(body.orderId);
    expect(order).toMatchObject({
      draftId: shopId,
      agentId: agent.id,
      paymentMethod: "agent_wallet",
      status: "paid",
      total: 9.2,
      recipientPhone: "0240000001",
      customerEmail: "agent@example.com",
    });
    expect(order?.paidAt).toBeTruthy();
    expect(order?.lines).toEqual([
      expect.objectContaining({
        itemId: "bundle-00",
        price: 9.2,
        quantity: 1,
      }),
    ]);

    // The ledger: EXACTLY ONE purchase entry for this order (R3).
    const entry = await agentStore.getEntryForOrder(body.orderId, "purchase");
    expect(entry).toMatchObject({
      kind: "purchase",
      amount: -9.2,
      balanceAfter: 40.8,
      orderId: body.orderId,
      createdBy: agent.id,
    });
    expect(
      (await agentStore.listEntries(agent.id)).filter(
        (row) => row.kind === "purchase",
      ),
    ).toHaveLength(1);
    expect((await agentStore.getById(agent.id))?.balance).toBe(40.8);

    // A replay of the same page (same order id) would NOT debit again.
    const replay = await agentStore.purchase({
      agentId: agent.id,
      orderId: body.orderId,
      amountMinor: 920,
      createdBy: agent.id,
    });
    expect(replay.id).toBe(entry?.id);
    expect((await agentStore.getById(agent.id))?.balance).toBe(40.8);
  });

  it("stamps paymentMode from onlinePaymentAvailability: test here, live when the rail says live", async () => {
    const testShop = await makeShop({});
    const testAgent = await makeAgent(testShop, "one@example.com");
    const testResponse = await buy(
      buyRequest(testShop, orderBody(), testAgent.cookie),
      params(testShop),
    );
    const testBody = await testResponse.json();
    expect((await ordersStore.getById(testBody.orderId))?.paymentMode).toBe(
      "test",
    );

    // Live rail selected AND this shop can deliver for real money: the same
    // checkout still works, stamped live (R6).
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "techchief",
      live: true,
    });
    const liveShop = await makeShop({});
    const liveAgent = await makeAgent(liveShop, "two@example.com");
    const liveResponse = await buy(
      buyRequest(liveShop, orderBody(), liveAgent.cookie),
      params(liveShop),
    );
    expect(liveResponse.status).toBe(200);
    const liveBody = await liveResponse.json();
    expect((await ordersStore.getById(liveBody.orderId))?.paymentMode).toBe(
      "live",
    );
    expect(liveBody.status).toBe("paid");
  });
});

describe("POST /api/a/[id]/orders — every refusal happens before any order row (R5)", () => {
  it("409 insufficient with a blank balance: no order row, no entry", async () => {
    const shopId = await makeShop({});
    const { agent, cookie } = await makeAgent(shopId, "broke@example.com", 0);
    const response = await buy(
      buyRequest(shopId, orderBody(), cookie),
      params(shopId),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "The wallet does not have that much.",
    );
    expect(await orderCount(shopId)).toBe(0);
    expect(await agentStore.listEntries(agent.id)).toHaveLength(0);
  });

  it("409 when the shop is not accepting orders", async () => {
    const shopId = await makeShop({ paymentsEnabled: false });
    const { cookie } = await makeAgent(shopId, "agent@example.com");
    const response = await buy(
      buyRequest(shopId, orderBody(), cookie),
      params(shopId),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "This shop is not accepting orders yet.",
    );
    expect(await orderCount(shopId)).toBe(0);
  });

  it("400 invalid recipient, 400 missing recipient", async () => {
    const shopId = await makeShop({});
    const { cookie } = await makeAgent(shopId, "agent@example.com");
    const landline = await buy(
      buyRequest(shopId, orderBody({ recipientPhone: "0301234567" }), cookie),
      params(shopId),
    );
    expect(landline.status).toBe(400);
    const missing = await buy(
      buyRequest(shopId, orderBody({ recipientPhone: "  " }), cookie),
      params(shopId),
    );
    expect(missing.status).toBe(400);
    expect(await orderCount(shopId)).toBe(0);
  });

  it("409 unknown item, 400 paused bundle", async () => {
    const items = [bundleItem(10), bundleItem(10, "bundle-99", true)];
    const shopId = await makeShop({ items });
    const { cookie } = await makeAgent(shopId, "agent@example.com");
    const unknown = await buy(
      buyRequest(
        shopId,
        orderBody({ lines: [{ itemId: "nope", quantity: 1 }] }),
        cookie,
      ),
      params(shopId),
    );
    expect(unknown.status).toBe(409);
    expect((await unknown.json()).error).toBe(
      "One of the items in your basket is no longer available.",
    );
    const paused = await buy(
      buyRequest(
        shopId,
        orderBody({ lines: [{ itemId: "bundle-99", quantity: 1 }] }),
        cookie,
      ),
      params(shopId),
    );
    expect(paused.status).toBe(400);
    expect((await paused.json()).error).toBe(
      "This bundle is currently unavailable.",
    );
    expect(await orderCount(shopId)).toBe(0);
  });

  it("400 when more than 10 of one bundle after merging duplicate lines", async () => {
    const shopId = await makeShop({});
    const { cookie } = await makeAgent(shopId, "agent@example.com");
    const response = await buy(
      buyRequest(
        shopId,
        orderBody({
          lines: [
            { itemId: "bundle-00", quantity: 10 },
            { itemId: "bundle-00", quantity: 1 },
          ],
        }),
        cookie,
      ),
      params(shopId),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(BUNDLE_ORDER_CAP_MESSAGE);
    expect(await orderCount(shopId)).toBe(0);
  });

  it("409 live money without this shop's live delivery, before any order row", async () => {
    mocks.onlinePaymentAvailability.mockResolvedValue({
      available: true,
      mode: "live",
    });
    mocks.bundleDeliveryAvailabilityForDraft.mockResolvedValue({
      provider: "simulator",
      live: false,
    });
    const shopId = await makeShop({});
    const { cookie } = await makeAgent(shopId, "agent@example.com");
    const response = await buy(
      buyRequest(shopId, orderBody(), cookie),
      params(shopId),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      LIVE_BUNDLE_DELIVERY_UNAVAILABLE_MESSAGE,
    );
    expect(await orderCount(shopId)).toBe(0);
  });

  it("two concurrent buys: 200 once and 409 once, with exactly one ledger entry", async () => {
    const shopId = await makeShop({ items: [bundleItem(6)] });
    const { agent, cookie } = await makeAgent(
      shopId,
      "racer@example.com",
      1000,
    );
    const results = await Promise.all([
      buy(buyRequest(shopId, orderBody(), cookie), params(shopId)),
      buy(buyRequest(shopId, orderBody(), cookie), params(shopId)),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const entries = (await agentStore.listEntries(agent.id)).filter(
      (row) => row.kind === "purchase",
    );
    expect(entries).toHaveLength(1);
    expect((await agentStore.getById(agent.id))?.balance).toBe(4);
    // The lost buy must not leave an order sitting at "pending" as though it
    // were waiting for money — it is payment_failed and owns no wallet entry.
    const orders = await ordersStore.listForOwner(canonicalUserId(agency), {
      draftId: shopId,
      limit: 10,
    });
    expect(orders).toHaveLength(2);
    const loser = orders.find((order) => order.status === "payment_failed");
    expect(loser).toBeTruthy();
    expect(await agentStore.getEntryForOrder(loser!.id, "purchase")).toBeNull();
    const winner = orders.find((order) => order.status === "paid");
    expect(winner?.paidAt).toBeTruthy();
  });

  it("429 after the hourly limit", async () => {
    const shopId = await makeShop({});
    const { cookie } = await makeAgent(shopId, "spam@example.com", 920);
    let lastStatus = 0;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await buy(
        buyRequest(shopId, orderBody(), cookie),
        params(shopId),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});
