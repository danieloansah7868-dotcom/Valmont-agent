/**
 * Stage 6d — the per-row supplier cost (`api_price`) on SQLite.
 *
 * What is under test here is the whole capture path for one top-up:
 *
 *  - an old SQLite file (created before migration 0016) gains the column the
 *    next time `ensureBundleDeliveriesSchema` runs;
 *  - `setProviderRef` writes `api_price` only when the send result carries a
 *    finite price — the optional meta keeps hand-written test stores
 *    type-compatible, so the BundleDeliveriesStore interface gains no method;
 *  - a real TechChief send through the engine stores both the provider
 *    reference and the 4.5 GHS `dev_order.php` answered;
 *  - a simulator send (and therefore a manual row) never gains a cost;
 *  - a retry that sends again overwrites the old charge with the new one.
 *
 * `fetch` is stubbed for the engine cases; no test here makes real HTTP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import { getSqliteChatStore } from "@/lib/chat-store";
import {
  dispatchBundleDeliveriesForOrder,
  ensureBundleDeliveriesSchema,
  retryBundleDeliveryFailures,
  SqliteBundleDeliveriesStore,
  type NewBundleDeliveryInput,
} from "./bundle-delivery";
import { connectTechChief, SqliteIntegrationsStore } from "./integrations";
import { SqliteStudioDraftStore } from "./draft-store";
import { SqliteOrdersStore, type NewOrderInput } from "./orders";
import { createDefaultBrief } from "./site-brief/defaults";
import { starterBundleCatalogue } from "./bundles";

const KEY = "TCHX-Ab12Cd34Ef56Gh78";
const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const OWNER_ID = canonicalUserId(userA);

const dirs: string[] = [];
let orders: SqliteOrdersStore;
let deliveries: SqliteBundleDeliveriesStore;
let integrations: SqliteIntegrationsStore;
let drafts: SqliteStudioDraftStore;
let draftId = "";
let sequence = 0;

const fetchMock = vi.fn();
let calls: string[] = [];
/** What `dev_order.php` answers next; tests change `api_price` through this. */
let orderApiPrice: number | null = 4.5;

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
          api_price: orderApiPrice,
          wallet_balance: 34,
          message: "Order accepted",
        }),
      );
    }
    return Promise.resolve(json({}, 500));
  });
}

function bundleOrder(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  sequence += 1;
  return {
    ownerId: OWNER_ID,
    draftId,
    accessCode: `api-price-code-${sequence}`,
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
    customerName: "Ama",
    customerPhone: "0240000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
    ...overrides,
  };
}

function deliveryInput(
  orderId: string,
  overrides: Partial<NewBundleDeliveryInput> = {},
): NewBundleDeliveryInput {
  return {
    orderId,
    ownerId: OWNER_ID,
    lineIndex: 0,
    unitIndex: 0,
    itemId: "bundle-00",
    itemName: "MTN 1GB",
    network: "mtn",
    dataMb: 1024,
    validity: "7 days",
    recipientPhone: "0240000001",
    provider: "techchief",
    ...overrides,
  };
}

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-api-price-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  vi.stubEnv("APP_URL", "https://shop.example");
  delete process.env.DATABASE_URL;
  delete process.env.BUNDLE_DELIVERY_PROVIDER;

  orders = new SqliteOrdersStore();
  deliveries = new SqliteBundleDeliveriesStore();
  integrations = new SqliteIntegrationsStore();
  drafts = new SqliteStudioDraftStore();

  calls = [];
  orderApiPrice = 4.5;
  fetchMock.mockReset();
  stubFetch();
  vi.stubGlobal("fetch", fetchMock);
  resetRateLimitForTests();

  const draft = await drafts.create(
    userA,
    createDefaultBrief({
      businessName: "Adom Data Hub",
      category: "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
      items: starterBundleCatalogue(),
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
  draftId = draft.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetRateLimitForTests();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Saves a verified connection the way the Studio card does. */
async function seedVerifiedConnection(): Promise<void> {
  const result = await connectTechChief({
    draftId,
    ownerId: OWNER_ID,
    apiKey: KEY,
    store: integrations,
  });
  if (!result.ok)
    throw new Error(`expected a verified connection: ${result.message}`);
  // Connecting spent calls on the sync; start clean so tests count only
  // what they mean to.
  calls = [];
  fetchMock.mockClear();
}

function countCalls(endpoint: string): number {
  return calls.filter((call) => call === endpoint).length;
}

describe("ensureBundleDeliveriesSchema adds api_price to an old table", () => {
  it("adds the column when a pre-0016 table exists, and is a no-op after", async () => {
    const connection = new SqliteChatStore(
      path.join(dirs[0]!, "pre-0016.sqlite"),
      path.join(dirs[0]!, "pre-0016.json"),
    ).connection;
    // The exact CREATE that Stage 4–6c shipped — no api_price anywhere.
    connection.exec(`CREATE TABLE studio_deliveries (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      unit_index INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      network TEXT NOT NULL,
      data_mb INTEGER NOT NULL,
      validity TEXT,
      recipient_phone TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'simulator',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_ref TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    connection.exec(
      "INSERT INTO studio_deliveries (id, order_id, owner_id, line_index, unit_index, item_id, item_name, network, data_mb, recipient_phone, status, created_at, updated_at) VALUES ('row-1', 'o-1', 'u-1', 0, 0, 'i-1', 'MTN 1GB', 'mtn', 1024, '0240000001', 'delivered', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
    );

    ensureBundleDeliveriesSchema(connection);

    const columns = (
      connection
        .prepare("PRAGMA table_info(studio_deliveries)")
        .all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(columns).toContain("api_price");
    // The existing row reads back with no invented cost.
    const row = connection
      .prepare("SELECT api_price FROM studio_deliveries WHERE id = 'row-1'")
      .get() as { api_price: null };
    expect(row.api_price).toBeNull();

    // Idempotent: a second pass must not throw "duplicate column".
    expect(() => ensureBundleDeliveriesSchema(connection)).not.toThrow();
  });
});

describe("setProviderRef and api_price (SQLite)", () => {
  it("persists a finite apiPrice passed in meta, and returns it on the record", async () => {
    const order = await orders.create(bundleOrder());
    const [row] = await deliveries.createMany([deliveryInput(order.id)]);
    await deliveries.claimForDispatch(row.id, { provider: "techchief" });

    const updated = await deliveries.setProviderRef(row.id, "DEV-REF-1", {
      apiPrice: 4.5,
    });

    expect(updated?.providerRef).toBe("DEV-REF-1");
    expect(updated?.apiPrice).toBe(4.5);
  });

  it("leaves the column untouched when no meta (or a non-finite price) is passed", async () => {
    const order = await orders.create(bundleOrder());
    const [row] = await deliveries.createMany([deliveryInput(order.id)]);
    await deliveries.claimForDispatch(row.id, { provider: "simulator" });

    const noMeta = await deliveries.setProviderRef(row.id, "sim-ref-1");
    expect(noMeta?.apiPrice).toBeUndefined();

    const nonFinite = await deliveries.setProviderRef(row.id, "sim-ref-2", {
      apiPrice: Number.NaN,
    });
    expect(nonFinite?.apiPrice).toBeUndefined();

    const dbRow = (
      getSqliteChatStore()
        .connection.prepare(
          "SELECT api_price FROM studio_deliveries WHERE id = ?",
        )
        .get(row.id) as { api_price: number | null }
    ).api_price;
    expect(dbRow).toBeNull();
  });

  it("only records a price on the row the meta says it belongs to", async () => {
    const order = await orders.create(bundleOrder());
    const [row] = await deliveries.createMany([deliveryInput(order.id)]);
    await deliveries.claimForDispatch(row.id, { provider: "techchief" });
    await deliveries.setProviderRef(row.id, "DEV-REF-1", { apiPrice: 4.5 });

    // A second row charged the same amount keeps its own independent price.
    const orderTwo = await orders.create(bundleOrder());
    const [rowTwo] = await deliveries.createMany([
      deliveryInput(orderTwo.id, { provider: "techchief" }),
    ]);
    await deliveries.claimForDispatch(rowTwo.id, { provider: "techchief" });
    await deliveries.setProviderRef(rowTwo.id, "DEV-REF-2", { apiPrice: 9.99 });

    expect((await deliveries.getById(row.id))?.apiPrice).toBe(4.5);
    expect((await deliveries.getById(rowTwo.id))?.apiPrice).toBe(9.99);
  });
});

describe("the engine records api_price at every TechChief send", () => {
  it("a live TechChief send stores apiPrice 4.5 and the providerRef", async () => {
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, {
      orders,
      deliveries,
      integrations,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("processing");
    expect(rows[0]?.provider).toBe("techchief");
    expect(rows[0]?.providerRef).toBe("DEV-A1B2C3D4");
    expect(rows[0]?.apiPrice).toBe(4.5);
    expect(countCalls("dev_order.php")).toBe(1);
  });

  it("a simulator send leaves apiPrice undefined (no invented cost)", async () => {
    const order = await orders.create(bundleOrder({ paymentMode: "test" }));

    const rows = await dispatchBundleDeliveriesForOrder(order.id, {
      orders,
      deliveries,
      integrations,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("simulator");
    expect(rows[0]?.providerRef).toMatch(/^sim-/);
    expect(rows[0]?.apiPrice).toBeUndefined();
    // No TechChief call was made at all.
    expect(calls).toEqual([]);
  });

  it("a TechChief order whose answer carries no api_price stores none", async () => {
    await seedVerifiedConnection();
    orderApiPrice = null;
    const order = await orders.create(bundleOrder());

    const rows = await dispatchBundleDeliveriesForOrder(order.id, {
      orders,
      deliveries,
      integrations,
    });

    expect(rows[0]?.providerRef).toBe("DEV-A1B2C3D4");
    expect(rows[0]?.apiPrice).toBeUndefined();
  });

  it("a retry that sends again overwrites the previous charge", async () => {
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());
    await dispatchBundleDeliveriesForOrder(order.id, {
      orders,
      deliveries,
      integrations,
    });
    let row = (await deliveries.listForOrder(order.id))[0]!;
    expect(row.apiPrice).toBe(4.5);

    // Something went wrong afterwards; the owner presses Retry and TechChief
    // charges the new (higher) price for the resend.
    await deliveries.markFailed(row.id, { error: "forced for test" });
    calls = [];
    orderApiPrice = 9.99;

    const result = await retryBundleDeliveryFailures(order.ownerId, order.id, {
      orders,
      deliveries,
      integrations,
    });

    expect(countCalls("dev_order.php")).toBe(1);
    row = result!.deliveries[0]!;
    expect(row.status).toBe("processing");
    expect(row.providerRef).toBe("DEV-A1B2C3D4");
    expect(row.apiPrice).toBe(9.99);
  });

  it("a failed resend never clears a recorded cost", async () => {
    await seedVerifiedConnection();
    const order = await orders.create(bundleOrder());
    await dispatchBundleDeliveriesForOrder(order.id, {
      orders,
      deliveries,
      integrations,
    });
    const row = (await deliveries.listForOrder(order.id))[0]!;
    expect(row.apiPrice).toBe(4.5);

    await deliveries.markFailed(row.id, { error: "forced for test" });
    const failed = await deliveries.getById(row.id);
    expect(failed?.apiPrice).toBe(4.5);
  });
});

describe("manual rows never carry a cost", () => {
  it("a manual mark leaves api_price unset", async () => {
    const order = await orders.create(bundleOrder({ paymentMode: "test" }));
    const [row] = await deliveries.createMany([
      deliveryInput(order.id, { provider: "manual" }),
    ]);
    await deliveries.markDelivered(row.id);

    const delivered = await deliveries.getById(row.id);
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.apiPrice).toBeUndefined();
    expect(delivered?.providerRef).toBeUndefined();
  });
});
