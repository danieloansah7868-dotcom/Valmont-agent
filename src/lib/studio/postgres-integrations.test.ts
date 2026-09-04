/**
 * PostgreSQL integration contract tests (Stage 5).
 *
 * Migration `0014_studio_integrations` adds the table the TechChief key lives
 * in, the unique (draft_id, provider) index that makes "one connection per
 * website" a database rule rather than a hope, the cascade that cleans it up
 * with its website, and the `provider_ref` index the webhook's lookup depends
 * on. Those are engine behaviours, so they are checked against the real
 * engine. Skipped when no throwaway database is supplied:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const owner: SessionUser = {
  id: "pg-integrations-owner",
  login: "integrations-owner",
  name: "Integrations Owner",
};

const apiKey = "TCHX-0A1B2C3D4E5F60718293A4B5C6D7E8F9";

describe.runIf(connectionString)("PostgreSQL studio integrations", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let ordersStore: any;
  let deliveriesStore: any;
  let drafts: any;
  let getDatabase: any;
  let closeDatabase: any;
  let studioIntegrations: any;
  let studioDeliveries: any;
  let studioDrafts: any;
  let studioOrders: any;
  let users: any;
  let eq: any;
  let ensureStudioUser: any;
  let createDefaultBrief: any;
  let integrations: any;
  let security: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerId = "";
  let draftId = "";

  function write(overrides: Record<string, unknown> = {}) {
    return {
      draftId,
      ownerId,
      provider: "techchief" as const,
      apiKeyEnc: security.encryptSessionValue(apiKey),
      keyPrefix: integrations.techChiefKeyPrefix(apiKey),
      webhookSecretEnc: null,
      status: "verified" as const,
      walletBalance: 120.5,
      lowBalance: false,
      accountStatus: "active",
      lastError: null,
      bundles: [
        {
          id: 101,
          network: "MTN",
          sizeGb: 1,
          validityDays: 30,
          price: 6.2,
          currency: "GHS",
        },
      ],
      bundlesSyncedAt: new Date().toISOString(),
      pollWindowStart: new Date().toISOString(),
      pollCount: 0,
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
    integrations = await import("./integrations");
    const orders = await import("./orders");
    const deliveries = await import("./bundle-delivery");
    const draftStore = await import("./draft-store");
    const defaults = await import("./site-brief/defaults");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");
    const identity = await import("@/lib/user-identity");
    security = await import("@/lib/security");

    store = new integrations.PostgresIntegrationsStore();
    ordersStore = new orders.PostgresOrdersStore();
    deliveriesStore = new deliveries.PostgresBundleDeliveriesStore();
    drafts = new draftStore.PostgresStudioDraftStore();
    createDefaultBrief = defaults.createDefaultBrief;
    ensureStudioUser = identity.ensureStudioUser;
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    studioIntegrations = schema.studioIntegrations;
    studioDeliveries = schema.studioDeliveries;
    studioDrafts = schema.studioDrafts;
    studioOrders = schema.studioOrders;
    users = schema.users;
    eq = drizzle.eq;

    ownerId = await ensureStudioUser(owner);
    draftId = (
      await drafts.create(
        owner,
        createDefaultBrief({
          businessName: "PG Integration Shop",
          category: "data-bundles",
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await getDatabase()
      .delete(studioIntegrations)
      .where(eq(studioIntegrations.ownerId, ownerId));
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
    vi.unstubAllEnvs();
    delete process.env.DATABASE_URL;
  });

  it("keeps exactly one connection per website through the unique index", async () => {
    const first = await store.insert(write());
    expect(first).not.toBeNull();

    // Saving a new key for the same website replaces the row instead of adding
    // a second one — the database enforces it, not the application.
    const second = await store.insert(
      write({
        apiKeyEnc: security.encryptSessionValue(
          "TCHX-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
        ),
        keyPrefix: "TCHX-FFFF",
        walletBalance: 10,
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.key_prefix).toBe("TCHX-FFFF");
    const rows = await getDatabase()
      .select()
      .from(studioIntegrations)
      .where(eq(studioIntegrations.draftId, draftId));
    expect(rows).toHaveLength(1);
  });

  it("stores the key as ciphertext and reads it back only through the secret path", async () => {
    await store.insert(
      write({
        apiKeyEnc: security.encryptSessionValue(apiKey),
        keyPrefix: integrations.techChiefKeyPrefix(apiKey),
      }),
    );

    const row = await store.getForDraft(draftId);
    expect(row.api_key_enc).not.toContain(apiKey);
    expect(row.key_prefix).toBe("TCHX-0A1B");

    const plain = await integrations.getTechChiefIntegration(draftId);
    expect(JSON.stringify(plain)).not.toContain(apiKey);

    const withKey = await integrations.getTechChiefIntegrationWithKey(draftId);
    expect(withKey.apiKey).toBe(apiKey);
  });

  it("keeps wallet_balance to the cent on a numeric(12,2) column", async () => {
    await store.insert(write({ walletBalance: 1234567.89 }));
    const row = await store.getForDraft(draftId);
    expect(Number(row.wallet_balance)).toBe(1234567.89);

    await store.patch(row.id, { walletBalance: 0 });
    expect(Number((await store.getById(row.id)).wallet_balance)).toBe(0);

    await store.patch(row.id, { walletBalance: null });
    expect((await store.getById(row.id)).wallet_balance).toBeNull();
  });

  it("round-trips the cached price list through jsonb", async () => {
    await store.insert(write());
    const cached = integrations.parseCachedBundles(
      (await store.getForDraft(draftId)).bundles_json,
    );
    expect(cached).toEqual([
      {
        id: 101,
        network: "MTN",
        sizeGb: 1,
        validityDays: 30,
        price: 6.2,
        currency: "GHS",
      },
    ]);
  });

  it("counts the hour's requests in the database and rolls the window over", async () => {
    // A fixed window start keeps the arithmetic independent of when the suite
    // happens to run: the first two calls fall inside it, the third an hour on.
    const now = Date.parse("2026-09-01T10:00:00.000Z");
    await store.insert(
      write({
        pollCount: 0,
        pollWindowStart: new Date(now - 60_000).toISOString(),
      }),
    );
    const row = await store.getForDraft(draftId);

    const first = await integrations.consumeTechChiefBudget(
      store,
      row.id,
      "poll",
      now,
    );
    expect(first).toMatchObject({ allowed: true, spent: 1 });

    const second = await integrations.consumeTechChiefBudget(
      store,
      row.id,
      "poll",
      now + 60_000,
    );
    expect(second).toMatchObject({ allowed: true, spent: 2 });

    // An hour later the stored window is stale, so the count starts again.
    const rolled = await integrations.consumeTechChiefBudget(
      store,
      row.id,
      "poll",
      now + 61 * 60_000,
    );
    expect(rolled).toMatchObject({ allowed: true, spent: 1 });
  });

  it("stops polling at the budget but still lets an order through", async () => {
    await store.insert(
      write({
        pollCount: integrations.TECHCHIEF_HOURLY_POLL_BUDGET,
        pollWindowStart: new Date().toISOString(),
      }),
    );
    const row = await store.getForDraft(draftId);
    const now = Date.now();

    const poll = await integrations.consumeTechChiefBudget(
      store,
      row.id,
      "poll",
      now,
    );
    expect(poll.allowed).toBe(false);

    // The headroom is a customer's top-up, so it is never refused first.
    const order = await integrations.consumeTechChiefBudget(
      store,
      row.id,
      "order",
      now,
    );
    expect(order.allowed).toBe(true);
  });

  it("removes a connection with its website through the cascade", async () => {
    const doomed = await drafts.create(
      owner,
      createDefaultBrief({
        businessName: "PG Doomed Shop",
        category: "data-bundles",
      }),
    );
    await store.insert(write({ draftId: doomed.id }));
    expect(await store.getForDraft(doomed.id)).not.toBeNull();

    await drafts.delete(owner, doomed.id);

    expect(await store.getForDraft(doomed.id)).toBeNull();
    // The surviving website's connection is untouched.
    expect(await store.getForDraft(draftId)).not.toBeNull();
  });

  it("finds a delivery by provider_ref, the webhook's only handle", async () => {
    const order = await ordersStore.create({
      ownerId,
      draftId,
      accessCode: `pg-integration-${Date.now()}`,
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
    const created = await deliveriesStore.createMany([
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
    expect(created).toHaveLength(1);

    // The provider reference only exists once the send has been claimed and
    // accepted — exactly the state the webhook later looks the row up in.
    const providerRef = `DEV-${Date.now()}`;
    expect(
      await deliveriesStore.claimForDispatch(created[0].id, {
        provider: "techchief",
      }),
    ).toBe(true);
    await deliveriesStore.setProviderRef(created[0].id, providerRef);

    const found = await deliveriesStore.listByProviderRef(providerRef);
    expect(found.map((row: { id: string }) => row.id)).toEqual([created[0].id]);
    expect(await deliveriesStore.listByProviderRef("DEV-nothing")).toEqual([]);
  });

  it("removes every connection for one website and reports how many", async () => {
    await store.insert(write());
    expect(await store.removeForDraft(draftId)).toBe(1);
    expect(await store.removeForDraft(draftId)).toBe(0);
    expect(await store.getForDraft(draftId)).toBeNull();
  });
});
