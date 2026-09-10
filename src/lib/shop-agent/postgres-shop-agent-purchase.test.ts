/**
 * PostgreSQL contract tests for Stage 7b agent order ledger methods —
 * `purchase`, `refund`, `getEntryForOrder`, and the `agent_id` order column.
 *
 * These run against the CI-only throwaway database and skip locally:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import type { OrderRecord } from "@/lib/studio/orders";
import type { WalletEntry } from "./store";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";
const owner: SessionUser = {
  id: `pg-agent-purchase-owner-${process.pid}`,
  login: "pg-agent-purchase-owner",
  name: "Agent Purchase Test Owner",
};

describe.runIf(connectionString)("PostgreSQL agent order ledger", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let drafts: any;
  let orders: any;
  let db: any;
  let closeDatabase: any;
  let studioDrafts: any;
  let studioOrders: any;
  let users: any;
  let eq: any;
  let ensureStudioUser: any;
  let createDefaultBrief: any;
  let apiErrors: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerId = "";
  let draftId = "";

  async function activeAgent(email: string) {
    const invited = await store.createInvite({
      draftId,
      email,
      name: "Agent One",
      invitedBy: ownerId,
    });
    const inviteToken = await store.createInviteToken(invited.id);
    const agent = await store.acceptInvite(
      inviteToken.token,
      "Agent One",
      PASSWORD,
    );
    expect(agent).toMatchObject({ id: invited.id, status: "active" });
    return agent;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");

    const agentStore = await import("./store");
    const ordersStore = await import("@/lib/studio/orders");
    const draftStore = await import("@/lib/studio/draft-store");
    const defaults = await import("@/lib/studio/site-brief/defaults");
    const database = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");
    const identity = await import("@/lib/user-identity");
    apiErrors = await import("@/lib/api-errors");

    store = new agentStore.PostgresShopAgentStore();
    orders = new ordersStore.PostgresOrdersStore();
    drafts = new draftStore.PostgresStudioDraftStore();
    db = database.getDatabase();
    closeDatabase = database.closeDatabase;
    studioDrafts = schema.studioDrafts;
    studioOrders = schema.studioOrders;
    users = schema.users;
    eq = drizzle.eq;
    ensureStudioUser = identity.ensureStudioUser;
    createDefaultBrief = defaults.createDefaultBrief;
    ownerId = await ensureStudioUser(owner);

    draftId = (
      await drafts.create(
        owner,
        createDefaultBrief({
          businessName: "Postgres Agent Orders Shop",
          category: "data-bundles",
          plan: "command_center",
          items: [
            {
              id: "bundle-00",
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
    if (db && studioDrafts && eq && ownerId) {
      await db.delete(studioDrafts).where(eq(studioDrafts.ownerId, ownerId));
      await db.delete(users).where(eq(users.id, ownerId));
    }
    if (closeDatabase) await closeDatabase();
    vi.unstubAllEnvs();
    delete process.env.DATABASE_URL;
  });

  it("debits a purchase with a negative entry, and the order row carries the agent id", async () => {
    const agent = await activeAgent("purchase-agent@example.com");
    await store.credit({
      agentId: agent.id,
      amountMinor: 5000,
      createdBy: ownerId,
    });

    const order = await orders.create({
      ownerId,
      draftId,
      accessCode: "a".repeat(32),
      status: "pending",
      currency: "GHS",
      subtotal: 9.2,
      deliveryFee: 0,
      total: 9.2,
      lines: [
        { itemId: "bundle-00", name: "MTN 1GB", price: 9.2, quantity: 1 },
      ],
      customerName: "Agent One",
      customerPhone: "0240000001",
      recipientPhone: "0240000001",
      paymentMethod: "agent_wallet",
      paymentMode: "test",
      agentId: agent.id,
    });
    expect(order.agentId).toBe(agent.id);
    expect(order.paidAt).toBeUndefined();
    // Round trip through the SQL, not just the returning row.
    expect((await orders.getById(order.id))?.agentId).toBe(agent.id);
    const [row] = await db
      .select()
      .from(studioOrders)
      .where(eq(studioOrders.id, order.id));
    expect(row.agentId).toBe(agent.id);
    expect(row.paidAt).toBeNull();

    const entry = await store.purchase({
      agentId: agent.id,
      orderId: order.id,
      amountMinor: 920,
      createdBy: agent.id,
    });
    expect(entry.kind).toBe("purchase");
    expect(entry.amount).toBe(-9.2);
    expect(entry.orderId).toBe(order.id);
    expect(entry.createdBy).toBe(agent.id);
    expect((await store.getById(agent.id))?.balance).toBe(40.8);
    expect((await store.getEntryForOrder(order.id, "purchase"))?.id).toBe(
      entry.id,
    );

    // The agent-scoped reads see exactly this agent's order, nobody else's.
    expect(await orders.getForAgent(agent.id, order.id)).toMatchObject({
      id: order.id,
      agentId: agent.id,
    });
    expect(await orders.getForAgent("somebody-else", order.id)).toBeNull();
    expect(
      (await orders.listForAgent(agent.id)).map((o: OrderRecord) => o.id),
    ).toEqual([order.id]);
    expect(
      await orders.listForOwner(ownerId, { draftId, agentId: agent.id }),
    ).toHaveLength(1);
    expect(
      await orders.listForOwner(ownerId, { draftId, agentId: "nobody" }),
    ).toEqual([]);
  });

  it("a raced second purchase returns the very same entry and the wallet moves once", async () => {
    const agent = await activeAgent("race-purchase@example.com");
    await store.credit({
      agentId: agent.id,
      amountMinor: 5000,
      createdBy: ownerId,
    });
    const orderId = "44444444-5555-4666-8777-888888888888";
    const results = await Promise.allSettled([
      store.purchase({
        agentId: agent.id,
        orderId,
        amountMinor: 920,
        createdBy: agent.id,
      }),
      store.purchase({
        agentId: agent.id,
        orderId,
        amountMinor: 920,
        createdBy: agent.id,
      }),
    ]);
    const entries = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<WalletEntry>).value);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(entries[1].id);
    expect(
      (await store.listEntries(agent.id)).filter(
        (e: WalletEntry) => e.kind === "purchase",
      ),
    ).toHaveLength(1);
    expect((await store.getById(agent.id))?.balance).toBe(40.8);
  });

  it("a raced second refund gets WalletAlreadyRefundedError and the wallet moves once", async () => {
    const agent = await activeAgent("race-refund@example.com");
    await store.credit({
      agentId: agent.id,
      amountMinor: 5000,
      createdBy: ownerId,
    });
    const orderId = "55555555-6666-4777-8888-999999999999";
    await store.purchase({
      agentId: agent.id,
      orderId,
      amountMinor: 920,
      createdBy: agent.id,
    });
    const results = await Promise.allSettled([
      store.refund({
        agentId: agent.id,
        orderId,
        amountMinor: 920,
        createdBy: ownerId,
      }),
      store.refund({
        agentId: agent.id,
        orderId,
        amountMinor: 920,
        createdBy: ownerId,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null,
    ).toBeInstanceOf(apiErrors.WalletAlreadyRefundedError);
    expect(
      (await store.listEntries(agent.id)).filter(
        (e: WalletEntry) => e.kind === "refund",
      ),
    ).toHaveLength(1);
    expect((await store.getById(agent.id))?.balance).toBe(50);
  });
});
