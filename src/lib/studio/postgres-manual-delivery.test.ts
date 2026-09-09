/**
 * PostgreSQL contract tests for the Stage 6c shop-side writes.
 *
 * Two things are proved against the real database engine:
 *
 *  - the two atomic manual marks (`markDeliveryDeliveredByShop`,
 *    `markDeliveryFailedByShop`): the guarded UPDATE behaves identically on
 *    PostgreSQL — one winner, refused transitions answered by re-reading the
 *    row, delivered terminal;
 *  - `patchCatalogueItemAsShop` on `PostgresStudioDraftStore`: the
 *    compare-and-set on `revision` bumps it by exactly one per write and the
 *    item patch changes nothing else in the brief.
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
  id: "pg-manual-delivery-owner",
  login: "manual-delivery-owner",
  name: "Manual Delivery Owner",
};

describe.runIf(connectionString)(
  "PostgreSQL shop-side marks and catalogue patch",
  () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let ordersStore: any;
    let deliveriesStore: any;
    let drafts: any;
    let manualDelivery: any;
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

    beforeAll(async () => {
      process.env.DATABASE_URL = connectionString;
      const orders = await import("./orders");
      const deliveries = await import("./bundle-delivery");
      const draftStore = await import("./draft-store");
      const marks = await import("./manual-delivery");
      const defaults = await import("./site-brief/defaults");
      const db = await import("@/db");
      const schema = await import("@/db/schema");
      const drizzle = await import("drizzle-orm");
      const identity = await import("@/lib/user-identity");

      ordersStore = new orders.PostgresOrdersStore();
      deliveriesStore = new deliveries.PostgresBundleDeliveriesStore();
      drafts = new draftStore.PostgresStudioDraftStore();
      manualDelivery = marks;
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
            businessName: "PG Manual Shop",
            category: "data-bundles",
            plan: "starter",
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

    function paidOrder(overrides: Record<string, unknown> = {}) {
      return {
        ownerId,
        draftId,
        accessCode: `pg-manual-${Date.now()}-${Math.random()}`,
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
        ...overrides,
      };
    }

    async function manualRow(): Promise<{ id: string }> {
      const order = await ordersStore.create(paidOrder());
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
          provider: "manual",
        },
      ]);
      return row;
    }

    it("marks a pending manual row delivered atomically, touching only the allowed fields", async () => {
      const row = await manualRow();

      const updated = await manualDelivery.markDeliveryDeliveredByShop(row.id);

      expect(updated.status).toBe("delivered");
      expect(updated.deliveredAt).toBeTruthy();
      expect(updated.lastError).toBeUndefined();
      expect(updated.provider).toBe("manual");
      expect(updated.attempts).toBe(0);
    });

    it("refuses a second delivered mark with the exact 409 sentence (I3)", async () => {
      const row = await manualRow();
      await manualDelivery.markDeliveryDeliveredByShop(row.id);

      await expect(
        manualDelivery.markDeliveryDeliveredByShop(row.id),
      ).rejects.toMatchObject({
        status: 409,
        message: "This top-up is already delivered.",
      });
    });

    it("marks a pending manual row failed with the note, and refuses a repeat", async () => {
      const row = await manualRow();

      const updated = await manualDelivery.markDeliveryFailedByShop(
        row.id,
        "no float",
      );
      expect(updated.status).toBe("failed");
      expect(updated.lastError).toBe("no float");

      await expect(
        manualDelivery.markDeliveryFailedByShop(row.id, "again"),
      ).rejects.toMatchObject({
        status: 409,
        message: "This top-up is already marked as failed.",
      });
    });

    it("two parallel delivered marks give exactly one winner", async () => {
      const row = await manualRow();

      const outcomes = await Promise.allSettled([
        manualDelivery.markDeliveryDeliveredByShop(row.id),
        manualDelivery.markDeliveryDeliveredByShop(row.id),
      ]);
      const wins = outcomes.filter((o) => o.status === "fulfilled");
      const conflicts = outcomes.filter(
        (o) =>
          o.status === "rejected" &&
          o.reason instanceof Error &&
          o.reason.message === "This top-up is already delivered.",
      );
      expect(wins).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
    });

    it("patchCatalogueItemAsShop bumps the revision by exactly one per write and changes only the item", async () => {
      const before = await drafts.get(owner, draftId);
      expect(
        before.brief.items.find((i: { id: string }) => i.id === "b1").price,
      ).toBe(10);

      const patched = await drafts.patchCatalogueItemAsShop(draftId, "b1", {
        price: 12.5,
      });
      expect(patched.revision).toBe(before.revision + 1);
      expect(
        patched.brief.items.find((i: { id: string }) => i.id === "b1").price,
      ).toBe(12.5);
      expect(patched.brief.businessName).toBe(before.brief.businessName);

      const paused = await drafts.patchCatalogueItemAsShop(draftId, "b1", {
        paused: true,
      });
      expect(paused.revision).toBe(before.revision + 2);
      expect(
        paused.brief.items.find((i: { id: string }) => i.id === "b1").paused,
      ).toBe(true);
    });

    it("patchCatalogueItemAsShop answers 404 for an unknown item", async () => {
      await expect(
        drafts.patchCatalogueItemAsShop(draftId, "no-such-item", { price: 5 }),
      ).rejects.toMatchObject({ status: 404 });
    });
  },
);
