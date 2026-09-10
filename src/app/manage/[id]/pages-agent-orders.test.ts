/**
 * Stage 7b — owner-side pages: the Agent badge on the order list, the
 * wallet-paid order detail (agent block, Refund to wallet button, refund
 * note, method label), and the agent statement's order links + Orders list.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAdminSession: vi.fn(),
  publicGetDraft: vi.fn(),
  publicGetDraftOwnerId: vi.fn(),
  getShopAdminStore: vi.fn(),
  getShopAgentStore: vi.fn(),
  getOrdersStore: vi.fn(),
  getBundleDeliveriesStore: vi.fn(),
  settleAgentOrder: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/shop-admin/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shop-admin/auth")>();
  return {
    ...actual,
    getShopAdminSession: mocks.getShopAdminSession,
    requireShopAdminSession: async (draftId: string, next?: string) => {
      const session = await mocks.getShopAdminSession(draftId);
      if (!session) {
        mocks.redirect(
          `/manage/${draftId}/login?next=${encodeURIComponent(next ?? "")}`,
        );
        throw new Error("NEXT_REDIRECT");
      }
      return session;
    },
  };
});

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
  publicGetDraftOwnerId: mocks.publicGetDraftOwnerId,
}));

vi.mock("@/lib/shop-admin/store", () => ({
  getShopAdminStore: mocks.getShopAdminStore,
}));

vi.mock("@/lib/shop-agent/store", () => ({
  getShopAgentStore: mocks.getShopAgentStore,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: mocks.getOrdersStore,
}));

vi.mock("@/lib/shop-agent/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shop-agent/orders")>()),
  settleAgentOrder: mocks.settleAgentOrder,
}));

vi.mock("@/lib/studio/bundle-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio/bundle-delivery")>()),
  getBundleDeliveriesStore: mocks.getBundleDeliveriesStore,
}));

const SHOP_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const AGENT_ID = "cccccccc-1111-4222-8333-444444444444";
const ORDER_ID = "bbbbbbbb-2222-4333-8444-555555555555";

function draft(plan = "command_center", category = "data-bundles") {
  return {
    id: SHOP_ID,
    ownerId: "agency-owner-1",
    brief: { businessName: "Data GH", category, plan, items: [] },
  };
}

function session(role: "owner" | "member") {
  return {
    admin: {
      id: `admin-${role}`,
      draftId: SHOP_ID,
      email: `${role}@example.com`,
      name: role === "owner" ? "Kofi" : "Staff",
      role,
      permissions: role === "member" ? ["orders.fulfil"] : [],
      status: "active",
      hasPassword: true,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    draftId: SHOP_ID,
    email: "agent@example.com",
    name: "Ama Reseller",
    phone: null,
    status: "active",
    balance: 40.8,
    hasPassword: true,
    invitedBy: "admin-owner",
    lastLoginAt: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-09T08:00:00.000Z",
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    draftId: SHOP_ID,
    agentId: AGENT_ID,
    kind: "purchase",
    amount: -9.2,
    balanceAfter: 40.8,
    orderId: ORDER_ID,
    note: "Refund order bbbbbbbb",
    createdBy: "admin-owner",
    createdAt: "2026-09-10T09:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    ownerId: "agency-owner-1",
    draftId: SHOP_ID,
    accessCode: "d".repeat(32),
    status: "paid",
    subtotal: 9.2,
    deliveryFee: 0,
    total: 9.2,
    currency: "GHS",
    lines: [
      {
        itemId: "bundle-00",
        name: "MTN 1GB",
        price: 9.2,
        quantity: 1,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    customerName: "Ama Reseller",
    customerPhone: "0240000001",
    recipientPhone: "0240000001",
    paymentMethod: "agent_wallet",
    paymentMode: "test",
    paidAt: "2026-09-10T08:00:00.000Z",
    agentId: AGENT_ID,
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-10T08:00:00.000Z",
    statusHistory: [],
    ...overrides,
  };
}

function ownerStoreDefaults() {
  mocks.getShopAdminStore.mockReturnValue({
    listForDraft: vi.fn().mockResolvedValue([
      {
        id: "admin-owner",
        draftId: SHOP_ID,
        email: "owner@example.com",
        name: "Kofi",
        role: "owner",
      },
    ]),
  });
  mocks.getShopAgentStore.mockReturnValue({
    getById: vi.fn().mockResolvedValue(agent()),
    listEntries: vi.fn().mockResolvedValue([
      entry({
        kind: "credit",
        amount: 50,
        balanceAfter: 50,
        orderId: null,
        note: "Opening",
      }),
    ]),
    getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
    getEntryForOrder: vi
      .fn()
      .mockImplementation((_orderId: string, kind: string) =>
        Promise.resolve(kind === "purchase" ? entry() : null),
      ),
  });
}

function ownerOrderDetailMocks(overrides: Record<string, unknown> = {}) {
  const orderData = order(overrides);
  mocks.getOrdersStore.mockReturnValue({
    getForOwner: vi.fn().mockResolvedValue(orderData),
  });
  ownerStoreDefaults();
}

async function renderOrdersList() {
  const { default: Page } = await import("./page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

async function renderOrderDetail() {
  const { default: Page } = await import("./orders/[orderId]/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID, orderId: ORDER_ID }),
  });
  return renderToStaticMarkup(element);
}

async function renderAgentStatement() {
  const { default: Page } = await import("./agents/[agentId]/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID, agentId: AGENT_ID }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.redirect.mockImplementation(() => {});
  mocks.getShopAdminSession.mockResolvedValue(session("owner"));
  mocks.publicGetDraft.mockResolvedValue(draft());
  mocks.publicGetDraftOwnerId.mockResolvedValue("agency-owner-1");
  mocks.getBundleDeliveriesStore.mockReturnValue({
    listForOrder: vi.fn().mockResolvedValue([]),
  });
  mocks.settleAgentOrder.mockImplementation(async (value) => value);
  mocks.getOrdersStore.mockReturnValue({
    listForOwner: vi.fn().mockResolvedValue([order()]),
    listForAgent: vi.fn().mockResolvedValue([order()]),
  });
});

describe("/manage/[id] order list — the Agent badge", () => {
  it("marks wallet-paid agent orders with the badge next to the mode badge", async () => {
    const html = await renderOrdersList();
    expect(html).toContain('data-testid="shop-order-agent-badge"');
    expect(html).toContain(">Agent<");
  });

  it("leaves public orders badge-free", async () => {
    mocks.getOrdersStore.mockReturnValue({
      listForOwner: vi.fn().mockResolvedValue([
        order({
          paymentMethod: "valmont_pay",
          agentId: undefined,
          id: "public-1",
        }),
      ]),
      listForAgent: vi.fn().mockResolvedValue([]),
    });
    const html = await renderOrdersList();
    expect(html).not.toContain('data-testid="shop-order-agent-badge"');
  });
});

describe("/manage/[id]/orders/[orderId] — the wallet-paid order page", () => {
  it("settles the order on load and says who paid, with the agent link, for the owner", async () => {
    ownerOrderDetailMocks();
    const html = await renderOrderDetail();
    expect(mocks.settleAgentOrder).toHaveBeenCalled();
    expect(html).toContain('data-testid="shop-order-agent"');
    expect(html).toContain("Paid from agent wallet - Ama Reseller");
    expect(html).toContain('data-testid="shop-order-agent-link"');
    expect(html).toContain(`/manage/${SHOP_ID}/agents/${AGENT_ID}`);
    // The raw machine string never reaches the owner's eyes.
    expect(html).toContain("Agent wallet");
    expect(html).not.toContain(">agent_wallet<");
  });

  it("shows Refund to wallet only to the owner, only while refundable", async () => {
    ownerOrderDetailMocks();
    const html = await renderOrderDetail();
    expect(html).toContain('data-testid="shop-refund-wallet"');
    expect(html).toContain("Refund to wallet");

    // A member — even with every fulfil box ticked — does not get money UI.
    mocks.getShopAdminSession.mockResolvedValue(session("member"));
    ownerOrderDetailMocks();
    const memberHtml = await renderOrderDetail();
    expect(memberHtml).not.toContain('data-testid="shop-refund-wallet"');
    expect(memberHtml).not.toContain('data-testid="shop-order-agent"');
    expect(memberHtml).toContain("Agent wallet");

    // And once refunded, the button is gone; the note says who and when.
    mocks.getShopAdminSession.mockResolvedValue(session("owner"));
    ownerOrderDetailMocks({
      status: "refunded",
      refundedAt: "2026-09-10T09:00:00.000Z",
    });
    mocks.getShopAgentStore.mockReturnValue({
      getById: vi.fn().mockResolvedValue(agent()),
      getEntryForOrder: vi.fn().mockImplementation((_o: string, kind: string) =>
        Promise.resolve(
          kind === "purchase"
            ? entry()
            : entry({
                kind: "refund",
                amount: 9.2,
                balanceAfter: 50,
                createdBy: "admin-owner",
              }),
        ),
      ),
    });
    const refundedHtml = await renderOrderDetail();
    expect(refundedHtml).not.toContain('data-testid="shop-refund-wallet"');
    expect(refundedHtml).toContain('data-testid="shop-order-refund-note"');
    expect(refundedHtml).toContain("Refunded to wallet on");
    expect(refundedHtml).toContain("by Kofi");
    expect(refundedHtml).toContain("Refunded");
  });

  it("public orders never gain the agent block or the refund button", async () => {
    ownerOrderDetailMocks({
      paymentMethod: "valmont_pay",
      agentId: undefined,
      status: "paid",
    });
    const html = await renderOrderDetail();
    expect(html).not.toContain('data-testid="shop-order-agent"');
    expect(html).not.toContain('data-testid="shop-refund-wallet"');
    expect(html).not.toContain('data-testid="shop-order-refund-note"');
  });
});

describe("/manage/[id]/agents/[agentId] — statement links and Orders section", () => {
  it("order-bound entries link to the order and the Orders section lists agent orders", async () => {
    mocks.getShopAgentStore.mockReturnValue({
      getById: vi.fn().mockResolvedValue(agent()),
      listEntries: vi.fn().mockResolvedValue([
        entry(),
        entry({
          id: "entry-2",
          kind: "refund",
          amount: 9.2,
          balanceAfter: 50,
          note: "Refund order bbbbbbbb",
        }),
        entry({
          id: "entry-3",
          kind: "credit",
          amount: 50,
          balanceAfter: 50,
          orderId: null,
          note: "Opening credit",
        }),
      ]),
      getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
    });
    const html = await renderAgentStatement();
    expect(
      html.match(/data-testid="shop-agent-entry-order-link"/g) ?? [],
    ).toHaveLength(2);
    expect(html).toContain(`Purchase - Order ${ORDER_ID.slice(0, 8)}`);
    expect(html).toContain(`Refund - Order ${ORDER_ID.slice(0, 8)}`);
    expect(html).toContain(`/manage/${SHOP_ID}/orders/${ORDER_ID}`);
    // The free-text-credit row keeps its plain note.
    expect(html).toContain("Opening credit");
    // The Orders section asks the store for THIS agent's orders (R9 read).
    expect(html).toContain('data-testid="shop-agent-order-row"');
    expect(html).toContain("MTN 1GB");
    expect(html).toContain("Paid");
    expect(html).toContain("GH₵9.20");
    const store = mocks.getOrdersStore.mock.results.at(-1)!.value as {
      listForOwner: ReturnType<typeof vi.fn>;
    };
    expect(store.listForOwner).toHaveBeenCalledWith("agency-owner-1", {
      draftId: SHOP_ID,
      agentId: AGENT_ID,
      limit: 50,
    });
  });

  it("shows the empty Orders state when the agent has never bought", async () => {
    mocks.getOrdersStore.mockReturnValue({
      listForOwner: vi.fn().mockResolvedValue([]),
    });
    mocks.getShopAgentStore.mockReturnValue({
      getById: vi.fn().mockResolvedValue(agent()),
      listEntries: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
    });
    const html = await renderAgentStatement();
    expect(html).toContain('data-testid="shop-agent-orders-empty"');
  });
});
