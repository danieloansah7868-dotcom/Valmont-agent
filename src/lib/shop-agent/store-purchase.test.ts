/**
 * Stage 7b — the wallet ledger methods for agent orders (R3, R8).
 *
 * `purchase` is the ONLY way checkout money leaves a wallet: one transaction
 * that writes exactly one `purchase` entry (order_id set, negative amount,
 * balance_after) alongside the balance change, idempotent on the order id.
 * `refund` is the ONLY way money goes back: once per order, or never again.
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
import {
  BadRequestError,
  WalletAlreadyRefundedError,
  WalletInsufficientError,
  WalletOrderConflictError,
} from "@/lib/api-errors";
import { SqliteShopAgentStore } from "./store";

const PASSWORD = "correct horse battery";
let store: SqliteShopAgentStore;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-agent-purchase-"));
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat.sqlite"),
      path.join(dir, "chat.json"),
    ),
  );
  store = new SqliteShopAgentStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function active(draftId = "shop-a", email = "agent@example.com") {
  const invite = await store.createInvite({
    draftId,
    email,
    name: "Agent",
    invitedBy: "owner",
  });
  const issued = await store.createInviteToken(invite.id);
  const accepted = await store.acceptInvite(
    issued.token,
    "Agent One",
    PASSWORD,
  );
  if (!accepted) throw new Error("expected an active agent");
  return accepted;
}

async function credited(amountMinor = 5000) {
  const agent = await active();
  await store.credit({
    agentId: agent.id,
    amountMinor,
    note: "opening",
    createdBy: "owner",
  });
  return agent;
}

describe("SqliteShopAgentStore purchase", () => {
  it("debits once with the exact ledger row: kind, order id, signed amount, running balance, actor", async () => {
    const agent = await credited();
    const entry = await store.purchase({
      agentId: agent.id,
      orderId: "22222222-3333-4444-8555-666666666666",
      amountMinor: 920,
      createdBy: agent.id,
    });
    expect(entry.kind).toBe("purchase");
    expect(entry.orderId).toBe("22222222-3333-4444-8555-666666666666");
    expect(entry.amount).toBe(-9.2);
    expect(entry.balanceAfter).toBe(40.8);
    expect(entry.createdBy).toBe(agent.id);
    expect((await store.getById(agent.id))?.balance).toBe(40.8);
    const row = getSqliteChatStore()
      .connection.prepare(
        "SELECT kind, amount_minor, balance_after_minor, order_id FROM studio_shop_wallet_entries WHERE id = ?",
      )
      .get(entry.id) as {
      kind: string;
      amount_minor: number;
      balance_after_minor: number;
      order_id: string | null;
    };
    expect(row).toEqual({
      kind: "purchase",
      amount_minor: -920,
      balance_after_minor: 4080,
      order_id: "22222222-3333-4444-8555-666666666666",
    });
  });

  it("is idempotent on the order id: a replay returns the original entry and changes nothing", async () => {
    const agent = await credited();
    const first = await store.purchase({
      agentId: agent.id,
      orderId: "22222222-3333-4444-8555-666666666666",
      amountMinor: 920,
      createdBy: agent.id,
    });
    const second = await store.purchase({
      agentId: agent.id,
      orderId: "22222222-3333-4444-8555-666666666666",
      amountMinor: 920,
      createdBy: agent.id,
    });
    expect(second.id).toBe(first.id);
    expect(second.balanceAfter).toBe(first.balanceAfter);
    expect((await store.getById(agent.id))?.balance).toBe(40.8);
    expect(
      (await store.listEntries(agent.id)).filter(
        (entry) => entry.kind === "purchase",
      ),
    ).toHaveLength(1);
    // The database backs the idempotency promise with a real constraint.
    const index = getSqliteChatStore()
      .connection.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'studio_shop_wallet_entries_order_purchase_unique'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toContain("UNIQUE");
    expect(index?.sql).toContain("kind = 'purchase'");
  });

  it("refuses an overdraw and writes nothing at all", async () => {
    const agent = await credited(3000);
    await expect(
      store.purchase({
        agentId: agent.id,
        orderId: "22222222-3333-4444-8555-666666666666",
        amountMinor: 3001,
        createdBy: agent.id,
      }),
    ).rejects.toBeInstanceOf(WalletInsufficientError);
    expect((await store.getById(agent.id))?.balance).toBe(30);
    expect(
      (await store.listEntries(agent.id)).filter(
        (entry) => entry.kind === "purchase",
      ),
    ).toHaveLength(0);
  });

  it("two 6.00 purchases racing a 10.00 balance end with exactly one entry and 4.00 left", async () => {
    const agent = await credited(1000);
    const results = await Promise.allSettled([
      store.purchase({
        agentId: agent.id,
        orderId: "22222222-3333-4444-8555-666666666666",
        amountMinor: 600,
        createdBy: agent.id,
      }),
      store.purchase({
        agentId: agent.id,
        orderId: "33333333-4444-4555-8666-777777777777",
        amountMinor: 600,
        createdBy: agent.id,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null,
    ).toBeInstanceOf(WalletInsufficientError);
    expect((await store.getById(agent.id))?.balance).toBe(4);
    expect(
      (await store.listEntries(agent.id)).filter(
        (entry) => entry.kind === "purchase",
      ),
    ).toHaveLength(1);
  });
});

describe("SqliteShopAgentStore refund", () => {
  it("credits exactly once per order: a second refund conflicts and the balance moves once", async () => {
    const agent = await credited();
    await store.purchase({
      agentId: agent.id,
      orderId: "22222222-3333-4444-8555-666666666666",
      amountMinor: 920,
      createdBy: agent.id,
    });
    expect((await store.getById(agent.id))?.balance).toBe(40.8);
    const refund = await store.refund({
      agentId: agent.id,
      orderId: "22222222-3333-4444-8555-666666666666",
      amountMinor: 920,
      createdBy: "owner",
      note: "Refund order 22222222",
    });
    expect(refund.kind).toBe("refund");
    expect(refund.amount).toBe(9.2);
    expect(refund.balanceAfter).toBe(50);
    expect(refund.createdBy).toBe("owner");
    expect((await store.getById(agent.id))?.balance).toBe(50);
    await expect(
      store.refund({
        agentId: agent.id,
        orderId: "22222222-3333-4444-8555-666666666666",
        amountMinor: 920,
        createdBy: "owner",
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyRefundedError);
    // The wallet still shows one refund, one balance.
    expect((await store.getById(agent.id))?.balance).toBe(50);
    expect(
      (await store.listEntries(agent.id)).filter(
        (entry) => entry.kind === "refund",
      ),
    ).toHaveLength(1);
    const index = getSqliteChatStore()
      .connection.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'studio_shop_wallet_entries_order_refund_unique'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toContain("kind = 'refund'");
  });

  it("getEntryForOrder finds the buy and the refund and returns null otherwise", async () => {
    const agent = await credited();
    const orderId = "22222222-3333-4444-8555-666666666666";
    expect(await store.getEntryForOrder(orderId, "purchase")).toBeNull();
    await store.purchase({
      agentId: agent.id,
      orderId,
      amountMinor: 920,
      createdBy: agent.id,
    });
    const found = await store.getEntryForOrder(orderId, "purchase");
    expect(found?.balanceAfter).toBe(40.8);
    await store.refund({
      agentId: agent.id,
      orderId,
      amountMinor: 920,
      createdBy: "owner",
    });
    expect((await store.getEntryForOrder(orderId, "refund"))?.amount).toBe(9.2);
    expect(await store.getEntryForOrder(orderId, "credit")).toBeNull();
  });

  it("is append-only by construction — the store exposes no way to change or delete a row", () => {
    expect(
      typeof (store as unknown as Record<string, unknown>).updateEntry,
    ).toBe("undefined");
    expect(
      typeof (store as unknown as Record<string, unknown>).deleteEntry,
    ).toBe("undefined");
  });

  it("no ledger entry dies quietly: zero, negative and fractional amounts are refused before any write", async () => {
    const agent = await credited();
    const orderId = "22222222-3333-4444-8555-666666666666";
    for (const amountMinor of [0, -1, 5.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        store.purchase({
          agentId: agent.id,
          orderId,
          amountMinor,
          createdBy: agent.id,
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
      await expect(
        store.refund({
          agentId: agent.id,
          orderId,
          amountMinor,
          createdBy: "owner",
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
    await expect(
      store.purchase({
        agentId: agent.id,
        orderId,
        amountMinor: 0,
        createdBy: agent.id,
      }),
    ).rejects.toThrow("Wallet amounts must be whole pesewas up to GHS 5,000.");
    // Nothing moved: no entry, the balance is exactly what the credit left.
    expect((await store.getById(agent.id))?.balance).toBe(50);
    expect(await store.getEntryForOrder(orderId, "purchase")).toBeNull();
    expect(await store.getEntryForOrder(orderId, "refund")).toBeNull();
    expect(await store.listEntries(agent.id)).toHaveLength(1); // the credit
  });

  it("a purchase carrying an order id that collides with ANOTHER agent's entry is a hard error, never wallet adoption", async () => {
    // Two different agents on the same shop, each with their own credit.
    const first = await active("shop-a", "first@example.com");
    await store.credit({
      agentId: first.id,
      amountMinor: 5000,
      note: "opening",
      createdBy: "owner",
    });
    const orderId = "22222222-3333-4444-8555-666666666666";
    await store.purchase({
      agentId: first.id,
      orderId,
      amountMinor: 920,
      createdBy: first.id,
    });
    const second = await active("shop-a", "second@example.com");
    await store.credit({
      agentId: second.id,
      amountMinor: 5000,
      note: "opening",
      createdBy: "owner",
    });
    // Even if a caller smuggled a foreign order id in, the loser must not be
    // handed the other agent's ledger row — adoption would silently charge
    // one agent's order to another wallet. The store refuses with its own
    // 409-style collision error before any wallet write, in BOTH engines.
    await expect(
      store.purchase({
        agentId: second.id,
        orderId,
        amountMinor: 100,
        createdBy: second.id,
      }),
    ).rejects.toBeInstanceOf(WalletOrderConflictError);
    // Rolled back completely: second wallet untouched, first entry unmoved.
    expect((await store.getById(second.id))?.balance).toBe(50);
    expect(await store.listEntries(second.id)).toHaveLength(1); // only its credit
    const entry = await store.getEntryForOrder(orderId, "purchase");
    expect(entry?.agentId).toBe(first.id);
    expect(entry?.amount).toBe(-9.2);
    expect((await store.getById(first.id))?.balance).toBe(40.8);
  });
});
