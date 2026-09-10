/**
 * Stage 7b — the agent-scoped parts of the orders store.
 *
 * `agent_id` is set only by the agent buy route; these pin that every read
 * honouring it (listForAgent, getForAgent, listForOwner's agentId option)
 * is scoped by the column itself, so "another agent's order" is not an
 * answer any caller can ever get (R9), and that create() still leaves
 * paid_at alone (R4).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSqliteChatStore,
  setSqliteChatStoreForTests,
  SqliteChatStore,
} from "@/lib/chat-store";
import { SqliteOrdersStore, type NewOrderInput } from "./orders";

let dir: string;
let store: SqliteOrdersStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-agent-orders-"));
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  store = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function agentOrder(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  return {
    ownerId: "owner-1",
    draftId: "draft-1",
    accessCode: "b".repeat(32),
    status: "pending",
    currency: "GHS",
    subtotal: 9.2,
    deliveryFee: 0,
    total: 9.2,
    lines: [{ itemId: "bundle-00", name: "MTN 1GB", price: 9.2, quantity: 1 }],
    customerName: "Agent One",
    customerPhone: "0240000001",
    recipientPhone: "0240000001",
    paymentMethod: "agent_wallet",
    paymentMode: "test",
    agentId: "agent-1",
    ...overrides,
  };
}

describe("SqliteOrdersStore agent orders", () => {
  it("round-trips agent_id and leaves paid_at alone on create", async () => {
    const order = await store.create(agentOrder());
    expect(order.agentId).toBe("agent-1");
    expect(order.paidAt).toBeUndefined();
    const row = getSqliteChatStore()
      .connection.prepare(
        "SELECT agent_id, paid_at FROM studio_orders WHERE id = ?",
      )
      .get(order.id) as { agent_id: string | null; paid_at: string | null };
    expect(row.agent_id).toBe("agent-1");
    expect(row.paid_at).toBeNull();
    // A public order without agentId keeps the column empty.
    const publicOrder = await store.create(
      agentOrder({ accessCode: "c".repeat(32), agentId: undefined }),
    );
    expect(publicOrder.agentId).toBeUndefined();
  });

  it("listForAgent is scoped by agent_id and newest first", async () => {
    const first = await store.create(
      agentOrder({ accessCode: "1".repeat(32), agentId: "agent-1" }),
    );
    const second = await store.create(
      agentOrder({ accessCode: "2".repeat(32), agentId: "agent-2" }),
    );
    const third = await store.create(
      agentOrder({ accessCode: "3".repeat(32), agentId: "agent-1" }),
    );
    const mine = await store.listForAgent("agent-1");
    expect(mine.map((order) => order.id)).toEqual([third.id, first.id]);
    expect((await store.listForAgent("agent-2")).map((o) => o.id)).toEqual([
      second.id,
    ]);
    expect(await store.listForAgent("nobody")).toEqual([]);
  });

  it("getForAgent returns only the owner's copy — anything else is null", async () => {
    const mine = await store.create(agentOrder({ agentId: "agent-1" }));
    const other = await store.create(
      agentOrder({ accessCode: "4".repeat(32), agentId: "agent-2" }),
    );
    expect(await store.getForAgent("agent-1", mine.id)).toMatchObject({
      id: mine.id,
      agentId: "agent-1",
    });
    // Another agent's id, and an order that has no agent at all, read as 404.
    expect(await store.getForAgent("agent-1", other.id)).toBeNull();
    expect(await store.getForAgent("agent-2", "missing")).toBeNull();
    const publicOrder = await store.create(
      agentOrder({ accessCode: "5".repeat(32), agentId: undefined }),
    );
    expect(await store.getForAgent("agent-1", publicOrder.id)).toBeNull();
  });

  it("listForOwner drafts down to one agent without touching the other filters", async () => {
    const own = await store.create(
      agentOrder({ accessCode: "6".repeat(32), agentId: "agent-a" }),
    );
    await store.create(
      agentOrder({
        accessCode: "7".repeat(32),
        agentId: "agent-b",
        draftId: "draft-2",
      }),
    );
    expect(
      await store.listForOwner("owner-1", {
        draftId: "draft-1",
        agentId: "agent-a",
      }),
    ).toMatchObject([{ id: own.id }]);
    expect(
      await store.listForOwner("owner-1", {
        draftId: "draft-1",
        agentId: "agent-b",
      }),
    ).toEqual([]);
    // Without the option the list still answers exactly as before.
    expect(
      await store.listForOwner("owner-1", { draftId: "draft-1" }),
    ).toMatchObject([{ id: own.id }]);
  });

  it("upgrades an old database in place: agent_id appears and old rows stay readable", async () => {
    const db = getSqliteChatStore().connection;
    // A normal 7b order… then rewind the table to its pre-Stage-7b shape:
    // drop the index and the column, exactly what a deployment predating
    // this change has. Reopening must re-add both without touching the row.
    await store.create(agentOrder({ draftId: "draft-old" }));
    db.exec("DROP INDEX IF EXISTS studio_orders_agent_created_idx");
    db.exec("ALTER TABLE studio_orders DROP COLUMN agent_id");
    const upgraded = new SqliteOrdersStore();
    // The schema runs lazily on first use, like production startup.
    const oldOrders = await upgraded.listForOwner("owner-1", { limit: 10 });
    const columns = db
      .prepare("PRAGMA table_info(studio_orders)")
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "agent_id")).toBe(true);
    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'studio_orders_agent_created_idx'",
      )
      .get() as { name: string } | undefined;
    expect(index?.name).toBe("studio_orders_agent_created_idx");
    expect(oldOrders).toHaveLength(1);
    expect(oldOrders[0]?.agentId).toBeUndefined();
    const fresh = await upgraded.create(
      agentOrder({ accessCode: "9".repeat(32), agentId: "agent-9" }),
    );
    expect((await upgraded.getForAgent("agent-9", fresh.id))?.id).toBe(
      fresh.id,
    );
  });
});
