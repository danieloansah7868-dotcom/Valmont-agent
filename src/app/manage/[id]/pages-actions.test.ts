/**
 * Stage 6c — the shop admin ACTION surfaces as markup.
 *
 * What these tests promise that no API test can prove:
 *
 *  - the order page shows the mark / retry / check-status buttons only for a
 *    login with the "orders.fulfil" box — a member without it sees exactly
 *    the 6b read-only page (no buttons at all, same rows);
 *  - "Retry failed top-ups" never appears for a Starter shop, and only when
 *    a failed row exists; "Check status now" only when a processing row
 *    exists;
 *  - the layout shows "Bundles" only for logins with "bundles.manage";
 *  - the Bundles page renders its rows (price input, Save, Pause / Resume)
 *    for exactly those logins, is a 404 without the box, and replaces the
 *    toggle with "Pause is part of Auto-Dispatch Pro." on a Starter shop.
 *
 * The page itself stays read-only on load: nothing here (and nothing in the
 * component tree) runs a recheck — a member refreshing must not spend the
 * TechChief allowance.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAdminSession: vi.fn(),
  publicGetDraft: vi.fn(),
  publicGetDraftOwnerId: vi.fn(),
  getForOwner: vi.fn(),
  listForOrder: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  // The client islands (delivery actions, logout) only need a router that
  // exists for static rendering.
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

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
  publicGetDraftOwnerId: mocks.publicGetDraftOwnerId,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => ({
    getForOwner: mocks.getForOwner,
    listForOwner: vi.fn().mockResolvedValue([]),
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
const ORDER_ID = "11111111-2222-4333-8444-555555555555";
const OWNER_ID = "agency-owner-1";
const RECIPIENT = "0240000001";

function draft(plan = "auto_dispatch", category = "data-bundles") {
  return {
    id: SHOP_ID,
    ownerId: OWNER_ID,
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
        {
          id: "bundle-01",
          name: "MTN 2GB",
          price: 15,
          paused: false,
          bundle: { network: "mtn", dataMb: 2048, validity: "30 days" },
        },
      ],
    },
  };
}

function session(role: "owner" | "member", permissions: string[] = []) {
  return {
    admin: {
      id: `admin-${role}`,
      draftId: SHOP_ID,
      email: `${role}@example.com`,
      name: role === "owner" ? "Kofi" : "Staff",
      role,
      permissions,
      status: "active",
      hasPassword: true,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function order() {
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
    customerPhone: "0200000002",
    recipientPhone: RECIPIENT,
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    statusHistory: [{ status: "paid", at: "2026-09-04T11:05:00.000Z" }],
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:05:00.000Z",
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    orderId: ORDER_ID,
    lineIndex: 0,
    unitIndex: 0,
    network: "mtn",
    dataMb: 1024,
    provider: "manual",
    status: "pending",
    providerRef: null,
    recipientPhone: RECIPIENT,
    deliveredAt: null,
    lastError: null,
    attempts: 0,
    updatedAt: "2026-09-04T11:05:00.000Z",
    ...overrides,
  };
}

async function renderOrderPage() {
  const { default: Page } = await import("./orders/[orderId]/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID, orderId: ORDER_ID }),
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

async function renderBundlesPage() {
  const { default: Page } = await import("./bundles/page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
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
  mocks.listForOrder.mockResolvedValue([]);
});

describe("/manage/[id]/orders/[orderId] — the action buttons (Stage 6c)", () => {
  it("shows Mark delivered / Mark failed on a pending manual row for the owner", async () => {
    mocks.listForOrder.mockResolvedValue([
      delivery({ provider: "manual", status: "pending" }),
    ]);
    const html = await renderOrderPage();

    expect(html).toContain('data-testid="shop-mark-delivered"');
    expect(html).toContain('data-testid="shop-mark-failed"');
    expect(html).toContain("Mark delivered");
    expect(html).toContain("Mark failed");
    // No failed and no processing rows: neither order-level button exists.
    expect(html).not.toContain("shop-retry-deliveries");
    expect(html).not.toContain("shop-recheck-deliveries");
    expect(html).not.toContain("Check status now");
  });

  it("shows Mark delivered (only) on a failed row of any provider", async () => {
    mocks.listForOrder.mockResolvedValue([
      delivery({
        provider: "techchief",
        status: "failed",
        lastError: "no float",
      }),
    ]);
    const html = await renderOrderPage();

    expect(html).toContain('data-testid="shop-mark-delivered"');
    expect(html).not.toContain('data-testid="shop-mark-failed"');
    // A failed row on an Auto-Dispatch shop also unlocks Retry.
    expect(html).toContain('data-testid="shop-retry-deliveries"');
    expect(html).toContain("Retry failed top-ups");
  });

  it("shows Check status now only while a row is processing", async () => {
    mocks.listForOrder.mockResolvedValue([
      delivery({ provider: "techchief", status: "processing" }),
    ]);
    const html = await renderOrderPage();

    expect(html).toContain('data-testid="shop-recheck-deliveries"');
    expect(html).toContain("Check status now");
    // No mark buttons on an automatic in-flight row.
    expect(html).not.toContain('data-testid="shop-mark-delivered"');
    expect(html).not.toContain('data-testid="shop-mark-failed"');
    expect(html).not.toContain("shop-retry-deliveries");
  });

  it("never shows Retry on a Starter shop, even with a failed row", async () => {
    mocks.publicGetDraft.mockResolvedValue(draft("starter"));
    mocks.listForOrder.mockResolvedValue([
      delivery({ provider: "manual", status: "failed" }),
    ]);
    const html = await renderOrderPage();

    expect(html).not.toContain("shop-retry-deliveries");
    expect(html).not.toContain("Retry failed top-ups");
    // Marking by hand is exactly what the failed manual row needs.
    expect(html).toContain('data-testid="shop-mark-delivered"');
  });

  it("a member without orders.fulfil sees exactly the 6b read-only page", async () => {
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["bundles.manage"]),
    );
    mocks.listForOrder.mockResolvedValue([
      delivery({ provider: "manual", status: "pending" }),
      delivery({
        id: "row-2",
        provider: "techchief",
        status: "failed",
        unitIndex: 1,
      }),
      delivery({
        id: "row-3",
        provider: "techchief",
        status: "processing",
        unitIndex: 2,
      }),
    ]);
    const html = await renderOrderPage();

    // Same rows, same words as 6b — and none of the action buttons.
    expect(html).toContain("To send by hand");
    expect(html).toContain('data-testid="shop-delivery-panel"');
    for (const testId of [
      "shop-mark-delivered",
      "shop-mark-failed",
      "shop-retry-deliveries",
      "shop-recheck-deliveries",
    ]) {
      expect(html).not.toContain(`data-testid="${testId}"`);
    }
    expect(html).not.toContain("Mark delivered");
    expect(html).not.toContain("Retry failed top-ups");
    expect(html).not.toContain("Check status now");
  });

  it("a member WITH orders.fulfil gets the buttons", async () => {
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["orders.fulfil"]),
    );
    mocks.listForOrder.mockResolvedValue([
      delivery({ provider: "manual", status: "pending" }),
    ]);
    const html = await renderOrderPage();

    expect(html).toContain('data-testid="shop-mark-delivered"');
    expect(html).toContain('data-testid="shop-mark-failed"');
  });

  it("the page load itself never runs a recheck (no engine call on render)", async () => {
    mocks.listForOrder.mockResolvedValue([
      delivery({ provider: "techchief", status: "processing" }),
    ]);
    await renderOrderPage();
    // Only the row list is read; no recheck, no engine, no fetch.
    expect(mocks.listForOrder).toHaveBeenCalledTimes(1);
  });
});

describe("/manage/[id] layout — the Bundles nav link (Stage 6c)", () => {
  it("shows Bundles for the owner", async () => {
    const html = await renderLayout();
    expect(html).toContain('data-testid="shop-admin-bundles-link"');
    expect(html).toContain("Bundles");
  });

  it("shows Bundles for a member with the box, hides it without", async () => {
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["bundles.manage"]),
    );
    expect(await renderLayout()).toContain(
      'data-testid="shop-admin-bundles-link"',
    );

    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["orders.fulfil"]),
    );
    expect(await renderLayout()).not.toContain(
      'data-testid="shop-admin-bundles-link"',
    );
  });
});

describe("/manage/[id]/bundles (Stage 6c)", () => {
  it("renders one row per bundle with the price input, Save and Pause toggle", async () => {
    const html = await renderBundlesPage();

    expect(html).toContain('data-testid="shop-bundle-row"');
    expect(html).toContain('data-testid="shop-bundle-price"');
    expect(html).toContain('data-testid="shop-bundle-save"');
    expect(html).toContain('data-testid="shop-bundle-pause"');
    expect(html).toContain("MTN 1GB");
    expect(html).toContain("Pause");
  });

  it("is a 404 for a login without the bundles.manage box", async () => {
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["orders.fulfil"]),
    );
    await expect(renderBundlesPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("replaces the toggle with the package sentence on a Starter shop", async () => {
    mocks.publicGetDraft.mockResolvedValue(draft("starter"));
    const html = await renderBundlesPage();

    expect(html).toContain("Pause is part of Auto-Dispatch Pro.");
    expect(html).not.toContain('data-testid="shop-bundle-pause"');
    // The price input and Save stay: prices are allowed on every package.
    expect(html).toContain('data-testid="shop-bundle-price"');
    expect(html).toContain('data-testid="shop-bundle-save"');
  });

  it("is a 404 for a website that is not a bundle shop", async () => {
    mocks.publicGetDraft.mockResolvedValue(
      draft("auto_dispatch", "restaurant"),
    );
    await expect(renderBundlesPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("never renders anything from the brief beyond the catalogue projection", async () => {
    mocks.publicGetDraft.mockResolvedValue({
      ...draft(),
      brief: {
        ...draft().brief,
        adminEmail: "secret-owner@adom.example",
        payments: {
          enabled: true,
          methods: ["valmont_pay"],
          valmontPay: { provisioned: true, apiKey: "VP-SECRET-KEY" },
        },
      },
    });
    const html = await renderBundlesPage();

    expect(html).not.toContain("secret-owner@adom.example");
    expect(html).not.toContain("VP-SECRET-KEY");
    expect(html).not.toContain("adminEmail");
  });
});
