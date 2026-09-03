/**
 * PostgreSQL bundle delivery contract tests (Stage 4).
 *
 * These exercise the real PostgreSQL store — idempotent creation through the
 * unique (order_id, item_id) index, the guarded status transitions, and a
 * full engine pass — against the actual database engine. They are skipped
 * when no throwaway database is supplied:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const owner: SessionUser = {
  id: "pg-bundle-delivery-owner",
  login: "bundle-delivery-owner",
  name: "Bundle Delivery Owner",
};

describe.runIf(connectionString)("PostgreSQL bundle deliveries", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let ordersStore: any;
  let deliveriesStore: any;
  let engine: any;
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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerId = "";
  let draftId = "";

  function paidBundleOrder(overrides: Record<string, unknown> = {}) {
    return {
      ownerId,
      draftId,
      accessCode: `pg-delivery-${Date.now()}-${Math.random()}`,
      status: "paid",
      currency: "GHS",
      subtotal: 24,
      deliveryFee: 0,
      total: 24,
      lines: [
        {
          itemId: "b1",
          name: "MTN 1GB",
          price: 10,
          quantity: 1,
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
        {
          itemId: "b2",
          name: "Telecel 2GB",
          price: 14,
          quantity: 1,
          bundle: { network: "telecel", dataMb: 2048, validity: "30 days" },
        },
      ],
      customerName: "Ama",
      customerPhone: "0240000002",
      recipientPhone: "0240000001",
      paymentMethod: "valmont_pay",
      paymentMode: "test",
      ...overrides,
    };
  }

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
    engine = deliveries;
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

    ownerId = await ensureStudioUser(owner);
    draftId = (
      await drafts.create(
        owner,
        createDefaultBrief({
          businessName: "PG Bundle Shop",
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

  it("is idempotent through the unique index and guards every transition", async () => {
    const order = await ordersStore.create(paidBundleOrder());

    const first = await deliveriesStore.listForOrder(order.id);
    expect(first).toEqual([]);

    const engineDeps = {
      orders: ordersStore,
      deliveries: deliveriesStore,
      provider: {
        id: "stub",
        sends: [] as string[],
        async sendBundle(request: { recipientPhone: string }) {
          this.sends.push(request.recipientPhone);
          return { ok: true, providerRef: `pg-stub-${this.sends.length}` };
        },
        async checkStatus() {
          return { status: "delivered" };
        },
      },
    };

    // Dispatch, then replay: one row per line, no second send.
    const dispatched = await engine.dispatchBundleDeliveriesForOrder(
      order.id,
      engineDeps,
    );
    expect(dispatched).toHaveLength(2);
    expect(engineDeps.provider.sends).toHaveLength(2);
    expect(
      dispatched.every(
        (row: { status: string; attempts: number }) =>
          row.status === "processing" && row.attempts === 1,
      ),
    ).toBe(true);

    const replayed = await engine.dispatchBundleDeliveriesForOrder(
      order.id,
      engineDeps,
    );
    expect(replayed).toHaveLength(2);
    expect(engineDeps.provider.sends).toHaveLength(2);

    // A recheck settles the rows; the next one leaves them alone.
    const settled = await engine.recheckBundleDeliveriesForOrder(
      order.id,
      engineDeps,
    );
    expect(
      settled.every((row: { status: string }) => row.status === "delivered"),
    ).toBe(true);
    expect(settled[0].deliveredAt).toBeTruthy();
    expect(settled[0].providerRef).toMatch(/^pg-stub-/);

    // Store guards: a delivered row cannot be moved by any transition.
    const id = settled[0].id;
    await deliveriesStore.markFailed(id, { error: "late" });
    await deliveriesStore.markProcessing(id, {
      provider: "stub",
      providerRef: null,
    });
    await deliveriesStore.markDelivered(id);
    const after = await deliveriesStore.getById(id);
    expect(after.status).toBe("delivered");
    expect(after.attempts).toBe(1);
  });

  it("records dispatch failures with attempts counted, and retries only failed rows", async () => {
    const order = await ordersStore.create(paidBundleOrder());
    let shouldFail = true;
    const engineDeps = {
      orders: ordersStore,
      deliveries: deliveriesStore,
      provider: {
        id: "stub",
        async sendBundle() {
          if (shouldFail) return { ok: false, error: "provider is down" };
          return { ok: true, providerRef: "pg-stub-retry" };
        },
        async checkStatus() {
          return { status: "delivered" };
        },
      },
    };

    const failed = await engine.dispatchBundleDeliveriesForOrder(
      order.id,
      engineDeps,
    );
    expect(
      failed.every(
        (row: { status: string; attempts: number; lastError?: string }) =>
          row.status === "failed" &&
          row.attempts === 1 &&
          row.lastError === "provider is down",
      ),
    ).toBe(true);

    shouldFail = false;
    const retried = await engine.retryBundleDeliveryFailures(
      ownerId,
      order.id,
      engineDeps,
    );
    expect(
      retried.deliveries.every(
        (row: { status: string; attempts: number; lastError?: string }) =>
          row.status === "processing" &&
          row.attempts === 2 &&
          row.lastError === undefined,
      ),
    ).toBe(true);
  });
});
