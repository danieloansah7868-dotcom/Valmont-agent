import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { SqliteOrdersStore, type NewOrderInput } from "./orders";

const dirs: string[] = [];
let store: SqliteOrdersStore;

function newOrder(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  return {
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: "code-abc",
    status: "pending",
    currency: "GHS",
    subtotal: 120,
    deliveryFee: 15,
    total: 135,
    lines: [
      { itemId: "i1", name: "Jollof Rice", price: 45, quantity: 2 },
      { itemId: "i2", name: "Banku", price: 30, quantity: 1 },
    ],
    customerName: "Ama",
    customerPhone: "+233240000000",
    paymentMethod: "valmont_pay",
    ...overrides,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-orders-"));
  dirs.push(dir);
  const chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  store = new SqliteOrdersStore();
});

afterEach(() => {
  vi.useRealTimers();
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("SqliteOrdersStore", () => {
  it("creates an order and reads it back by access code", async () => {
    const created = await store.create(newOrder());
    expect(created.id).toBeTruthy();
    expect(created.total).toBe(135);
    expect(created.lines).toHaveLength(2);

    const fetched = await store.getByAccessCode("code-abc");
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.customerName).toBe("Ama");
    // Money survives the integer-minor-unit round trip exactly.
    expect(fetched?.subtotal).toBe(120);
    expect(fetched?.deliveryFee).toBe(15);
  });

  it("marks a pending order paid, once", async () => {
    await store.create(newOrder());
    const paid = await store.markPaid("code-abc", "ref-1");
    expect(paid?.status).toBe("paid");
    expect(paid?.paymentRef).toBe("ref-1");
    expect(paid?.paidAt).toBeTruthy();

    // A second webhook must not rewind or duplicate the paid state.
    const again = await store.markPaid("code-abc", "ref-2");
    expect(again?.status).toBe("paid");
    expect(again?.paymentRef).toBe("ref-1");
  });

  it("marks a pending order failed", async () => {
    await store.create(newOrder());
    const failed = await store.markFailed("code-abc");
    expect(failed?.status).toBe("payment_failed");
  });

  it("lists an owner's orders newest first", async () => {
    await store.create(newOrder({ accessCode: "c1" }));
    await store.create(newOrder({ accessCode: "c2" }));
    const list = await store.listForOwner("owner-1");
    expect(list).toHaveLength(2);
  });

  it("keeps orders private to their owner", async () => {
    const created = await store.create(newOrder());
    expect(await store.getForOwner("owner-1", created.id)).not.toBeNull();
    expect(await store.getForOwner("someone-else", created.id)).toBeNull();
  });

  it("filters a business without crossing the owner boundary", async () => {
    await store.create(
      newOrder({ accessCode: "owner-1-a", draftId: "draft-a" }),
    );
    await store.create(
      newOrder({ accessCode: "owner-1-b", draftId: "draft-b" }),
    );
    await store.create(
      newOrder({
        accessCode: "owner-2-a",
        ownerId: "owner-2",
        draftId: "draft-a",
      }),
    );

    const ownerOneBusiness = await store.listForOwner("owner-1", {
      draftId: "draft-a",
      limit: 50,
    });
    expect(ownerOneBusiness.map((order) => order.accessCode)).toEqual([
      "owner-1-a",
    ]);

    const ownerTwoBusiness = await store.listForOwner("owner-2", {
      draftId: "draft-a",
      limit: 50,
    });
    expect(ownerTwoBusiness.map((order) => order.accessCode)).toEqual([
      "owner-2-a",
    ]);
  });

  it("applies created-at bounds in the database query before returning orders", async () => {
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    await store.create(newOrder({ accessCode: "old-order" }));
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    await store.create(newOrder({ accessCode: "recent-order" }));

    const recent = await store.listForOwner("owner-1", {
      limit: 50,
      createdAfter: "2026-08-26T00:00:00.000Z",
      createdBefore: "2026-08-27T00:00:00.000Z",
    });
    expect(recent.map((order) => order.accessCode)).toEqual(["recent-order"]);
    vi.useRealTimers();
  });

  it("finds an order by its id for the confirmation page", async () => {
    const created = await store.create(newOrder());
    const byId = await store.getById(created.id);
    expect(byId?.accessCode).toBe("code-abc");
  });

  it("walks a paid order through preparing, out for delivery and delivered", async () => {
    const created = await store.create(newOrder());
    await store.markPaid("code-abc", "ref-1");
    const preparing = await store.updateStatus(
      "owner-1",
      created.id,
      "preparing",
    );
    expect(preparing?.status).toBe("preparing");
    expect(preparing?.preparingAt).toBeTruthy();
    const out = await store.updateStatus(
      "owner-1",
      created.id,
      "out_for_delivery",
    );
    expect(out?.status).toBe("out_for_delivery");
    const delivered = await store.updateStatus(
      "owner-1",
      created.id,
      "delivered",
    );
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.statusHistory.map((event) => event.status)).toEqual([
      "pending",
      "paid",
      "preparing",
      "out_for_delivery",
      "delivered",
    ]);
  });

  it("refuses to start preparing an unpaid order", async () => {
    const created = await store.create(newOrder());
    await expect(
      store.updateStatus("owner-1", created.id, "preparing"),
    ).rejects.toThrow(/cannot move/);
  });

  it("keeps a customer note on the order", async () => {
    const created = await store.create(
      newOrder({ merchantNote: "No onions please" }),
    );
    expect(created.merchantNote).toBe("No onions please");
  });
});
