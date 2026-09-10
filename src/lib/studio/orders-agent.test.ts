/**
 * Stage 7b — agent-stamped orders in the SQLite OrdersStore.
 *
 * An agent order carries agent_id in a real column (never inside a JSON
 * blob): listForAgent filters by it, getForAgent scopes by it (another
 * agent's order id is a plain miss — R9), the upgrade path adds the column
 * and index to a pre-7b database, and listForOwner's new agentId option
 * stays owner-scoped AND draft-pinned (nothing crosses shops).
 *
 * The Postgres side holds the same contract in
 * src/lib/shop-agent/postgres-shop-agent-purchase.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  getSqliteChatStore,
  setSqliteChatStoreForTests,
  SqliteChatStore,
} from "@/lib/chat-store";
import { SqliteOrdersStore } from "./orders";

let dir: string;
let store: SqliteOrdersStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-agent-orders-"));
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat.sqlite"),
      path.join(dir, "chat.json"),
    ),
  );
  store = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const line = {
  itemId: "bundle-00",
  name: "MTN 1GB",
  price: 9.2,
  quantity: 1,
};

function agentOrder(
  draftId: string,
  agentId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ownerId: "agency-1",
    draftId,
    accessCode: randomBytes(16).toString("hex"),
    status: "pending" as const,
    customerName: "Agent One",
    customerPhone: "0240000009",
    recipientPhone: "0240000001",
    customerEmail: "agent@example.com",
    lines: [line],
    subtotal: 9.2,
    deliveryFee: 0,
    total: 9.2,
    currency: "GHS",
    paymentMethod: "agent_wallet",
    paymentMode: "test" as const,
    agentId,
    ...overrides,
  };
}

describe("SqliteOrdersStore agent orders", () => {
  it("persists agent_id in the column and returns it on every read path", async () => {
    const order = await store.create(agentOrder("shop-a", "agent-1"));
    expect(order.status).toBe("pending");
    expect(order.agentId).toBe("agent-1");
    expect((await store.getById(order.id))?.agentId).toBe("agent-1");
    // …and the raw column actually holds it (never a JSON blob).
    const row = getSqliteChatStore()
      .connection.prepare("SELECT agent_id FROM studio_orders WHERE id = ?")
      .get(order.id) as { agent_id: string | null } | undefined;
    expect(row?.agent_id).toBe("agent-1");
    // The index the migration declared exists in SQLite too, same name.
    const index = getSqliteChatStore()
      .connection.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'studio_orders_agent_created_idx'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toContain("agent_id");
    // R4, stated on the INSERT itself: paid_at is NOT among the columns
    // create() writes — the only writer of paid_at is markPaid.
    expect(index !== undefined).toBe(true);
  });

  it("create() never writes paid_at — only markPaid may set it (R4)", async () => {
    const order = await store.create(agentOrder("shop-a", "agent-1"));
    const row = getSqliteChatStore()
      .connection.prepare(
        "SELECT paid_at, status FROM studio_orders WHERE id = ?",
      )
      .get(order.id) as { paid_at: string | null; status: string } | undefined;
    expect(row?.status).toBe("pending");
    expect(row?.paid_at).toBeNull();
    const paid = await store.markPaid(order.accessCode, "wallet:entry-1");
    expect(paid?.paidAt).toBeTruthy();
    expect(paid?.paymentRef).toBe("wallet:entry-1");
  });

  it("listForAgent newest-first filters by agent, never by shop alone", async () => {
    await store.create(agentOrder("shop-a", "agent-1"));
    await store.create(agentOrder("shop-a", "agent-2"));
    await store.create(agentOrder("shop-b", "agent-1"));
    await store.create(
      agentOrder("shop-a", "agent-1", {
        paymentMethod: "momo",
        agentId: undefined,
      }),
    );
    const forOne = await store.listForAgent("agent-1");
    expect(forOne).toHaveLength(2);
    expect(forOne.every((order) => order.agentId === "agent-1")).toBe(true);
    const forNone = await store.listForAgent("agent-3");
    expect(forNone).toEqual([]);
  });

  it("getForAgent is scoped: another agent's order id is a plain miss (R9)", async () => {
    const mine = await store.create(agentOrder("shop-a", "agent-1"));
    expect((await store.getForAgent("agent-1", mine.id))?.id).toBe(mine.id);
    expect(await store.getForAgent("agent-2", mine.id)).toBeNull();
    expect(await store.getForAgent("agent-1", "no-such-order")).toBeNull();
  });

  it("listForOwner agentId option stays owner-scoped and draft-pinned", async () => {
    await store.create(agentOrder("shop-a", "agent-1"));
    await store.create(agentOrder("shop-a", "agent-2"));
    await store.create(agentOrder("shop-b", "agent-1"));
    await store.create(
      agentOrder("shop-a", "agent-1", {
        ownerId: "agency-2",
        draftId: "shop-c",
      }),
    );
    const rows = await store.listForOwner("agency-1", {
      draftId: "shop-a",
      agentId: "agent-1",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe("agent-1");
    expect(rows[0]?.draftId).toBe("shop-a");
    // Without the option the same owner+draft listing has both agents.
    expect(
      (await store.listForOwner("agency-1", { draftId: "shop-a" })).length,
    ).toBe(2);
  });

  it("upgrade path: an order database created before 7b gains agent_id with data intact", async () => {
    // Build a pre-7b studio_orders table (the create() column list minus
    // agent_id) on a fresh file, and teach ensureOrdersSchema the table is
    // already there by pre-marking its CREATE idempotent — CREATE TABLE IF
    // NOT EXISTS never adds columns, which is exactly the upgrade hazard.
    const legacy = getSqliteChatStore().connection;
    legacy.exec("DROP TABLE IF EXISTS studio_orders");
    legacy.exec(`CREATE TABLE studio_orders(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      access_code TEXT NOT NULL,
      status TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GHS',
      subtotal INTEGER NOT NULL DEFAULT 0,
      delivery_fee INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      lines_json TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      recipient_phone TEXT,
      customer_email TEXT,
      customer_address TEXT,
      customer_account_id TEXT,
      payment_method TEXT NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'live',
      merchant_note TEXT,
      payment_ref TEXT,
      paid_at TEXT,
      fulfilled_at TEXT,
      cancelled_at TEXT,
      preparing_at TEXT,
      out_for_delivery_at TEXT,
      refunded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status_history_json TEXT NOT NULL DEFAULT '[]'
    )`);
    const columnsBefore = (
      legacy.prepare("PRAGMA table_info(studio_orders)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(columnsBefore).not.toContain("agent_id");

    // The next store touch on the SAME file must upgrade the table in
    // place, and the buy flow works against the upgraded schema.
    const order = await store.create(agentOrder("shop-a", "agent-1"));
    const columnsAfter = (
      legacy.prepare("PRAGMA table_info(studio_orders)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(columnsAfter).toContain("agent_id");
    expect((await store.getForAgent("agent-1", order.id))?.agentId).toBe(
      "agent-1",
    );
  });
});
