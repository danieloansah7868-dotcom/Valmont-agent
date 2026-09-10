/**
 * Stage 7b — the production schema IS a wallet invariant, and this file
 * pins the parts of it money depends on.
 *
 * The wallet ledger's guarantees do not live in TypeScript alone: the same
 * shape exists in the Drizzle table declarations here, in the PostgreSQL
 * migrations (0018's partial unique indexes, 0019's CHECK constraints), and
 * in the SQLite fresh-create SQL (`ensureShopAgentSchema`). Drift between
 * any two of them would leave one engine able to write a second purchase
 * entry, a negative balance, or a zero-amount row. The wallet code never
 * issues UPDATE or DELETE against the ledger — these constraints are the
 * database's own word on append-only, non-empty, once-per-order money.
 *
 * Everything below is static source shape — no database connection, no
 * queries, and no error strings flow through these checks (a query error
 * can never make any of them pass).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const schemaSource = readFileSync(path.resolve(__dirname, "schema.ts"), "utf8");

function migration(tag: string): string {
  return readFileSync(
    path.resolve(__dirname, "migrations", `${tag}.sql`),
    "utf8",
  );
}

function journalEntry(
  tag: string,
  expectedIdx: number,
): {
  idx: number;
  when: number;
  tag: string;
} {
  const journal = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "migrations", "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const entry = journal.entries.find((item) => item.tag === tag);
  expect(entry, `journal must register ${tag}`).toBeTruthy();
  expect(entry?.idx).toBe(expectedIdx);
  return entry as { idx: number; when: number; tag: string };
}

describe("drizzle schema — agent order ledger invariants", () => {
  it("one purchase entry and one refund entry per order, enforced as partial unique indexes", () => {
    expect(schemaSource).toContain(
      'uniqueIndex("studio_shop_wallet_entries_order_purchase_unique")',
    );
    expect(schemaSource).toContain(
      'uniqueIndex("studio_shop_wallet_entries_order_refund_unique")',
    );
    // Both are ON order_id and partial on the kind — a full-column unique
    // index would forbid every credit row (they all share order_id NULL).
    for (const kind of ["purchase", "refund"]) {
      const block = schemaSource.slice(
        schemaSource.indexOf(`_order_${kind}_unique`),
      );
      expect(block).toContain(".on(table.orderId)");
    }
    expect(schemaSource).toContain(".where(sql`kind = 'purchase'`)");
    expect(schemaSource).toContain(".where(sql`kind = 'refund'`)");

    // The migration the index actually ships with, and the journal that
    // orders it — drift between schema source and migration is how one
    // engine loses the guard.
    const sql018 = migration("0018_agent_orders");
    expect(sql018).toContain(
      'CREATE UNIQUE INDEX "studio_shop_wallet_entries_order_purchase_unique"',
    );
    expect(sql018).toContain(
      'CREATE UNIQUE INDEX "studio_shop_wallet_entries_order_refund_unique"',
    );
    expect(sql018).toContain("WHERE \"kind\" = 'purchase'");
    expect(sql018).toContain("WHERE \"kind\" = 'refund'");
    journalEntry("0018_agent_orders", 18);
  });

  it("orders carry agent_id, indexed for the agent's own order list", () => {
    const ordersBlock = schemaSource.slice(
      schemaSource.indexOf("studioOrders = pgTable"),
    );
    expect(ordersBlock).toContain('agentId: text("agent_id")');
    expect(schemaSource).toContain('index("studio_orders_agent_created_idx")');
    const sql018 = migration("0018_agent_orders");
    expect(sql018).toContain('ADD COLUMN "agent_id" text');
    expect(sql018).toContain('CREATE INDEX "studio_orders_agent_created_idx"');
  });

  it("a balance can never go negative and no entry is ever zero — CHECK constraints on both engines", () => {
    expect(schemaSource).toContain('"studio_shop_agents_balance_non_negative"');
    expect(schemaSource).toContain(">= 0`,");
    expect(schemaSource).toContain(
      '"studio_shop_wallet_entries_amount_nonzero"',
    );
    expect(schemaSource).toContain("<> 0`,");

    const sql019 = migration("0019_agent_wallet_constraints");
    expect(sql019).toContain(
      'ADD CONSTRAINT "studio_shop_agents_balance_non_negative" CHECK ("balance_minor" >= 0)',
    );
    expect(sql019).toContain(
      'ADD CONSTRAINT "studio_shop_wallet_entries_amount_nonzero" CHECK ("amount_minor" <> 0)',
    );
    const entry = journalEntry("0019_agent_wallet_constraints", 19);
    // Migrations strictly follow the one shipped for Stage 7b.
    expect(entry.when).toBeGreaterThan(1789171200000);
  });

  it("SQLite's fresh-create schema carries the same CHECKs, in its own dialect", () => {
    const storeSource = readFileSync(
      path.resolve(__dirname, "..", "lib", "shop-agent", "store.ts"),
      "utf8",
    );
    expect(storeSource).toContain("CHECK (balance_minor >= 0)");
    expect(storeSource).toContain("CHECK (amount_minor <> 0)");
  });
});
