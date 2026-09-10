/**
 * Stage 7b — POST /api/manage/[id]/orders/[orderId]/refund-wallet (R8).
 *
 * Real SQLite stores end to end: the wallet is restored exactly once per
 * order, only by the owner, and only for orders an agent actually paid from
 * their wallet. Public orders, missing purchase entries and wrong statuses
 * are plain conflicts; another website's order is a plain 404.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import { SHOP_SESSION_COOKIE } from "@/lib/shop-admin/auth";
import { SqliteShopAdminStore } from "@/lib/shop-admin/store";
import { SqliteShopAgentStore } from "@/lib/shop-agent/store";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { SqliteOrdersStore } from "@/lib/studio/orders";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import type { CatalogItem } from "@/lib/studio/site-brief/schema";
import { POST as refundWallet } from "./[id]/orders/[orderId]/refund-wallet/route";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const password = "correct horse battery";
const csrf = "csrf-token-for-refund-tests";
let dir: string;
let shopId: string;
let ownerId: string;
let owner: { id: string };
let ownerCookie: string;
let memberCookie: string;
let adminStore: SqliteShopAdminStore;
let agentStore: SqliteShopAgentStore;
let ordersStore: SqliteOrdersStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-refund-routes-"));
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
  const drafts = new SqliteStudioDraftStore();
  const draft = await drafts.create(agency, {
    ...createDefaultBrief({
      businessName: "Data GH",
      category: "data-bundles",
      items: [
        {
          id: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        } as CatalogItem,
      ],
    }),
    plan: "command_center",
  });
  shopId = draft.id;
  ownerId = canonicalUserId(agency);
  adminStore = new SqliteShopAdminStore();
  const ownerInvite = await adminStore.createOwnerInvite({
    draftId: shopId,
    email: "owner@example.com",
    name: "Owner",
    invitedBy: ownerId,
  });
  const acceptedOwner = await adminStore.acceptInvite(
    ownerInvite.token,
    "Owner",
    password,
  );
  if (!acceptedOwner) throw new Error("expected the owner");
  owner = acceptedOwner;
  ownerCookie = (await adminStore.createSession(acceptedOwner.id)).token;
  const memberInvite = await adminStore.createMemberInvite({
    draftId: shopId,
    email: "member@example.com",
    name: "Member",
    permissions: ["orders.fulfil"],
    invitedBy: ownerId,
  });
  const acceptedMember = await adminStore.acceptInvite(
    memberInvite.token,
    "Member",
    password,
  );
  if (!acceptedMember) throw new Error("expected the member");
  memberCookie = (await adminStore.createSession(acceptedMember.id)).token;
  agentStore = new SqliteShopAgentStore();
  ordersStore = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
});

function request(id: string, orderId: string, cookie: string) {
  return new NextRequest(
    `http://localhost/api/manage/${id}/orders/${orderId}/refund-wallet`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SHOP_SESSION_COOKIE}=${cookie}; valmont_csrf=${csrf}`,
        "x-valmont-csrf": csrf,
      },
      body: JSON.stringify({}),
    },
  );
}

function params(id: string, orderId: string) {
  return { params: Promise.resolve({ id, orderId }) };
}

/** One active agent with GHS 50.00 in the wallet. */
async function makeAgent() {
  const invite = await agentStore.createInvite({
    draftId: shopId,
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
    createdBy: "owner",
  });
  return agent;
}

/**
 * The exact shape a completed agent buy leaves behind: an agent order paid
 * through markPaid and its single purchase entry in the ledger.
 */
async function walletOrder(
  agentId: string,
  overrides: Record<string, unknown> = {},
) {
  const order = await ordersStore.create({
    ownerId,
    draftId: shopId,
    accessCode: "a".repeat(32),
    status: "pending",
    currency: "GHS",
    subtotal: 9.2,
    deliveryFee: 0,
    total: 9.2,
    lines: [{ itemId: "bundle-00", name: "MTN 1GB", price: 9.2, quantity: 1 }],
    customerName: "Agent One",
    customerPhone: "0240000001",
    recipientPhone: "0240000001",
    paymentMethod: "agent_wallet",
    paymentMode: "test",
    agentId,
    ...overrides,
  });
  const entry = await agentStore.purchase({
    agentId,
    orderId: order.id,
    amountMinor: 920,
    createdBy: agentId,
  });
  const paid = await ordersStore.markPaid(
    order.accessCode,
    `wallet:${entry.id}`,
  );
  return { order: paid!, entry };
}

describe("POST /api/manage/[id]/orders/[orderId]/refund-wallet", () => {
  it("a member with orders.fulfil gets 403 — money is owner-only", async () => {
    const agent = await makeAgent();
    const { order } = await walletOrder(agent.id);
    const response = await refundWallet(
      request(shopId, order.id, memberCookie),
      params(shopId, order.id),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(
      "Only the shop owner can do this.",
    );
    // Nothing moved.
    expect((await agentStore.getById(agent.id))?.balance).toBe(40.8);
    expect(await ordersStore.getById(order.id)).toMatchObject({
      status: "paid",
    });
  });

  it("the owner refunds a paid agent order once: wallet restored, entry written, status refunded", async () => {
    const agent = await makeAgent();
    const { order } = await walletOrder(agent.id);
    const response = await refundWallet(
      request(shopId, order.id, ownerCookie),
      params(shopId, order.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.order).toMatchObject({ id: order.id, status: "refunded" });
    expect(JSON.stringify(body.order)).not.toContain("ownerId");
    expect(body.entry).toMatchObject({
      kind: "refund",
      amount: 9.2,
      orderId: order.id,
      createdBy: owner.id,
    });
    // Money: back to exactly where it started (R8).
    expect((await agentStore.getById(agent.id))?.balance).toBe(50);
    const ledger = await agentStore.listEntries(agent.id);
    expect(ledger.filter((row) => row.kind === "refund")).toHaveLength(1);
    expect(ledger.filter((row) => row.kind === "purchase")).toHaveLength(1);
    const stored = await ordersStore.getById(order.id);
    expect(stored?.status).toBe("refunded");
    expect(stored?.refundedAt).toBeTruthy();
    // The purchase evidence is untouched.
    expect(stored?.paidAt).toBeTruthy();
  });

  it("a second refund is 409 and the balance does not move", async () => {
    const agent = await makeAgent();
    const { order } = await walletOrder(agent.id);
    const first = await refundWallet(
      request(shopId, order.id, ownerCookie),
      params(shopId, order.id),
    );
    expect(first.status).toBe(200);
    const second = await refundWallet(
      request(shopId, order.id, ownerCookie),
      params(shopId, order.id),
    );
    expect(second.status).toBe(409);
    expect((await agentStore.getById(agent.id))?.balance).toBe(50);
    expect(
      (await agentStore.listEntries(agent.id)).filter(
        (row) => row.kind === "refund",
      ),
    ).toHaveLength(1);
  });

  it("a public MoMo order is 409 — nothing here can grow a wallet refund", async () => {
    const momo = await ordersStore.create({
      ownerId,
      draftId: shopId,
      accessCode: "c".repeat(32),
      status: "pending",
      currency: "GHS",
      subtotal: 10,
      deliveryFee: 0,
      total: 10,
      lines: [{ itemId: "bundle-00", name: "MTN 1GB", price: 10, quantity: 1 }],
      customerName: "Kwame Buyer",
      customerPhone: "0240000002",
      recipientPhone: "0240000002",
      paymentMethod: "momo",
      paymentMode: "live",
    });
    const response = await refundWallet(
      request(shopId, momo.id, ownerCookie),
      params(shopId, momo.id),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "This order cannot be refunded to a wallet.",
    );
  });

  it("a pending agent order without its purchase entry is 409", async () => {
    const agent = await makeAgent();
    const order = await ordersStore.create({
      ownerId,
      draftId: shopId,
      accessCode: "d".repeat(32),
      status: "pending",
      currency: "GHS",
      subtotal: 9.2,
      deliveryFee: 0,
      total: 9.2,
      lines: [
        { itemId: "bundle-00", name: "MTN 1GB", price: 9.2, quantity: 1 },
      ],
      customerName: "Agent One",
      customerPhone: "0240000001",
      recipientPhone: "0240000001",
      paymentMethod: "agent_wallet",
      paymentMode: "test",
      agentId: agent.id,
    });
    const response = await refundWallet(
      request(shopId, order.id, ownerCookie),
      params(shopId, order.id),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "This order cannot be refunded to a wallet.",
    );
    expect((await agentStore.getById(agent.id))?.balance).toBe(50);
  });

  it("a delivered agent order may still be refunded to the wallet", async () => {
    const agent = await makeAgent();
    const { order } = await walletOrder(agent.id);
    await ordersStore.updateStatus(ownerId, order.id, "preparing");
    await ordersStore.updateStatus(ownerId, order.id, "out_for_delivery");
    await ordersStore.updateStatus(ownerId, order.id, "delivered");
    const response = await refundWallet(
      request(shopId, order.id, ownerCookie),
      params(shopId, order.id),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).order.status).toBe("refunded");
    expect((await agentStore.getById(agent.id))?.balance).toBe(50);
  });

  it("another website's order is a plain 404", async () => {
    const agent = await makeAgent();
    const { order } = await walletOrder(agent.id);
    // The order exists and is a wallet order — but under a sibling website
    // of the same agency user. Asking THIS shop to refund it must look like
    // an unknown id (R9), not like a readable order.
    const other = await new SqliteStudioDraftStore().create(agency, {
      ...createDefaultBrief({
        businessName: "Other Shop",
        category: "data-bundles",
        items: [
          {
            id: "bundle-00",
            name: "MTN 1GB",
            price: 10,
            bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
          } as CatalogItem,
        ],
      }),
      plan: "command_center",
    });
    const foreignOrder = await ordersStore.create({
      ownerId,
      draftId: other.id,
      accessCode: "e".repeat(32),
      status: "pending",
      currency: "GHS",
      subtotal: 9.2,
      deliveryFee: 0,
      total: 9.2,
      lines: [
        { itemId: "bundle-00", name: "MTN 1GB", price: 9.2, quantity: 1 },
      ],
      customerName: "Agent One",
      customerPhone: "0240000001",
      recipientPhone: "0240000001",
      paymentMethod: "agent_wallet",
      paymentMode: "test",
      agentId: agent.id,
    });
    const response = await refundWallet(
      request(shopId, foreignOrder.id, ownerCookie),
      params(shopId, foreignOrder.id),
    );
    expect(response.status).toBe(404);
    expect((await agentStore.getById(agent.id))?.balance).toBe(40.8);
    expect(
      await agentStore.getEntryForOrder(foreignOrder.id, "refund"),
    ).toBeNull();
    // And the shop's own order is untouched by the detour.
    expect(await ordersStore.getById(order.id)).toMatchObject({
      status: "paid",
    });
  });
});
