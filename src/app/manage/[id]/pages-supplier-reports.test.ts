/**
 * Stage 6d — the Supplier page and the Reports page as markup, modelled on
 * 6c's `pages-actions.test.ts`.
 *
 * What these render tests promise that no API test can prove:
 *
 *  - /manage/[id]/supplier exists only for a login holding the
 *    supplier.manage box, on a data-bundles website whose package includes
 *    the supplier page (Starter has no such page — a 404, exactly like a
 *    stranger gets), and the page never calls TechChief (it only ever reads
 *    the stored integration record);
 *  - the connected card shows the balance, the status pill, the key prefix
 *    (9 characters, rendered with trailing bullets), the last-checked time,
 *    the hourly requests used and the bundle count; the low-balance banner
 *    appears only when the wallet is flagged low and the error card only for
 *    an error status; a shop with no key sees the not-connected card;
 *  - the "second supplier (backup)" card exists only on Command Center —
 *    nothing of it leaks to Auto-Dispatch;
 *  - /manage/[id]/reports exists only on Command Center (the package gate)
 *    for logins with the reports.view box, and renders ONLY aggregates — no
 *    customer name, phone number or order id anywhere in the HTML;
 *  - the layout shows the Supplier / Reports nav links under exactly the
 *    same two gates as their pages.
 *
 * The numbers on the reports page are produced by the REAL
 * `aggregateShopReport`; only the delivery-row loader is mocked, so the page
 * markup is pinned to the unit-tested money definitions end to end.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAdminSession: vi.fn(),
  publicGetDraft: vi.fn(),
  publicGetDraftOwnerId: vi.fn(),
  listForOwner: vi.fn(),
  loadDeliveriesForReport: vi.fn(),
  getTechChiefIntegration: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
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
    listForOwner: mocks.listForOwner,
  }),
}));

vi.mock("@/lib/studio/integrations", () => ({
  TECHCHIEF_HOURLY_LIMIT: 60,
  getTechChiefIntegration: mocks.getTechChiefIntegration,
}));

// The delivery-row loader owns a real SQLite/PostgreSQL read; the page test
// swaps only that read for a fixture while the aggregate maths stay real.
vi.mock("@/lib/shop-admin/reports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/shop-admin/reports")>();
  return {
    ...actual,
    loadDeliveriesForReport: mocks.loadDeliveriesForReport,
  };
});

const SHOP_ID = "aaaaaaaa-1111-4222-8333-444444444444";
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

/** A StudioIntegration record — no secret fields exist on it by design. */
function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "integration-1",
    draftId: SHOP_ID,
    ownerId: OWNER_ID,
    provider: "techchief",
    keyPrefix: "TCHX-AB12",
    webhookSecretSet: true,
    status: "verified",
    lastCheckedAt: "2026-09-09T08:00:00.000Z",
    walletBalance: 123.45,
    lowBalance: false,
    accountStatus: "active",
    lastError: undefined,
    bundles: [
      {
        id: 11,
        network: "mtn",
        sizeGb: 1,
        validityDays: 7,
        price: 8.5,
        currency: "GHS",
      },
    ],
    bundlesSyncedAt: "2026-09-09T07:00:00.000Z",
    pollWindowStart: "2026-09-09T07:30:00.000Z",
    pollCount: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-09T08:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-11111111-2222-4333-8444-555555555555",
    ownerId: OWNER_ID,
    draftId: SHOP_ID,
    accessCode: "acc-secret-123",
    status: "paid",
    currency: "GHS",
    subtotal: 10,
    deliveryFee: 0,
    total: 10,
    lines: [
      {
        itemId: "bundle-00",
        name: "MTN 1GB",
        price: 10,
        quantity: 1,
        bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
      },
    ],
    customerName: "Kwame Buyer",
    customerPhone: "0200000002",
    recipientPhone: RECIPIENT,
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    paidAt: "2026-09-09T06:00:00.000Z",
    statusHistory: [{ status: "paid", at: "2026-09-09T06:00:00.000Z" }],
    createdAt: "2026-09-09T05:00:00.000Z",
    updatedAt: "2026-09-09T06:00:00.000Z",
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-11111111-2222-4333-8444-555555555555",
    lineIndex: 0,
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    status: "delivered",
    apiPrice: 4.5,
    ...overrides,
  };
}

async function renderSupplierPage() {
  const { default: Page } = await import("./supplier/page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

async function renderReportsPage(range?: string) {
  const { default: Page } = await import("./reports/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID }),
    searchParams: Promise.resolve(range ? { range } : {}),
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
  mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
  mocks.publicGetDraftOwnerId.mockResolvedValue(OWNER_ID);
  mocks.getTechChiefIntegration.mockResolvedValue(null);
  mocks.listForOwner.mockResolvedValue([]);
  mocks.loadDeliveriesForReport.mockResolvedValue([]);
});

describe("/manage/[id]/supplier — the page (Stage 6d)", () => {
  it("shows the connected card: balance, status, 9-character key prefix, last checked, requests and bundles", async () => {
    mocks.getTechChiefIntegration.mockResolvedValue(integration());
    const html = await renderSupplierPage();

    expect(html).toContain("GHS 123.45");
    expect(html).toContain('data-testid="shop-supplier-status"');
    expect(html).toContain("Connected");
    expect(html).toContain('data-testid="shop-supplier-key-prefix"');
    expect(html).toContain("TCHX-AB12•••");
    expect(html).toContain('data-testid="shop-supplier-last-checked"');
    expect(html).toContain('data-testid="shop-supplier-requests"');
    expect(html).toContain("Requests used this hour: 3 of 60");
    expect(html).toContain('data-testid="shop-supplier-bundles"');
    expect(html).toContain("1 available");
    expect(html).toContain('data-testid="shop-supplier-refresh"');
    expect(html).toContain("Refresh balance");
    expect(html).toContain('data-testid="shop-supplier-topup-link"');
    expect(html).toContain("Top up at TechChief");

    // The ONLY part of the key on the page is the stored 9-character prefix.
    expect(html).not.toContain("AB12Cd");
    expect(html).not.toContain("TCHX-AB12Cd34Ef56Gh78");
    // No low-balance banner (not flagged) and no error card (not an error).
    expect(html).not.toContain('data-testid="shop-supplier-low-balance"');
    expect(html).not.toContain('data-testid="shop-supplier-error"');
  });

  it("shows the low-balance banner only when the wallet is flagged low", async () => {
    mocks.getTechChiefIntegration.mockResolvedValue(
      integration({ lowBalance: true }),
    );
    const html = await renderSupplierPage();
    expect(html).toContain('data-testid="shop-supplier-low-balance"');
    // React escapes the apostrophe in the sentence; assert the unescaped part.
    expect(html).toContain(
      "Your TechChief wallet is low - top up before customers",
    );
    expect(html).toContain("&#x27; top-ups start failing.");
  });

  it("shows the error card when the connection status is error", async () => {
    mocks.getTechChiefIntegration.mockResolvedValue(
      integration({
        status: "error",
        lastError: "TechChief rejected this key.",
      }),
    );
    const html = await renderSupplierPage();
    expect(html).toContain('data-testid="shop-supplier-error"');
    expect(html).toContain("TechChief rejected this key.");
    expect(html).toContain("Ask your agency to save a new key in Studio.");
  });

  it("shows the not-connected card when no key is saved", async () => {
    const html = await renderSupplierPage();
    expect(html).toContain('data-testid="shop-supplier-not-connected"');
    expect(html).toContain(
      "No supplier key is connected yet. Ask your agency to connect your TechChief key in Studio.",
    );
    expect(html).not.toContain('data-testid="shop-supplier-balance"');
    expect(html).not.toContain('data-testid="shop-supplier-refresh"');
    // The top-up link still tells the owner where to top up once connected.
    expect(html).toContain('data-testid="shop-supplier-topup-link"');
  });

  it("the page never renders the webhook URL or any secret field", async () => {
    mocks.getTechChiefIntegration.mockResolvedValue(integration());
    const html = await renderSupplierPage();
    expect(html).not.toContain("webhook");
    expect(html).not.toContain("apiKey");
    expect(html).not.toContain("api_key");
    expect(html).not.toContain("ownerId");
    expect(html).not.toContain(OWNER_ID);
  });

  it("the page only reads the stored record — getTechChiefIntegration is the single read", async () => {
    mocks.getTechChiefIntegration.mockResolvedValue(integration());
    await renderSupplierPage();
    expect(mocks.getTechChiefIntegration).toHaveBeenCalledTimes(1);
  });

  it("the second-supplier (backup) card appears only on Command Center", async () => {
    mocks.getTechChiefIntegration.mockResolvedValue(integration());
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    const commandCenterHtml = await renderSupplierPage();
    expect(commandCenterHtml).toContain('data-testid="shop-supplier-second"');
    expect(commandCenterHtml).toContain("Second supplier (backup)");

    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    const autoHtml = await renderSupplierPage();
    expect(autoHtml).not.toContain('data-testid="shop-supplier-second"');
    expect(autoHtml).not.toContain("Second supplier");
    // Starter has no supplier page at all (a 404 — covered below).
  });

  it("is a 404 without the supplier.manage box, on Starter, and for non-bundle websites", async () => {
    // Member without the box — even with every other box ticked.
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["orders.fulfil", "reports.view"]),
    );
    await expect(renderSupplierPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();

    // Owner on Starter: the page does not exist on that package.
    mocks.getShopAdminSession.mockResolvedValue(session("owner"));
    mocks.publicGetDraft.mockResolvedValue(draft("starter"));
    await expect(renderSupplierPage()).rejects.toThrow("NEXT_NOT_FOUND");

    // A restaurant website has no supplier page either.
    mocks.publicGetDraft.mockResolvedValue(
      draft("command_center", "restaurant"),
    );
    await expect(renderSupplierPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders for a member WITH the supplier.manage box", async () => {
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["supplier.manage"]),
    );
    mocks.getTechChiefIntegration.mockResolvedValue(integration());
    const html = await renderSupplierPage();
    expect(html).toContain("GHS 123.45");
    expect(html).toContain('data-testid="shop-supplier-refresh"');
  });
});

describe("/manage/[id]/reports — the page (Stage 6d)", () => {
  it("renders the tiles and range links for a Command Center owner", async () => {
    const html = await renderReportsPage();

    expect(html).toContain("Sales &amp; margin");
    expect(html).toContain('data-testid="shop-reports-orders"');
    expect(html).toContain('data-testid="shop-reports-revenue"');
    expect(html).toContain('data-testid="shop-reports-cost"');
    expect(html).toContain('data-testid="shop-reports-margin"');
    expect(html).toContain('data-testid="shop-reports-topups"');
    // Four range links; the default (30 days) is marked active.
    expect(html).toContain('data-testid="shop-reports-range"');
    expect(html).toContain("Today");
    expect(html).toContain("7 days");
    expect(html).toContain("30 days");
    expect(html).toContain("This month");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("?range=30d");
  });

  it("shows the aggregates of the real maths over the fixture rows", async () => {
    mocks.listForOwner.mockResolvedValue([order()]);
    mocks.loadDeliveriesForReport.mockResolvedValue([
      delivery(),
      delivery({
        status: "delivered",
        apiPrice: null,
        network: "telecel",
        dataMb: 2048,
        itemName: "Telecel 2GB",
      }),
    ]);
    const html = await renderReportsPage();

    // 1 paid order × GH₵10, 1 costed row costs 4.5 → margin GH₵5.50 (55%).
    expect(html).toContain('data-testid="shop-reports-orders">1</dd>');
    expect(html).toContain("GH₵10.00");
    expect(html).toContain("GH₵4.50");
    expect(html).toContain("GH₵5.50");
    expect(html).toContain("(55.00%)");
    expect(html).toContain("Delivered 2 · Failed 0 · In flight 0");
    expect(html).toContain("Cost known for 1 of 2 delivered top-ups.");
    expect(html).toContain(
      "Top-ups sent by hand or in test mode have no supplier cost recorded.",
    );
  });

  it("only ever renders aggregates — no name, phone, code or order id", async () => {
    mocks.listForOwner.mockResolvedValue([
      order({
        customerName: "Kwame Buyer",
        customerPhone: "0200000002",
        accessCode: "acc-secret-123",
      }),
    ]);
    mocks.loadDeliveriesForReport.mockResolvedValue([delivery()]);
    const html = await renderReportsPage();

    expect(html).not.toContain("Kwame Buyer");
    expect(html).not.toContain("0200000002");
    expect(html).not.toContain(RECIPIENT);
    expect(html).not.toContain("acc-secret-123");
    expect(html).not.toContain("order-11111111-2222-4333-8444-555555555555");
  });

  it("lists network and bundle rows with their delivered counts", async () => {
    mocks.listForOwner.mockResolvedValue([order()]);
    mocks.loadDeliveriesForReport.mockResolvedValue([
      delivery(),
      delivery({ status: "failed" }),
    ]);
    const html = await renderReportsPage();

    expect(html).toContain('data-testid="shop-reports-network-row"');
    expect(html).toContain('data-testid="shop-reports-bundle-row"');
    expect(html).toContain("MTN");
    expect(html).toContain("MTN 1GB");
    expect(html).toContain("By network");
    expect(html).toContain("By bundle");
  });

  it("an empty period is all zeros with the empty sentence", async () => {
    const html = await renderReportsPage();
    expect(html).toContain('data-testid="shop-reports-empty"');
    expect(html).toContain("No paid orders in this period.");
    expect(html).toContain('data-testid="shop-reports-orders">0</dd>');
    expect(html).toContain("GH₵0.00");
    expect(html).toContain("Delivered 0 · Failed 0 · In flight 0");
  });

  it("is a 404 without the reports.view box, outside Command Center, and for non-bundle websites", async () => {
    // Member with every box except reports.view.
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["supplier.manage", "orders.fulfil"]),
    );
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    await expect(renderReportsPage()).rejects.toThrow("NEXT_NOT_FOUND");

    // An Auto-Dispatch owner cannot buy the report.
    mocks.getShopAdminSession.mockResolvedValue(session("owner"));
    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    await expect(renderReportsPage()).rejects.toThrow("NEXT_NOT_FOUND");

    // A restaurant website has no reports page.
    mocks.publicGetDraft.mockResolvedValue(
      draft("command_center", "restaurant"),
    );
    await expect(renderReportsPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders for a member WITH the reports.view box on Command Center", async () => {
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["reports.view"]),
    );
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    mocks.listForOwner.mockResolvedValue([order()]);
    const html = await renderReportsPage();
    expect(html).toContain("Sales &amp; margin");
    expect(html).toContain("GH₵10.00");
  });
});

describe("/manage/[id] layout — the Supplier and Reports nav links (Stage 6d)", () => {
  it("shows Supplier on a package that includes it, for a login with the box", async () => {
    // Owner on Auto-Dispatch (supplier_page included, reports not).
    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    const html = await renderLayout();
    expect(html).toContain('data-testid="shop-admin-supplier-link"');
    expect(html).toContain("Supplier");
    expect(html).not.toContain('data-testid="shop-admin-reports-link"');
  });

  it("shows Reports on Command Center for a login with the reports.view box", async () => {
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    const html = await renderLayout();
    expect(html).toContain('data-testid="shop-admin-supplier-link"');
    expect(html).toContain('data-testid="shop-admin-reports-link"');
    expect(html).toContain("Reports");
  });

  it("member matrix: the box grants the link only when the package includes the page", async () => {
    // Member with the box on Command Center: both links.
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["supplier.manage", "reports.view"]),
    );
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    const commandHtml = await renderLayout();
    expect(commandHtml).toContain('data-testid="shop-admin-supplier-link"');
    expect(commandHtml).toContain('data-testid="shop-admin-reports-link"');

    // Member with only supplier.manage: Supplier yes, Reports no.
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["supplier.manage"]),
    );
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    const supplierOnly = await renderLayout();
    expect(supplierOnly).toContain('data-testid="shop-admin-supplier-link"');
    expect(supplierOnly).not.toContain('data-testid="shop-admin-reports-link"');

    // Member with only reports.view on Auto-Dispatch: neither link exists
    // (the package has no supplier-page-less gap — the link needs both).
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["reports.view"]),
    );
    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    const reportsOnly = await renderLayout();
    expect(reportsOnly).not.toContain('data-testid="shop-admin-supplier-link"');
    expect(reportsOnly).not.toContain('data-testid="shop-admin-reports-link"');

    // Member with the boxes but on Starter: no links.
    mocks.publicGetDraft.mockResolvedValue(draft("starter"));
    const starterHtml = await renderLayout();
    expect(starterHtml).not.toContain('data-testid="shop-admin-supplier-link"');
    expect(starterHtml).not.toContain('data-testid="shop-admin-reports-link"');

    // Member without either box: no links.
    mocks.getShopAdminSession.mockResolvedValue(
      session("member", ["orders.fulfil"]),
    );
    mocks.publicGetDraft.mockResolvedValue(draft("command_center"));
    const noBoxHtml = await renderLayout();
    expect(noBoxHtml).not.toContain('data-testid="shop-admin-supplier-link"');
    expect(noBoxHtml).not.toContain('data-testid="shop-admin-reports-link"');
  });
});
