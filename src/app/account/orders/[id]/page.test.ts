/**
 * Stage 4b — the delivery line on the customer's own order page.
 *
 * The guest confirmation page shows one masked aggregate line; the owner's
 * Studio page shows everything. The customer-account page sat between the two
 * and showed nothing about delivery at all, so a customer who paid for three
 * top-ups had no idea whether any of them had landed. It now shows the same
 * masked line the guest sees — and the rules that make that safe are what is
 * under test here:
 *
 *  - bundle orders only (a food shop's order page is byte-for-byte unchanged),
 *  - no full phone number, no provider reference and no provider error text,
 *  - the rows are READ, never reconciled: a customer refreshing their own order
 *    page must not be able to spend the shop's hourly TechChief allowance.
 *
 * The page is a server component, so the test calls it and renders the element
 * it returns — the markup is the contract, `data-testid` included.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCustomerSession: vi.fn(),
  publicGetDraft: vi.fn(),
  getForCustomer: vi.fn(),
  listForOrder: vi.fn(),
  recheckBundleDeliveriesForOrder: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));

vi.mock("@/lib/customer-auth", () => ({
  getCustomerSession: mocks.getCustomerSession,
}));

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
}));

vi.mock("@/lib/studio/orders", () => ({
  getOrdersStore: () => ({ getForCustomer: mocks.getForCustomer }),
}));

// Partial mock: the real `guestBundleDeliverySummary` builds the line, so the
// wording and the masking under test are the production ones.
vi.mock("@/lib/studio/bundle-delivery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/studio/bundle-delivery")>();
  return {
    ...actual,
    getBundleDeliveriesStore: () => ({ listForOrder: mocks.listForOrder }),
    recheckBundleDeliveriesForOrder: mocks.recheckBundleDeliveriesForOrder,
  };
});

const ORDER_ID = "11111111-2222-4333-8444-555555555555";
const ACCOUNT_ID = "account-1";
const PROVIDER_REF = "DEV-A1B2C3D4";
const PROVIDER_ERROR = "TechChief rejected this top-up: insufficient wallet.";

function bundleDraft(category = "data-bundles") {
  return {
    id: "draft-1",
    brief: {
      businessName: "Data GH",
      category,
      currency: "GHS",
      items: [],
      features: { customerAccounts: true },
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
      },
    },
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    draftId: "draft-1",
    customerAccountId: ACCOUNT_ID,
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
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    statusHistory: [{ status: "paid", at: "2026-09-04T11:05:00.000Z" }],
    createdAt: "2026-09-04T11:00:00.000Z",
    updatedAt: "2026-09-04T11:05:00.000Z",
    ...overrides,
  };
}

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    orderId: ORDER_ID,
    status: "processing",
    dataMb: 1024,
    providerRef: PROVIDER_REF,
    lastError: PROVIDER_ERROR,
    attempts: 1,
    recipientPhone: "0240000001",
    ...overrides,
  };
}

async function renderPage() {
  const { default: CustomerOrderPage } =
    await import("@/app/account/orders/[id]/page");
  const element = await CustomerOrderPage({
    params: Promise.resolve({ id: ORDER_ID }),
  });
  return renderToStaticMarkup(element);
}

describe("customer account order page — the bundle delivery line", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCustomerSession.mockResolvedValue({
      account: { id: ACCOUNT_ID, email: "kwame@example.com" },
    });
    mocks.publicGetDraft.mockResolvedValue(bundleDraft());
    mocks.getForCustomer.mockResolvedValue(order());
    mocks.listForOrder.mockResolvedValue([
      deliveryRow(),
      deliveryRow({ id: "row-2", status: "delivered" }),
    ]);
  });

  it("shows the masked aggregate line for a bundle order", async () => {
    const markup = await renderPage();

    expect(markup).toContain('data-testid="bundle-delivery-line"');
    // The recipient reaches the page masked, exactly as on the guest page.
    expect(markup).toContain("024 ••• 0001");
    expect(markup).toContain("2GB");
  });

  it("prints no provider reference and no provider error text", async () => {
    const markup = await renderPage();

    expect(markup).not.toContain(PROVIDER_REF);
    expect(markup).not.toContain(PROVIDER_ERROR);
    expect(markup).not.toContain("insufficient wallet");
    // Nor the buyer's own number in the delivery line: the full recipient
    // number already appears once, on the authenticated "Send to" row.
    const line = markup.slice(
      markup.indexOf('data-testid="bundle-delivery-line"'),
      markup.indexOf(
        "</p>",
        markup.indexOf('data-testid="bundle-delivery-line"'),
      ),
    );
    expect(line).not.toContain("0240000001");
  });

  it("reads the rows instead of reconciling them", async () => {
    await renderPage();

    // A recheck would call the provider; a customer refreshing this page must
    // not be able to spend the shop's hourly TechChief allowance.
    expect(mocks.listForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(mocks.recheckBundleDeliveriesForOrder).not.toHaveBeenCalled();
  });

  it("says nothing about delivery when there are no rows yet", async () => {
    mocks.listForOrder.mockResolvedValue([]);

    const markup = await renderPage();

    expect(markup).not.toContain('data-testid="bundle-delivery-line"');
  });

  it("leaves a website that is not a bundle shop completely alone", async () => {
    mocks.publicGetDraft.mockResolvedValue(bundleDraft("food"));
    mocks.getForCustomer.mockResolvedValue(
      order({
        recipientPhone: null,
        lines: [
          { itemId: "jollof", name: "Jollof Rice", price: 25, quantity: 1 },
        ],
      }),
    );

    const markup = await renderPage();

    expect(markup).not.toContain('data-testid="bundle-delivery-line"');
    // Not even a read: a shop with no bundle deliveries has nothing to list.
    expect(mocks.listForOrder).not.toHaveBeenCalled();
  });

  it("shows no line for a bundle order with no recipient number", async () => {
    // Cannot happen through checkout (the recipient is required), but the page
    // must not invent a line for a legacy row.
    mocks.getForCustomer.mockResolvedValue(order({ recipientPhone: null }));

    const markup = await renderPage();

    expect(markup).not.toContain('data-testid="bundle-delivery-line"');
    expect(mocks.listForOrder).not.toHaveBeenCalled();
  });

  it("still renders the rest of the order page", async () => {
    const markup = await renderPage();

    expect(markup).toContain("Order 11111111");
    expect(markup).toContain("Order timeline");
    expect(markup).toContain("MTN 1GB");
    // The authenticated page keeps showing the full recipient number, as it
    // always has — the masked line is an addition, not a replacement.
    expect(markup).toContain("Send to:");
    expect(markup).toContain("0240000001");
  });
});
