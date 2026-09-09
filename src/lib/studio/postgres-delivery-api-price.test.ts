/**
 * PostgreSQL contract tests for the Stage 6d `api_price` column.
 *
 * Two things are proved against the real database engine:
 *
 *  - migration 0016 actually ran (CI applies every migration before the test
 *    suite): `studio_deliveries.api_price` exists as `numeric(12,2)`;
 *  - the PostgreSQL store round-trips the per-row cost: `setProviderRef`
 *    writes `api_price` when the send result carries a finite price and
 *    leaves the column untouched when it does not, with the `numeric`
 *    string coming back as a JavaScript number on the record.
 *
 * Skipped without a throwaway database, exactly like the other postgres
 * suites:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const owner: SessionUser = {
  id: "pg-delivery-api-price-owner",
  login: "delivery-api-price-owner",
  name: "Delivery API Price Owner",
};

describe.runIf(connectionString)("PostgreSQL delivery api_price", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let ordersStore: any;
  let deliveriesStore: any;
  let drafts: any;
  let getDatabase: any;
  let closeDatabase: any;
  let studioOrders: any;
  let studioDrafts: any;
  let studioDeliveries: any;
  let users: any;
  let eq: any;
  let ensureStudioUser: any;
  let createDefaultBrief: any;
  let sql: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerId = "";
  let draftId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    const orders = await import("./orders");
    const deliveries = await import("./bundle-delivery");
    const draftStore = await import("./draft-store");
    const defaults = await import("./site-brief/defaults");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");
    const identity = await import("@/lib/user-identity");

    ordersStore = new orders.PostgresOrdersStore();
    deliveriesStore = new deliveries.PostgresBundleDeliveriesStore();
    drafts = new draftStore.PostgresStudioDraftStore();
    createDefaultBrief = defaults.createDefaultBrief;
    ensureStudioUser = identity.ensureStudioUser;
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    studioOrders = schema.studioOrders;
    studioDrafts = schema.studioDrafts;
    studioDeliveries = schema.studioDeliveries;
    users = schema.users;
    eq = drizzle.eq;
    sql = drizzle.sql;

    ownerId = await ensureStudioUser(owner);
    draftId = (
      await drafts.create(
        owner,
        createDefaultBrief({
          businessName: "PG API Price Shop",
          category: "data-bundles",
          items: [
            {
              id: "b1",
              name: "MTN 1GB",
              price: 10,
              bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
            },
          ],
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await getDatabase()
      .delete(studioDeliveries)
      .where(eq(studioDeliveries.ownerId, ownerId));
    await getDatabase()
      .delete(studioOrders)
      .where(eq(studioOrders.ownerId, ownerId));
    await getDatabase()
      .delete(studioDrafts)
      .where(eq(studioDrafts.ownerId, ownerId));
    await getDatabase().delete(users).where(eq(users.id, ownerId));
    await closeDatabase();
    delete process.env.DATABASE_URL;
  });

  async function seededDeliveryRow(): Promise<{ id: string }> {
    const order = await ordersStore.create({
      ownerId,
      draftId,
      accessCode: `pg-api-price-${Date.now()}-${Math.random()}`,
      status: "paid",
      currency: "GHS",
      subtotal: 10,
      deliveryFee: 0,
      total: 10,
      lines: [
        {
          itemId: "b1",
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
    });
    const [row] = await deliveriesStore.createMany([
      {
        orderId: order.id,
        ownerId,
        lineIndex: 0,
        unitIndex: 0,
        itemId: "b1",
        itemName: "MTN 1GB",
        network: "mtn",
        dataMb: 1024,
        validity: "7 days",
        recipientPhone: "0240000001",
        provider: "techchief",
      },
    ]);
    return row;
  }

  it("migration 0016 ran: studio_deliveries.api_price exists as numeric(12,2)", async () => {
    const columns = await getDatabase().execute(
      sql`SELECT data_type, numeric_precision, numeric_scale
          FROM information_schema.columns
          WHERE table_name = 'studio_deliveries' AND column_name = 'api_price'`,
    );
    expect(columns.length).toBeGreaterThan(0);
    const column = columns[0];
    expect(column.data_type).toBe("numeric");
    expect(Number(column.numeric_precision)).toBe(12);
    expect(Number(column.numeric_scale)).toBe(2);
  });

  it("round-trips api_price through the PostgreSQL store", async () => {
    const row = await seededDeliveryRow();
    await deliveriesStore.claimForDispatch(row.id, { provider: "techchief" });

    const updated = await deliveriesStore.setProviderRef(
      row.id,
      "DEV-PG-REF-1",
      { apiPrice: 8.5 },
    );
    expect(updated?.providerRef).toBe("DEV-PG-REF-1");
    // The stored `numeric` string arrives back as a number on the record.
    expect(updated?.apiPrice).toBe(8.5);
  });

  it("leaves api_price untouched when the send carries no finite price", async () => {
    const row = await seededDeliveryRow();
    await deliveriesStore.claimForDispatch(row.id, { provider: "simulator" });

    const noMeta = await deliveriesStore.setProviderRef(row.id, "sim-ref");
    expect(noMeta?.apiPrice).toBeUndefined();

    const nonFinite = await deliveriesStore.setProviderRef(
      row.id,
      "sim-ref-2",
      {
        apiPrice: Number.NaN,
      },
    );
    expect(nonFinite?.apiPrice).toBeUndefined();

    const stored = await getDatabase()
      .select({ apiPrice: studioDeliveries.apiPrice })
      .from(studioDeliveries)
      .where(eq(studioDeliveries.id, row.id))
      .limit(1);
    expect(stored[0].apiPrice).toBeNull();
  });
});
