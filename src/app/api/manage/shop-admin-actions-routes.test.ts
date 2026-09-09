/**
 * Stage 6c — the shop admin WRITE routes (`/api/manage/[id]/*`) against real
 * handlers and a throwaway SQLite database, exactly like 6b's
 * `shop-admin-routes.test.ts`. No store is mocked; `fetch` is stubbed (with
 * every call counted) wherever the engine could reach TechChief, so "the
 * engine was called" and "the engine was NOT called" are both proved by
 * count.
 *
 * Four routes under test:
 *
 *  - POST …/orders/[orderId]/deliveries/[deliveryId]/mark (orders.fulfil)
 *  - POST …/orders/[orderId]/deliveries/retry          (orders.fulfil)
 *  - POST …/orders/[orderId]/deliveries/recheck        (orders.fulfil)
 *  - PATCH …/bundles/[itemId]                          (bundles.manage)
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSqliteChatStore,
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import {
  resetShopAdminPurgeClockForTests,
  SqliteShopAdminStore,
} from "@/lib/shop-admin/store";
import { SHOP_SESSION_COOKIE } from "@/lib/shop-admin/auth";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { starterBundleCatalogue } from "@/lib/studio/bundles";
import {
  SqliteOrdersStore,
  type NewOrderInput,
  type OrderRecord,
} from "@/lib/studio/orders";
import {
  SqliteBundleDeliveriesStore,
  type BundleDeliveryRecord,
  type NewBundleDeliveryInput,
} from "@/lib/studio/bundle-delivery";
import {
  connectTechChief,
  SqliteIntegrationsStore,
} from "@/lib/studio/integrations";
import { PACKAGE_NOT_INCLUDED_MESSAGE } from "@/lib/studio/plans";
import { POST as mark } from "./[id]/orders/[orderId]/deliveries/[deliveryId]/mark/route";
import { POST as retry } from "./[id]/orders/[orderId]/deliveries/retry/route";
import { POST as recheck } from "./[id]/orders/[orderId]/deliveries/recheck/route";
import { PATCH as patchBundle } from "./[id]/bundles/[itemId]/route";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const PASSWORD = "correct horse battery";
const KEY = "TCHX-Ab12Cd34Ef56Gh78";
const csrf = "shop-admin-actions-csrf-token-1234";

const dirs: string[] = [];
let drafts: SqliteStudioDraftStore;
let store: SqliteShopAdminStore;
let orders: SqliteOrdersStore;
let deliveries: SqliteBundleDeliveriesStore;
let integrations: SqliteIntegrationsStore;
let sequence = 0;

const fetchMock = vi.fn();
/** Every outbound HTTP call made during a test, by endpoint file name. */
let calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    const target = new URL(url);
    calls.push(target.pathname.split("/").pop() ?? target.pathname);
    if (target.pathname.endsWith("dev_wallet.php")) {
      return Promise.resolve(
        json({
          success: true,
          wallet_balance: 42.5,
          currency: "GHS",
          low_balance: false,
          threshold: 20,
          account_status: "active",
          api_activated: true,
          key_name: "Adom Data",
        }),
      );
    }
    if (target.pathname.endsWith("dev_bundles.php")) {
      return Promise.resolve(
        json({
          success: true,
          bundles: [
            {
              id: 11,
              network: "MTN",
              size_gb: 1,
              validity_days: 7,
              price: 8.5,
              currency: "GHS",
            },
          ],
        }),
      );
    }
    if (target.pathname.endsWith("dev_order.php")) {
      return Promise.resolve(
        json({
          success: true,
          order_ref: "DEV-A1B2C3D4",
          status: "accepted",
          api_price: 8.5,
          wallet_balance: 34,
          message: "Order accepted",
        }),
      );
    }
    if (target.pathname.endsWith("dev_status.php")) {
      return Promise.resolve(
        json({
          success: true,
          order_ref: "DEV-A1B2C3D4",
          status: "processing",
        }),
      );
    }
    return Promise.resolve(json({}, 500));
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TRUST_PROXY", "false");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  delete process.env.BUNDLE_DELIVERY_PROVIDER;
  resetRateLimitForTests();
  resetShopAdminPurgeClockForTests();
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-shop-actions-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  store = new SqliteShopAdminStore();
  orders = new SqliteOrdersStore();
  deliveries = new SqliteBundleDeliveriesStore();
  integrations = new SqliteIntegrationsStore();
  calls = [];
  fetchMock.mockReset();
  stubFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(
  url: string,
  body: unknown,
  options: {
    cookie?: string;
    method?: string;
    csrf?: boolean;
  } = {},
) {
  const cookies = [
    options.csrf === false ? null : `valmont_csrf=${csrf}`,
    options.cookie ? `${SHOP_SESSION_COOKIE}=${options.cookie}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return new NextRequest(`http://localhost${url}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(cookies ? { cookie: cookies } : {}),
      ...(options.csrf === false ? {} : { "x-valmont-csrf": csrf }),
    },
    body: JSON.stringify(body),
  });
}

function params<T extends Record<string, string>>(values: T) {
  return { params: Promise.resolve(values) };
}

async function seedShop(
  plan: "starter" | "auto_dispatch" | "command_center" = "auto_dispatch",
  overrides: { category?: "restaurant"; name?: string } = {},
) {
  return drafts.create(
    agency,
    createDefaultBrief({
      businessName: overrides.name ?? "Data GH",
      category: overrides.category ?? "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
      items: overrides.category
        ? [{ id: "i1", name: "Jollof Rice", price: 45 }]
        : starterBundleCatalogue(),
      plan,
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        valmontPay: { provisioned: true },
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        notifications: { email: "owner@adom.example" },
        staged: { enabled: false, stages: [] },
      },
    }),
  );
}

async function seedActiveOwner(draftId: string, email = "owner@example.com") {
  const invite = await store.createOwnerInvite({
    draftId,
    email,
    name: "Kofi",
    invitedBy: canonicalUserId(agency),
  });
  const admin = await store.acceptInvite(invite.token, "Kofi", PASSWORD);
  if (!admin) throw new Error("invite should have been accepted");
  return admin;
}

async function seedActiveMember(
  draftId: string,
  invitedBy: string,
  permissions: readonly string[],
  email = "staff@example.com",
) {
  const invite = await store.createMemberInvite({
    draftId,
    email,
    name: "Staff",
    permissions,
    invitedBy,
  });
  const admin = await store.acceptInvite(invite.token, "Staff", PASSWORD);
  if (!admin) throw new Error("invite should have been accepted");
  return admin;
}

async function loginCookie(adminId: string): Promise<string> {
  const session = await store.createSession(adminId);
  return session.token;
}

async function seedPaidOrder(
  draftId: string,
  overrides: Partial<NewOrderInput> = {},
): Promise<OrderRecord> {
  sequence += 1;
  return orders.create({
    ownerId: canonicalUserId(agency),
    draftId,
    accessCode: `actions-code-${sequence}`,
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
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    ...overrides,
  });
}

/** One delivery row in the state asked for, through the real store. */
async function seedDelivery(
  order: OrderRecord,
  state:
    | "pending-manual"
    | "pending-techchief"
    | "processing-techchief"
    | "failed-techchief",
): Promise<BundleDeliveryRecord> {
  const input: NewBundleDeliveryInput = {
    orderId: order.id,
    ownerId: order.ownerId,
    lineIndex: 0,
    unitIndex: 0,
    itemId: "bundle-00",
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    validity: "7 days",
    recipientPhone: "0240000001",
    provider: state === "pending-manual" ? "manual" : "techchief",
  };
  const [row] = await deliveries.createMany([input]);
  if (!row) throw new Error("delivery row should have been created");
  if (state === "processing-techchief") {
    await deliveries.claimForDispatch(row.id, { provider: "techchief" });
    await deliveries.setProviderRef(row.id, "DEV-A1B2C3D4");
  } else if (state === "failed-techchief") {
    await deliveries.markFailed(row.id, { error: "forced for test" });
  }
  const fresh = await deliveries.getById(row.id);
  if (!fresh) throw new Error("delivery row should exist");
  return fresh;
}

/** Saves a verified TechChief connection, then zeroes the call log. */
async function seedVerifiedConnection(draftId: string): Promise<void> {
  const result = await connectTechChief({
    draftId,
    ownerId: canonicalUserId(agency),
    apiKey: KEY,
    store: integrations,
  });
  if (!result.ok)
    throw new Error(`expected a verified connection: ${result.message}`);
  calls = [];
}

function markUrl(draftId: string, orderId: string, deliveryId: string) {
  return `/api/manage/${draftId}/orders/${orderId}/deliveries/${deliveryId}/mark`;
}

// ---------------------------------------------------------------------------
// POST …/deliveries/[deliveryId]/mark
// ---------------------------------------------------------------------------

describe("POST /api/manage/[id]/orders/[orderId]/deliveries/[deliveryId]/mark", () => {
  it("requires CSRF", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const response = await mark(
      request(
        markUrl(shop.id, order.id, row.id),
        { status: "delivered" },
        {
          cookie: await loginCookie(owner.id),
          csrf: false,
        },
      ),
      params({ id: shop.id, orderId: order.id, deliveryId: row.id }),
    );
    expect(response.status).toBe(403);
  });

  it("answers 401 without a session cookie", async () => {
    const shop = await seedShop();
    const order = await seedPaidOrder(shop.id);
    const response = await mark(
      request(markUrl(shop.id, order.id, "some-row"), { status: "delivered" }),
      params({ id: shop.id, orderId: order.id, deliveryId: "some-row" }),
    );
    expect(response.status).toBe(401);
  });

  it("answers 404 for a session of another shop", async () => {
    const shopA = await seedShop(undefined, { name: "Shop A" });
    const shopB = await seedShop(undefined, { name: "Shop B" });
    const ownerB = await seedActiveOwner(shopB.id, "b@example.com");
    const order = await seedPaidOrder(shopA.id);
    const response = await mark(
      request(
        markUrl(shopA.id, order.id, "some-row"),
        { status: "delivered" },
        { cookie: await loginCookie(ownerB.id) },
      ),
      params({ id: shopA.id, orderId: order.id, deliveryId: "some-row" }),
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 for an order of a sibling website of the same agency user", async () => {
    const shopA = await seedShop(undefined, { name: "Shop A" });
    const shopB = await seedShop(undefined, { name: "Shop B" });
    const ownerA = await seedActiveOwner(shopA.id);
    const siblingOrder = await seedPaidOrder(shopB.id);
    const response = await mark(
      request(
        markUrl(shopA.id, siblingOrder.id, "some-row"),
        { status: "delivered" },
        { cookie: await loginCookie(ownerA.id) },
      ),
      params({
        id: shopA.id,
        orderId: siblingOrder.id,
        deliveryId: "some-row",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 when the delivery row belongs to another order", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const orderOne = await seedPaidOrder(shop.id);
    const orderTwo = await seedPaidOrder(shop.id);
    const foreignRow = await seedDelivery(orderTwo, "pending-manual");
    const response = await mark(
      request(
        markUrl(shop.id, orderOne.id, foreignRow.id),
        { status: "delivered" },
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: orderOne.id, deliveryId: foreignRow.id }),
    );
    expect(response.status).toBe(404);
    // And nothing was moved.
    expect((await deliveries.getById(foreignRow.id))?.status).toBe("pending");
  });

  it("answers 403 for a member without the orders.fulfil box", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id, []);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const response = await mark(
      request(
        markUrl(shop.id, order.id, row.id),
        { status: "delivered" },
        { cookie: await loginCookie(member.id) },
      ),
      params({ id: shop.id, orderId: order.id, deliveryId: row.id }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Your login does not include this action. Ask the shop owner.",
    });
    expect((await deliveries.getById(row.id))?.status).toBe("pending");
  });

  it("marks a manual pending row delivered for the owner and for a member with the box", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id, ["orders.fulfil"]);

    const ownerOrder = await seedPaidOrder(shop.id);
    const ownerRow = await seedDelivery(ownerOrder, "pending-manual");
    const ownerResponse = await mark(
      request(
        markUrl(shop.id, ownerOrder.id, ownerRow.id),
        { status: "delivered" },
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: ownerOrder.id, deliveryId: ownerRow.id }),
    );
    expect(ownerResponse.status).toBe(200);
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.delivery.status).toBe("delivered");
    expect(ownerBody.delivery.deliveredAt).toBeTruthy();

    const memberOrder = await seedPaidOrder(shop.id);
    const memberRow = await seedDelivery(memberOrder, "pending-manual");
    const memberResponse = await mark(
      request(
        markUrl(shop.id, memberOrder.id, memberRow.id),
        { status: "delivered" },
        { cookie: await loginCookie(member.id) },
      ),
      params({
        id: shop.id,
        orderId: memberOrder.id,
        deliveryId: memberRow.id,
      }),
    );
    expect(memberResponse.status).toBe(200);
    expect((await memberResponse.json()).delivery.status).toBe("delivered");
  });

  it("marks a manual pending row failed with the note, and without it", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const response = await mark(
      request(
        markUrl(shop.id, order.id, row.id),
        { status: "failed", note: "  no float today  " },
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id, deliveryId: row.id }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.delivery.status).toBe("failed");
    expect(body.delivery.lastError).toBe("no float today");

    const secondOrder = await seedPaidOrder(shop.id);
    const secondRow = await seedDelivery(secondOrder, "pending-manual");
    const noNote = await mark(
      request(
        markUrl(shop.id, secondOrder.id, secondRow.id),
        { status: "failed" },
        { cookie: await loginCookie(owner.id) },
      ),
      params({
        id: shop.id,
        orderId: secondOrder.id,
        deliveryId: secondRow.id,
      }),
    );
    expect(noNote.status).toBe(200);
    expect((await noNote.json()).delivery.lastError).toBe(
      "Marked as not sent by the shop.",
    );
  });

  it("marks a failed row of ANY provider delivered", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "failed-techchief");
    const response = await mark(
      request(
        markUrl(shop.id, order.id, row.id),
        { status: "delivered" },
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id, deliveryId: row.id }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.delivery.status).toBe("delivered");
    // Settled out of band: the provider's own history is untouched.
    expect(body.delivery.provider).toBe("techchief");
    expect(body.delivery.attempts).toBe(row.attempts);
  });

  it("refuses every other transition with the exact 409 sentences", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const cookie = await loginCookie(owner.id);

    // delivered row → 409 already delivered
    const deliveredOrder = await seedPaidOrder(shop.id);
    const deliveredRow = await seedDelivery(deliveredOrder, "pending-manual");
    await mark(
      request(
        markUrl(shop.id, deliveredOrder.id, deliveredRow.id),
        {
          status: "delivered",
        },
        { cookie },
      ),
      params({
        id: shop.id,
        orderId: deliveredOrder.id,
        deliveryId: deliveredRow.id,
      }),
    );
    const again = await mark(
      request(
        markUrl(shop.id, deliveredOrder.id, deliveredRow.id),
        { status: "delivered" },
        { cookie },
      ),
      params({
        id: shop.id,
        orderId: deliveredOrder.id,
        deliveryId: deliveredRow.id,
      }),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "This top-up is already delivered.",
    });

    // processing row → 409 use Check status
    const processingOrder = await seedPaidOrder(shop.id);
    const processingRow = await seedDelivery(
      processingOrder,
      "processing-techchief",
    );
    const processingResponse = await mark(
      request(
        markUrl(shop.id, processingOrder.id, processingRow.id),
        { status: "delivered" },
        { cookie },
      ),
      params({
        id: shop.id,
        orderId: processingOrder.id,
        deliveryId: processingRow.id,
      }),
    );
    expect(processingResponse.status).toBe(409);
    expect(await processingResponse.json()).toEqual({
      error: "This top-up is being sent automatically - use Check status.",
    });

    // pending automatic row → 409 queued for automatic sending
    const pendingOrder = await seedPaidOrder(shop.id);
    const pendingRow = await seedDelivery(pendingOrder, "pending-techchief");
    const pendingResponse = await mark(
      request(
        markUrl(shop.id, pendingOrder.id, pendingRow.id),
        { status: "delivered" },
        { cookie },
      ),
      params({
        id: shop.id,
        orderId: pendingOrder.id,
        deliveryId: pendingRow.id,
      }),
    );
    expect(pendingResponse.status).toBe(409);
    expect(await pendingResponse.json()).toEqual({
      error: "This top-up is queued for automatic sending - use Check status.",
    });

    // failed row asked to be failed → 409 already marked as failed
    const failedOrder = await seedPaidOrder(shop.id);
    const failedRow = await seedDelivery(failedOrder, "failed-techchief");
    const failedResponse = await mark(
      request(
        markUrl(shop.id, failedOrder.id, failedRow.id),
        { status: "failed" },
        { cookie },
      ),
      params({
        id: shop.id,
        orderId: failedOrder.id,
        deliveryId: failedRow.id,
      }),
    );
    expect(failedResponse.status).toBe(409);
    expect(await failedResponse.json()).toEqual({
      error: "This top-up is already marked as failed.",
    });
  });

  it("refuses a note longer than 200 characters with 400", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const response = await mark(
      request(
        markUrl(shop.id, order.id, row.id),
        { status: "failed", note: "x".repeat(201) },
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id, deliveryId: row.id }),
    );
    expect(response.status).toBe(400);
    expect((await deliveries.getById(row.id))?.status).toBe("pending");
  });

  it("two parallel marks on the same row give exactly one 200", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const cookie = await loginCookie(owner.id);
    const url = markUrl(shop.id, order.id, row.id);

    const [first, second] = await Promise.all([
      mark(
        request(url, { status: "delivered" }, { cookie }),
        params({
          id: shop.id,
          orderId: order.id,
          deliveryId: row.id,
        }),
      ),
      mark(
        request(url, { status: "delivered" }, { cookie }),
        params({
          id: shop.id,
          orderId: order.id,
          deliveryId: row.id,
        }),
      ),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(await conflict.json()).toEqual({
      error: "This top-up is already delivered.",
    });
    expect((await deliveries.getById(row.id))?.status).toBe("delivered");
  });

  it("never returns an ownerId (or any agency identifier) in the response", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const response = await mark(
      request(
        markUrl(shop.id, order.id, row.id),
        { status: "delivered" },
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id, deliveryId: row.id }),
    );
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("ownerId");
    expect(text).not.toContain(canonicalUserId(agency));
  });
});

// ---------------------------------------------------------------------------
// POST …/deliveries/retry and …/deliveries/recheck
// ---------------------------------------------------------------------------

describe("POST /api/manage/[id]/orders/[orderId]/deliveries/retry", () => {
  it("requires CSRF and a session", async () => {
    const shop = await seedShop();
    const order = await seedPaidOrder(shop.id);
    const noCsrf = await retry(
      request(
        `/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`,
        {},
        {
          csrf: false,
        },
      ),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(noCsrf.status).toBe(403);
    const noCookie = await retry(
      request(`/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`, {}),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(noCookie.status).toBe(401);
  });

  it("answers 404 for a session of another shop, for a sibling website's order, and for an unknown order", async () => {
    const shopA = await seedShop(undefined, { name: "Shop A" });
    const shopB = await seedShop(undefined, { name: "Shop B" });
    const ownerB = await seedActiveOwner(shopB.id, "b@example.com");
    const ownerA = await seedActiveOwner(shopA.id);
    const siblingOrder = await seedPaidOrder(shopB.id);
    const base = `/api/manage/${shopA.id}/orders`;

    const foreignSession = await retry(
      request(
        `${base}/${siblingOrder.id}/deliveries/retry`,
        {},
        {
          cookie: await loginCookie(ownerB.id),
        },
      ),
      params({ id: shopA.id, orderId: siblingOrder.id }),
    );
    expect(foreignSession.status).toBe(404);

    const sibling = await retry(
      request(
        `${base}/${siblingOrder.id}/deliveries/retry`,
        {},
        {
          cookie: await loginCookie(ownerA.id),
        },
      ),
      params({ id: shopA.id, orderId: siblingOrder.id }),
    );
    expect(sibling.status).toBe(404);

    const unknown = await retry(
      request(
        `/api/manage/${shopA.id}/orders/00000000-0000-4000-a000-000000000000/deliveries/retry`,
        {},
        { cookie: await loginCookie(ownerA.id) },
      ),
      params({
        id: shopA.id,
        orderId: "00000000-0000-4000-a000-000000000000",
      }),
    );
    expect(unknown.status).toBe(404);
  });

  it("answers 403 for a member without the box and 200 for one with it", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id, []);
    const memberWithBox = await seedActiveMember(
      shop.id,
      owner.id,
      ["orders.fulfil"],
      "fulfil@example.com",
    );
    const order = await seedPaidOrder(shop.id, { paymentMode: "test" });
    await seedDelivery(order, "pending-techchief");
    const url = `/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`;

    const refused = await retry(
      request(url, {}, { cookie: await loginCookie(member.id) }),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Your login does not include this action. Ask the shop owner.",
    });

    // A test-mode order resolves to the simulator; the retry runs (the
    // pending row is skipped — only failed rows are retried — so no sends).
    const allowed = await retry(
      request(url, {}, { cookie: await loginCookie(memberWithBox.id) }),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(allowed.status).toBe(200);
  });

  it("on a Starter shop answers 409 with the by-hand sentence and makes ZERO engine calls", async () => {
    const shop = await seedShop("starter");
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "pending-manual");
    const response = await retry(
      request(
        `/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`,
        {},
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This shop sends bundles by hand - mark the top-up delivered instead.",
    });
    expect(calls).toEqual([]);
    // Even a failed manual row is never retried on a Starter shop.
    await deliveries.markFailed(row.id, { error: "forced for test" });
    const second = await retry(
      request(
        `/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`,
        {},
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(second.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("on Auto-Dispatch with a verified connection the engine really sends (one dev_order.php per failed row)", async () => {
    const shop = await seedShop("auto_dispatch");
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "failed-techchief");

    const response = await retry(
      request(
        `/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`,
        {},
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      calls.filter((endpoint) => endpoint === "dev_order.php"),
    ).toHaveLength(1);
    // The row went out again and carries the provider's reference.
    const fresh = await deliveries.getById(row.id);
    expect(fresh?.status).toBe("processing");
    expect(fresh?.attempts).toBe(row.attempts + 1);
    // No ownerId in the payload.
    expect(JSON.stringify(body)).not.toContain("ownerId");
  });
});

describe("POST /api/manage/[id]/orders/[orderId]/deliveries/recheck", () => {
  it("requires CSRF and a session, and 403 for a member without the box", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id, []);
    const order = await seedPaidOrder(shop.id);
    const url = `/api/manage/${shop.id}/orders/${order.id}/deliveries/recheck`;

    const noCsrf = await recheck(
      request(url, {}, { csrf: false, cookie: await loginCookie(owner.id) }),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(noCsrf.status).toBe(403);
    const noCookie = await recheck(
      request(url, {}),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(noCookie.status).toBe(401);
    const refused = await recheck(
      request(url, {}, { cookie: await loginCookie(member.id) }),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(refused.status).toBe(403);
  });

  it("answers 404 for an order of a sibling website", async () => {
    const shopA = await seedShop(undefined, { name: "Shop A" });
    const shopB = await seedShop(undefined, { name: "Shop B" });
    const ownerA = await seedActiveOwner(shopA.id);
    const siblingOrder = await seedPaidOrder(shopB.id);
    const response = await recheck(
      request(
        `/api/manage/${shopA.id}/orders/${siblingOrder.id}/deliveries/recheck`,
        {},
        { cookie: await loginCookie(ownerA.id) },
      ),
      params({ id: shopA.id, orderId: siblingOrder.id }),
    );
    expect(response.status).toBe(404);
  });

  it("runs the engine for the owner: { deliveries, checkedAt }, no ownerId, and a real poll", async () => {
    const shop = await seedShop("auto_dispatch");
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    const order = await seedPaidOrder(shop.id);
    const row = await seedDelivery(order, "processing-techchief");
    // TechChief polls at most once per row per 10 minutes; age the row past it.
    const db = getSqliteChatStore().connection;
    db.prepare("UPDATE studio_deliveries SET updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      row.id,
    );

    const response = await recheck(
      request(
        `/api/manage/${shop.id}/orders/${order.id}/deliveries/recheck`,
        {},
        { cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, orderId: order.id }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.checkedAt).toBeTruthy();
    expect(Array.isArray(body.deliveries)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("ownerId");
    // The engine really asked TechChief about the in-flight row.
    expect(
      calls.filter((endpoint) => endpoint === "dev_status.php"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/manage/[id]/bundles/[itemId]
// ---------------------------------------------------------------------------

describe("PATCH /api/manage/[id]/bundles/[itemId]", () => {
  it("requires CSRF and a session", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const url = `/api/manage/${shop.id}/bundles/bundle-00`;
    const noCsrf = await patchBundle(
      request(
        url,
        { price: 11 },
        { method: "PATCH", csrf: false, cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(noCsrf.status).toBe(403);
    const noCookie = await patchBundle(
      request(url, { price: 11 }, { method: "PATCH" }),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(noCookie.status).toBe(401);
  });

  it("is a 404 for any website type except data-bundles", async () => {
    const restaurant = await seedShop("auto_dispatch", {
      category: "restaurant",
    });
    const owner = await seedActiveOwner(restaurant.id);
    const response = await patchBundle(
      request(
        `/api/manage/${restaurant.id}/bundles/i1`,
        { price: 50 },
        { method: "PATCH", cookie: await loginCookie(owner.id) },
      ),
      params({ id: restaurant.id, itemId: "i1" }),
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 for a session of another shop and for an unknown item id", async () => {
    const shopA = await seedShop(undefined, { name: "Shop A" });
    const shopB = await seedShop(undefined, { name: "Shop B" });
    const ownerA = await seedActiveOwner(shopA.id);
    const ownerB = await seedActiveOwner(shopB.id, "b@example.com");
    const foreign = await patchBundle(
      request(
        `/api/manage/${shopA.id}/bundles/bundle-00`,
        { price: 11 },
        { method: "PATCH", cookie: await loginCookie(ownerB.id) },
      ),
      params({ id: shopA.id, itemId: "bundle-00" }),
    );
    expect(foreign.status).toBe(404);

    const unknown = await patchBundle(
      request(
        `/api/manage/${shopA.id}/bundles/no-such-item`,
        { price: 11 },
        { method: "PATCH", cookie: await loginCookie(ownerA.id) },
      ),
      params({ id: shopA.id, itemId: "no-such-item" }),
    );
    expect(unknown.status).toBe(404);
  });

  it("answers 403 for a member without the box and 200 for one with it", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id, []);
    const memberWithBox = await seedActiveMember(
      shop.id,
      owner.id,
      ["bundles.manage"],
      "bundles@example.com",
    );

    const refused = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        { price: 11 },
        { method: "PATCH", cookie: await loginCookie(member.id) },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Your login does not include this action. Ask the shop owner.",
    });

    const allowed = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-01`,
        { price: 16 },
        { method: "PATCH", cookie: await loginCookie(memberWithBox.id) },
      ),
      params({ id: shop.id, itemId: "bundle-01" }),
    );
    expect(allowed.status).toBe(200);
  });

  it("changes a price, answers with the catalogue projection only, and bumps the revision by exactly one", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const before = (await drafts.list(agency)).find((d) => d.id === shop.id)!;

    const response = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        { price: "12.5" },
        { method: "PATCH", cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const item = body.items.find(
      (entry: { id: string }) => entry.id === "bundle-00",
    );
    expect(item).toMatchObject({ id: "bundle-00", price: 12.5, paused: false });

    // Projection only: nothing of the brief leaks.
    const text = JSON.stringify(body);
    for (const forbidden of [
      "payments",
      "valmontPay",
      "apiKey",
      "adminEmail",
      "businessName",
    ]) {
      expect(text).not.toContain(forbidden);
    }

    const after = (await drafts.list(agency)).find((d) => d.id === shop.id)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.brief.items.find((i) => i.id === "bundle-00")?.price).toBe(
      12.5,
    );
    // Nothing else about the item changed.
    expect(after.brief.items.find((i) => i.id === "bundle-00")?.name).toBe(
      before.brief.items.find((i) => i.id === "bundle-00")?.name,
    );
  });

  it("refuses prices of zero, negative, three decimals and above a million with 400", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const cookie = await loginCookie(owner.id);
    for (const price of [0, -5, 10.123, 1_000_001]) {
      const response = await patchBundle(
        request(
          `/api/manage/${shop.id}/bundles/bundle-00`,
          { price },
          { method: "PATCH", cookie },
        ),
        params({ id: shop.id, itemId: "bundle-00" }),
      );
      expect(response.status).toBe(400);
    }
    const brief = (await drafts.list(agency)).find(
      (d) => d.id === shop.id,
    )!.brief;
    expect(brief.items.find((i) => i.id === "bundle-00")?.price).toBe(10);
  });

  it("refuses an empty patch with 400", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const response = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        {},
        { method: "PATCH", cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(response.status).toBe(400);
  });

  it("pauses and resumes a bundle where the package allows it", async () => {
    const shop = await seedShop("auto_dispatch");
    const owner = await seedActiveOwner(shop.id);
    const cookie = await loginCookie(owner.id);

    const paused = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        { paused: true },
        { method: "PATCH", cookie },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(paused.status).toBe(200);
    expect(
      (await paused.json()).items.find(
        (entry: { id: string }) => entry.id === "bundle-00",
      ).paused,
    ).toBe(true);

    const resumed = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        { paused: false },
        { method: "PATCH", cookie },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(resumed.status).toBe(200);
    expect(
      (await resumed.json()).items.find(
        (entry: { id: string }) => entry.id === "bundle-00",
      ).paused,
    ).toBe(false);
  });

  it("refuses pause on a Starter shop with the standard package message", async () => {
    const shop = await seedShop("starter");
    const owner = await seedActiveOwner(shop.id);
    const response = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        { paused: true },
        { method: "PATCH", cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: PACKAGE_NOT_INCLUDED_MESSAGE,
    });
    const brief = (await drafts.list(agency)).find(
      (d) => d.id === shop.id,
    )!.brief;
    expect(brief.items.find((i) => i.id === "bundle-00")?.paused).toBe(
      undefined,
    );
  });

  it("a price change is allowed on a Starter shop", async () => {
    const shop = await seedShop("starter");
    const owner = await seedActiveOwner(shop.id);
    const response = await patchBundle(
      request(
        `/api/manage/${shop.id}/bundles/bundle-00`,
        { price: 11 },
        { method: "PATCH", cookie: await loginCookie(owner.id) },
      ),
      params({ id: shop.id, itemId: "bundle-00" }),
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()).items.find(
        (entry: { id: string }) => entry.id === "bundle-00",
      ).price,
    ).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe("Stage 6c rate limits (per website, per hour)", () => {
  it("the mark bucket allows 60 per hour and answers 429 beyond", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id);
    const cookie = await loginCookie(owner.id);
    let lastStatus = 200;
    for (let index = 0; index <= 60; index += 1) {
      // Marking the same pending row: the first succeeds, the rest 409 —
      // but every call spends the bucket either way.
      const response = await mark(
        request(
          markUrl(shop.id, order.id, "unknown-row-id"),
          { status: "delivered" },
          { cookie },
        ),
        params({
          id: shop.id,
          orderId: order.id,
          deliveryId: "unknown-row-id",
        }),
      );
      lastStatus = response.status;
      if (index < 60) expect([200, 404]).toContain(response.status);
    }
    expect(lastStatus).toBe(429);
  });

  it("retry and recheck share ONE bucket of 40 per website", async () => {
    const shop = await seedShop("auto_dispatch");
    const owner = await seedActiveOwner(shop.id);
    const order = await seedPaidOrder(shop.id, { paymentMode: "test" });
    const cookie = await loginCookie(owner.id);
    const retryUrl = `/api/manage/${shop.id}/orders/${order.id}/deliveries/retry`;
    const recheckUrl = `/api/manage/${shop.id}/orders/${order.id}/deliveries/recheck`;

    // 20 retries (all fine — nothing failed, the engine just runs)…
    for (let index = 0; index < 20; index += 1) {
      const response = await retry(
        request(retryUrl, {}, { cookie }),
        params({ id: shop.id, orderId: order.id }),
      );
      expect(response.status).toBe(200);
    }
    // …then 20 rechecks: exactly the shared 40th slot.
    for (let index = 0; index < 20; index += 1) {
      const response = await recheck(
        request(recheckUrl, {}, { cookie }),
        params({ id: shop.id, orderId: order.id }),
      );
      expect(response.status).toBe(200);
    }
    // The 41st call on either route is refused.
    expect(
      (
        await retry(
          request(retryUrl, {}, { cookie }),
          params({ id: shop.id, orderId: order.id }),
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await recheck(
          request(recheckUrl, {}, { cookie }),
          params({ id: shop.id, orderId: order.id }),
        )
      ).status,
    ).toBe(429);
  });

  it("the bundles bucket allows 60 per hour and answers 429 beyond", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const cookie = await loginCookie(owner.id);
    let lastStatus = 200;
    for (let index = 0; index <= 60; index += 1) {
      const response = await patchBundle(
        request(
          `/api/manage/${shop.id}/bundles/bundle-00`,
          { price: 10 + (index % 5) },
          { method: "PATCH", cookie },
        ),
        params({ id: shop.id, itemId: "bundle-00" }),
      );
      lastStatus = response.status;
      if (index < 60) expect(response.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
  });
});
