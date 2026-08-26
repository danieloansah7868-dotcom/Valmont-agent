/**
 * PostgreSQL order ownership and customer-history contract tests.
 *
 * These use the real PostgreSQL store. They are skipped when no throwaway
 * database is supplied rather than pretending SQLite coverage proves the
 * PostgreSQL queries behave the same way.
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const userA: SessionUser = {
  id: "pg-customer-order-user-a",
  login: "customer-order-a",
  name: "Customer Order A",
};
const userB: SessionUser = {
  id: "pg-customer-order-user-b",
  login: "customer-order-b",
  name: "Customer Order B",
};

describe.runIf(connectionString)("PostgreSQL order ownership", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let getDatabase: any;
  let closeDatabase: any;
  let studioOrders: any;
  let studioDrafts: any;
  let customerAccounts: any;
  let users: any;
  let eq: any;
  let ensureStudioUser: any;
  let drafts: any;
  let createDefaultBrief: any;
  let customerStore: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerAId = "";
  let ownerBId = "";
  let accountAId = "";
  let accountBId = "";
  let draftAId = "";
  let draftBId = "";

  function input(overrides: Record<string, unknown> = {}) {
    return {
      ownerId: ownerAId,
      draftId: draftAId,
      accessCode: `pg-customer-code-${Date.now()}-${Math.random()}`,
      status: "paid",
      currency: "GHS",
      subtotal: 100,
      deliveryFee: 0,
      total: 100,
      lines: [{ itemId: "item-1", name: "Jollof", price: 100, quantity: 1 }],
      customerName: "Ama",
      customerPhone: "+233240000000",
      customerEmail: "ama@example.com",
      paymentMethod: "valmont_pay",
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    const orders = await import("./orders");
    const draftStore = await import("./draft-store");
    const defaults = await import("./site-brief/defaults");
    const accounts = await import("@/lib/customer-account-store");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");
    const identity = await import("@/lib/user-identity");

    store = new orders.PostgresOrdersStore();
    drafts = new draftStore.PostgresStudioDraftStore();
    customerStore = new accounts.PostgresCustomerAccountStore();
    createDefaultBrief = defaults.createDefaultBrief;
    ensureStudioUser = identity.ensureStudioUser;
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    studioOrders = schema.studioOrders;
    studioDrafts = schema.studioDrafts;
    customerAccounts = schema.customerAccounts;
    users = schema.users;
    eq = drizzle.eq;

    ownerAId = await ensureStudioUser(userA);
    ownerBId = await ensureStudioUser(userB);
    const brief = (businessName: string) =>
      createDefaultBrief({
        businessName,
        adminEmail: `${businessName.toLowerCase().replaceAll(" ", "-")}@example.com`,
      });
    draftAId = (await drafts.create(userA, brief("Customer Order A Shop"))).id;
    draftBId = (await drafts.create(userB, brief("Customer Order B Shop"))).id;
    accountAId = (
      await customerStore.createAccount({
        name: "Ama Account",
        email: "pg-customer-order-a@example.com",
        password: "a sufficiently long password",
      })
    ).id;
    accountBId = (
      await customerStore.createAccount({
        name: "Kofi Account",
        email: "pg-customer-order-b@example.com",
        password: "a sufficiently long password",
      })
    ).id;
  });

  afterAll(async () => {
    await getDatabase()
      .delete(studioOrders)
      .where(eq(studioOrders.ownerId, ownerAId));
    await getDatabase()
      .delete(studioOrders)
      .where(eq(studioOrders.ownerId, ownerBId));
    await getDatabase()
      .delete(studioDrafts)
      .where(eq(studioDrafts.ownerId, ownerAId));
    await getDatabase()
      .delete(studioDrafts)
      .where(eq(studioDrafts.ownerId, ownerBId));
    await getDatabase()
      .delete(customerAccounts)
      .where(eq(customerAccounts.id, accountAId));
    await getDatabase()
      .delete(customerAccounts)
      .where(eq(customerAccounts.id, accountBId));
    await getDatabase().delete(users).where(eq(users.id, ownerAId));
    await getDatabase().delete(users).where(eq(users.id, ownerBId));
    await closeDatabase();
    delete process.env.DATABASE_URL;
  });

  it("keeps owner lists and customer history isolated on PostgreSQL", async () => {
    const ownerAOrder = await store.create(input({ accessCode: "pg-owner-a" }));
    await store.create(
      input({
        ownerId: ownerBId,
        draftId: draftBId,
        accessCode: "pg-owner-b",
        customerEmail: "kofi@example.com",
      }),
    );

    expect(
      (await store.listForOwner(ownerAId, { limit: 50 })).map(
        (order: { accessCode: string }) => order.accessCode,
      ),
    ).toEqual(["pg-owner-a"]);
    expect(await store.listForCustomer(accountAId)).toEqual([]);

    const claimed = await store.claimForCustomer(
      accountAId,
      ownerAOrder.accessCode,
    );
    expect(claimed?.customerAccountId).toBe(accountAId);
    expect(
      (await store.listForCustomer(accountAId)).map(
        (order: { accessCode: string }) => order.accessCode,
      ),
    ).toEqual(["pg-owner-a"]);
    expect(
      await store.getForCustomer(accountAId, ownerAOrder.id),
    ).not.toBeNull();
    expect(await store.getForCustomer(accountBId, ownerAOrder.id)).toBeNull();
    expect(
      await store.claimForCustomer(accountBId, ownerAOrder.accessCode),
    ).toBe(null);
    expect(await store.listForCustomer(accountBId)).toEqual([]);
  });
});
