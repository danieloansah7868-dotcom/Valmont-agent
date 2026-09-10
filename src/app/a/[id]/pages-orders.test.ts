/**
 * Stage 7b — agent portal: the layout Orders link, the wallet statement's
 * order-bound rows, the orders list page, and the order detail page.
 *
 * The pages are rendered against mocked store seams (session, agent store,
 * orders store, delivery engine) — every assertion is about what the page
 * does with the data it is handed: scoping, testids, and that another
 * agent's order is a 404 (R9).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAgentSession: vi.fn(),
  publicGetDraft: vi.fn(),
  getShopAgentStore: vi.fn(),
  getOrdersStore: vi.fn(),
  settleAgentOrder: vi.fn(),
  recheckBundleDeliveriesForOrder: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/shop-agent/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shop-agent/auth")>();
  return {
    ...actual,
    getShopAgentSession: mocks.getShopAgentSession,
    requireShopAgentSession: async (draftId: string, next?: string) => {
      const session = await mocks.getShopAgentSession(draftId);
      if (!session) {
        mocks.redirect(
          `/a/${draftId}/login?next=${encodeURIComponent(next ?? "")}`,
        );
        throw new Error("NEXT_REDIRECT");
      }
      return session;
    },
  };
});

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
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
  recheckBundleDeliveriesForOrder: mocks.recheckBundleDeliveriesForOrder,
}));

const SHOP_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const ORDER_ID = "bbbbbbbb-2222-4333-8444-555555555555";

function draft(plan = "command_center", category = "data-bundles") {
  return {
    id: SHOP_ID,
    ownerId: "agency-owner-1",
    brief: {
      businessName: "Data GH",
      category,
      plan,
      items: [
        {
          id: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
      ],
    },
  };
}

function session() {
  return {
    agent: {
      id: "agent-1",
      draftId: SHOP_ID,
      email: "agent@example.com",
      name: "Reseller",
      phone: "0240000009",
      status: "active",
      balance: 40.8,
      hasPassword: true,
      invitedBy: "owner",
      lastLoginAt: "2026-09-10T08:00:00.000Z",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-10T08:00:00.000Z",
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function walletEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    draftId: SHOP_ID,
    agentId: "agent-1",
    kind: "credit",
    amount: 50,
    balanceAfter: 50,
    orderId: null,
    note: "Opening credit",
    createdBy: "owner",
    createdAt: "2026-09-09T08:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    ownerId: "agency-owner-1",
    draftId: SHOP_ID,
    accessCode: "f".repeat(32),
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
    customerName: "Reseller",
    customerPhone: "0240000009",
    recipientPhone: "0240000001",
    paymentMethod: "agent_wallet",
    paymentMode: "test",
    paidAt: "2026-09-10T08:00:00.000Z",
    agentId: "agent-1",
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-10T08:00:00.000Z",
    statusHistory: [],
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "del-1",
    orderId: ORDER_ID,
    ownerId: "agency-owner-1",
    lineIndex: 0,
    unitIndex: 0,
    itemId: "bundle-00",
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    validity: "7 days",
    recipientPhone: "0240000001",
    provider: "simulator",
    status: "delivered",
    attempts: 1,
    deliveredAt: "2026-09-10T08:01:00.000Z",
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-10T08:01:00.000Z",
    ...overrides,
  };
}

async function renderLayout() {
  const { default: Layout } = await import("./layout");
  const element = await Layout({
    params: Promise.resolve({ id: SHOP_ID }),
    children: null,
  });
  return renderToStaticMarkup(element);
}

async function renderHome() {
  const { default: Page } = await import("./page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

async function renderWallet() {
  const { default: Page } = await import("./wallet/page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

async function renderOrders() {
  const { default: Page } = await import("./orders/page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

async function renderOrderDetail() {
  const { default: Page } = await import("./orders/[orderId]/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID, orderId: ORDER_ID }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.redirect.mockImplementation(() => {});
  mocks.getShopAgentSession.mockResolvedValue(session());
  mocks.publicGetDraft.mockResolvedValue(draft());
  mocks.getShopAgentStore.mockReturnValue({
    getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
    listEntries: vi.fn().mockResolvedValue([walletEntry()]),
    getEntryForOrder: vi.fn().mockResolvedValue(
      walletEntry({
        kind: "purchase",
        amount: -9.2,
        balanceAfter: 40.8,
        orderId: ORDER_ID,
      }),
    ),
  });
  mocks.getOrdersStore.mockReturnValue({
    listForAgent: vi.fn().mockResolvedValue([order()]),
    getForAgent: vi.fn().mockResolvedValue(order()),
  });
  mocks.settleAgentOrder.mockImplementation(async (value) => value);
  mocks.recheckBundleDeliveriesForOrder.mockResolvedValue([delivery()]);
});

describe("/a/[id] Stage 7b navigation and home page", () => {
  it("the layout gains an Orders link when the agent is signed in", async () => {
    const html = await renderLayout();
    expect(html).toContain('data-testid="agent-nav-orders"');
    expect(html).toContain(`/a/${SHOP_ID}/orders`);
  });

  it("signed-out navigation still renders without the Orders link", async () => {
    mocks.getShopAgentSession.mockResolvedValue(null);
    const html = await renderLayout();
    expect(html).not.toContain('data-testid="agent-nav-orders"');
  });

  it("every bundle row now sports its buy button, keyed by the item id", async () => {
    const html = await renderHome();
    expect(html).toContain('data-testid="agent-buy-open"');
    // The 7a read-out is intact next to it.
    expect(html).toContain('data-testid="agent-bundle-price"');
  });
});

describe("/a/[id]/wallet statement — order-bound rows", () => {
  it("credit rows stay exactly as they were", async () => {
    const html = await renderWallet();
    expect(html).toContain("Credit added");
    expect(html).not.toContain('data-testid="agent-entry-order-link"');
  });

  it("a purchase row reads Purchase - Order xxxxxxxx and links to the order", async () => {
    mocks.getShopAgentStore.mockReturnValue({
      getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
      listEntries: vi.fn().mockResolvedValue([
        walletEntry({
          kind: "purchase",
          amount: -9.2,
          balanceAfter: 40.8,
          orderId: ORDER_ID,
        }),
      ]),
    });
    const html = await renderWallet();
    expect(html).toContain(`Purchase - Order ${ORDER_ID.slice(0, 8)}`);
    expect(html).toContain('data-testid="agent-entry-order-link"');
    expect(html).toContain(`/a/${SHOP_ID}/orders/${ORDER_ID}`);
  });

  it("a refund row reads Refund - Order xxxxxxxx and links to the order", async () => {
    mocks.getShopAgentStore.mockReturnValue({
      getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
      listEntries: vi.fn().mockResolvedValue([
        walletEntry({
          kind: "refund",
          amount: 9.2,
          balanceAfter: 50,
          orderId: ORDER_ID,
        }),
      ]),
    });
    const html = await renderWallet();
    expect(html).toContain(`Refund - Order ${ORDER_ID.slice(0, 8)}`);
    expect(html).toContain(`/a/${SHOP_ID}/orders/${ORDER_ID}`);
  });
});

describe("/a/[id]/orders — the agent's own list (R1, R9)", () => {
  it("asks the store for THIS agent's orders and renders each row", async () => {
    const html = await renderOrders();
    expect(html).toContain('data-testid="agent-order-row"');
    expect(html).toContain("MTN 1GB");
    expect(html).toContain("GH₵9.20");
    expect(html).toContain("Paid");
    expect(html).toContain(`/a/${SHOP_ID}/orders/${ORDER_ID}`);
    expect(html).toContain("0240000001");
    const store = mocks.getOrdersStore.mock.results.at(-1)!.value as {
      listForAgent: ReturnType<typeof vi.fn>;
    };
    expect(store.listForAgent).toHaveBeenCalledWith("agent-1", 50);
  });

  it("shows the empty state when the wallet has never bought", async () => {
    mocks.getOrdersStore.mockReturnValue({
      listForAgent: vi.fn().mockResolvedValue([]),
    });
    const html = await renderOrders();
    expect(html).toContain('data-testid="agent-orders-empty"');
  });

  it("redirects an unsigned visitor to the agent login", async () => {
    mocks.getShopAgentSession.mockResolvedValue(null);
    await expect(renderOrders()).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("/a/[id]/orders/[orderId] — one order, own-copy only", () => {
  it("settles first, then shows status, total, recipient, lines and balance after", async () => {
    const html = await renderOrderDetail();
    expect(mocks.settleAgentOrder).toHaveBeenCalled();
    expect(mocks.recheckBundleDeliveriesForOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    expect(html).toContain('data-testid="agent-order-status"');
    expect(html).toContain("Paid");
    expect(html).toContain('data-testid="agent-order-total"');
    expect(html).toContain("GH₵9.20");
    expect(html).toContain('data-testid="agent-order-recipient"');
    expect(html).toContain("0240000001");
    expect(html).toContain("MTN 1GB");
    expect(html).toContain('data-testid="agent-order-balance-after"');
    expect(html).toContain("GH₵40.80");
    expect(html).toContain('data-testid="agent-delivery-row"');
    expect(html).toContain('data-testid="agent-delivery-delivered"');
    expect(html).toContain("Delivered");
    // Read-only for agents: the owner's actions never appear here.
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Mark delivered");
    expect(html).not.toContain("Check status now");
  });

  it("another agent's order is a plain 404", async () => {
    mocks.getOrdersStore.mockReturnValue({
      getForAgent: vi.fn().mockResolvedValue(null),
    });
    await expect(renderOrderDetail()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.settleAgentOrder).not.toHaveBeenCalled();
  });

  it("a refunded order says the money went back to the wallet", async () => {
    mocks.getOrdersStore.mockReturnValue({
      getForAgent: vi
        .fn()
        .mockResolvedValue(
          order({ status: "refunded", refundedAt: "2026-09-10T09:00:00.000Z" }),
        ),
    });
    mocks.getShopAgentStore.mockReturnValue({
      getSettings: vi.fn().mockResolvedValue({ discountPercent: 8 }),
      getEntryForOrder: vi.fn().mockResolvedValue(
        walletEntry({
          kind: "refund",
          amount: 9.2,
          balanceAfter: 50,
          orderId: ORDER_ID,
          createdAt: "2026-09-10T09:00:00.000Z",
        }),
      ),
    });
    const html = await renderOrderDetail();
    expect(html).toContain('data-testid="agent-order-refunded"');
    expect(html).toContain("Refunded to your wallet on");
    expect(html).toContain("Refunded");
  });
});
