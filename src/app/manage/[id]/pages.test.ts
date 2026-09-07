/**
 * Stage 6b — the shop admin pages as markup.
 *
 * Three things the pages promise that no API test can prove:
 *
 *  - the order page shows the recipient's number IN FULL (this is the person
 *    who has to send the bundle), while the customer's own `/account/orders`
 *    page — tested in `src/app/account/orders/[id]/page.test.ts` — keeps it
 *    masked;
 *  - the Team page is a 404 for a member, not a "you may not" screen;
 *  - the admin frame is its own layout: no agency navigation, the shop's name
 *    and package in the header, and the Team link only for the owner.
 *
 * Reads are pinned to the website: an order of a sibling website that the
 * same agency user owns is a 404 on this shop's order page.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAdminSession: vi.fn(),
  publicGetDraft: vi.fn(),
  publicGetDraftOwnerId: vi.fn(),
  getForOwner: vi.fn(),
  listForOwner: vi.fn(),
  listForOrder: vi.fn(),
  listForDraft: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  // The Logout button in the layout is a client component; static rendering
  // only needs a router that exists.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The real `requireShopAdminSession` on top of a mocked cookie read, so the
// redirect-to-login behaviour is the production one.
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

vi.mock("@/lib/shop-admin/store", () => ({
  getShopAdminStore: () => ({ listForDraft: mocks.listForDraft }),
}));

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
  publicGetDraftOwnerId: mocks.publicGetDraftOwnerId,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => ({
    getForOwner: mocks.getForOwner,
    listForOwner: mocks.listForOwner,
  }),
}));

vi.mock("@/lib/studio/bundle-delivery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/studio/bundle-delivery")>();
  return {
    ...actual,
    getBundleDeliveriesStore: () => ({ listForOrder: mocks.listForOrder }),
  };
});

const SHOP_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const OTHER_SHOP_ID = "bbbbbbbb-1111-4222-8333-444444444444";
const ORDER_ID = "11111111-2222-4333-8444-555555555555";
const OWNER_ID = "agency-owner-1";
const RECIPIENT = "0240000001";
const BUYER = "0200000002";

function draft(plan = "auto_dispatch") {
  return {
    id: SHOP_ID,
    ownerId: OWNER_ID,
    brief: { businessName: "Data GH", category: "data-bundles", plan },
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
      permissions: [],
      status: "active",
      hasPassword: true,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    ownerId: OWNER_ID,
    draftId: SHOP_ID,
    status: "paid",
    currency: "GHS",
    subtotal: 20,
    deliveryFee: 0,
    total: 20,
    lines: [
      {
        itemId: "bundle-00",
        name: "MTN 1GB",
        price: 10,
        quantity: 2,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    customerName: "Kwame Buyer",
    customerPhone: BUYER,
    recipientPhone: RECIPIENT,
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    statusHistory: [{ status: "paid", at: "2026-09-04T11:05:00.000Z" }],
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:05:00.000Z",
    ...overrides,
  };
}

async function renderOrderPage(orderId = ORDER_ID) {
  const { default: Page } = await import("./orders/[orderId]/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID, orderId }),
  });
  return renderToStaticMarkup(element);
}

async function renderOrdersList(filter?: string) {
  const { default: Page } = await import("./page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID }),
    searchParams: Promise.resolve(filter ? { filter } : {}),
  });
  return renderToStaticMarkup(element);
}

async function renderLayout() {
  const { default: Layout } = await import("./layout");
  const element = await Layout({
    params: Promise.resolve({ id: SHOP_ID }),
    children: null,
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
  mocks.publicGetDraftOwnerId.mockResolvedValue(OWNER_ID);
  mocks.getForOwner.mockResolvedValue(order());
  mocks.listForOwner.mockResolvedValue([order()]);
  mocks.listForOrder.mockResolvedValue([]);
  mocks.listForDraft.mockResolvedValue([]);
});

describe("/manage/[id]/orders/[orderId]", () => {
  it("shows the recipient's full number and the delivery rows", async () => {
    mocks.listForOrder.mockResolvedValue([
      {
        id: "row-1",
        orderId: ORDER_ID,
        lineIndex: 0,
        unitIndex: 0,
        network: "mtn",
        dataMb: 1024,
        provider: "techchief",
        status: "delivered",
        providerRef: "TC-REF-123",
        recipientPhone: RECIPIENT,
        deliveredAt: "2026-09-04T11:06:00.000Z",
        attempts: 1,
      },
      {
        id: "row-2",
        orderId: ORDER_ID,
        lineIndex: 0,
        unitIndex: 1,
        network: "mtn",
        dataMb: 1024,
        provider: "manual",
        status: "pending",
        providerRef: null,
        recipientPhone: RECIPIENT,
        deliveredAt: null,
        attempts: 0,
      },
    ]);
    const html = await renderOrderPage();

    expect(html).toContain('data-testid="shop-order-recipient"');
    expect(html).toContain(RECIPIENT);
    expect(html).not.toContain("024 ••• 0001");
    expect(html).toContain(BUYER);
    expect(html).toContain("Kwame Buyer");
    expect(html).toContain("MTN 1GB × 2");
    expect(html).toContain("GH₵20.00");
    expect(html).toContain("Paid");
    expect(html).toContain('data-testid="shop-delivery-panel"');
    expect(html).toContain("TC-REF-123");
    expect(html).toContain("To send by hand");
    expect(html).toContain("unit 1 of 2");

    // Read only: none of the owner's action buttons.
    expect(html).not.toContain("Update this order");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Check status now");
    expect(mocks.getForOwner).toHaveBeenCalledWith(OWNER_ID, ORDER_ID);
  });

  it("is a 404 for an order of a sibling website of the same agency user", async () => {
    mocks.getForOwner.mockResolvedValue(order({ draftId: OTHER_SHOP_ID }));
    await expect(renderOrderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("is a 404 for an order that does not exist", async () => {
    mocks.getForOwner.mockResolvedValue(null);
    await expect(renderOrderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sends a signed-out visitor to this shop's login with a return path", async () => {
    mocks.getShopAdminSession.mockResolvedValue(null);
    await expect(renderOrderPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/manage/${SHOP_ID}/login?next=${encodeURIComponent(
        `/manage/${SHOP_ID}/orders/${ORDER_ID}`,
      )}`,
    );
    expect(mocks.getForOwner).not.toHaveBeenCalled();
  });
});

describe("/manage/[id] (orders list)", () => {
  it("always pins the list to this website and shows the filter tabs", async () => {
    const html = await renderOrdersList("paid");
    expect(mocks.listForOwner).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ draftId: SHOP_ID, filter: "all" }),
    );
    expect(mocks.listForOwner).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ draftId: SHOP_ID, filter: "paid" }),
    );
    for (const call of mocks.listForOwner.mock.calls) {
      expect(call[1]).toMatchObject({ draftId: SHOP_ID });
    }
    expect(html).toContain('data-testid="shop-orders-list"');
    expect(html).toContain("Kwame Buyer");
    expect(html).toContain(RECIPIENT);
    expect(html).toContain("MTN 1GB × 2");
    expect(html).toContain('role="tab"');
    expect(html).toContain("Pending payment");
    expect(html).toContain(`/manage/${SHOP_ID}/orders/${ORDER_ID}`);
  });

  it("falls back to the full list for an unknown filter", async () => {
    await renderOrdersList("nonsense");
    expect(mocks.listForOwner).toHaveBeenCalledTimes(1);
    expect(mocks.listForOwner.mock.calls[0][1]).toMatchObject({
      filter: "all",
      draftId: SHOP_ID,
    });
  });
});

describe("/manage/[id]/team", () => {
  it("is a 404 for a member", async () => {
    mocks.getShopAdminSession.mockResolvedValue(session("member"));
    const { default: TeamPage } = await import("./team/page");
    await expect(
      TeamPage({ params: Promise.resolve({ id: SHOP_ID }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.listForDraft).not.toHaveBeenCalled();
  });

  it("renders the team for the owner", async () => {
    mocks.listForDraft.mockResolvedValue([
      {
        ...session("owner").admin,
        lastLoginAt: null,
        createdAt: "",
        updatedAt: "",
        invitedBy: null,
      },
    ]);
    const { default: TeamPage } = await import("./team/page");
    const html = renderToStaticMarkup(
      await TeamPage({ params: Promise.resolve({ id: SHOP_ID }) }),
    );
    expect(html).toContain("Team");
    expect(html).toContain("Deliver orders");
    expect(html).toContain("Pause bundles &amp; change prices");
    expect(html).toContain("Supplier &amp; float");
    expect(html).toContain("Sales &amp; margin");
    expect(html).not.toContain("wallets.topup");
  });
});

describe("/manage/[id] layout", () => {
  it("is its own frame: shop name, package badge, Orders + Team for the owner, Logout", async () => {
    const html = await renderLayout();
    expect(html).toContain('data-testid="shop-admin-name"');
    expect(html).toContain("Data GH");
    expect(html).toContain("Auto-Dispatch Pro");
    expect(html).not.toContain("Manual delivery");
    expect(html).toContain('data-testid="shop-admin-team-link"');
    expect(html).toContain('data-testid="shop-logout"');
    // None of the agency shell.
    expect(html).not.toContain("Website Studio");
    expect(html).not.toContain("/studio");
    expect(html).not.toContain("/dashboard");
    expect(html).not.toContain("Approval-first");
  });

  it("says Manual delivery on a Starter Shop and hides Team from a member", async () => {
    mocks.publicGetDraft.mockResolvedValue(draft("starter"));
    mocks.getShopAdminSession.mockResolvedValue(session("member"));
    const html = await renderLayout();
    expect(html).toContain("Starter Shop · Manual delivery");
    expect(html).not.toContain('data-testid="shop-admin-team-link"');
    expect(html).toContain('data-testid="shop-logout"');
  });

  it("shows no nav or Logout when nobody is signed in", async () => {
    mocks.getShopAdminSession.mockResolvedValue(null);
    const html = await renderLayout();
    expect(html).toContain("Data GH");
    expect(html).not.toContain('data-testid="shop-logout"');
    expect(html).not.toContain('data-testid="shop-admin-team-link"');
  });

  it("is a 404 for an unknown website", async () => {
    mocks.publicGetDraft.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getShopAdminSession).not.toHaveBeenCalled();
  });
});
