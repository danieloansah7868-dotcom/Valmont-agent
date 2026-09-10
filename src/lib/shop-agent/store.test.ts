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
  ShopAgentCapError,
  ShopAgentExistsError,
  WalletInsufficientError,
} from "@/lib/api-errors";
import {
  ensureShopAgentSchema,
  MAX_SHOP_AGENTS_PER_WEBSITE,
  SqliteShopAgentStore,
} from "./store";

const PASSWORD = "correct horse battery";
let store: SqliteShopAgentStore;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-shop-agents-"));
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

async function invited(draftId = "shop-a", email = "agent@example.com") {
  const agent = await store.createInvite({
    draftId,
    email,
    name: "Agent",
    invitedBy: "owner",
  });
  const issued = await store.createInviteToken(agent.id);
  return { agent, token: issued.token };
}

async function active(draftId = "shop-a", email = "agent@example.com") {
  const invite = await invited(draftId, email);
  const accepted = await store.acceptInvite(
    invite.token,
    "Agent One",
    PASSWORD,
  );
  if (!accepted) throw new Error("expected an active agent");
  return accepted;
}

describe("SqliteShopAgentStore", () => {
  it("round trips an invite, password, session, reset, and stores only hashes", async () => {
    const pending = await invited();
    const rowBefore = getSqliteChatStore()
      .connection.prepare(
        "SELECT password_hash FROM studio_shop_agents WHERE id = ?",
      )
      .get(pending.agent.id) as { password_hash: string | null };
    expect(rowBefore.password_hash).toBeNull();
    const agent = await store.acceptInvite(
      pending.token,
      "Changed Name",
      PASSWORD,
    );
    expect(agent?.status).toBe("active");
    const row = getSqliteChatStore()
      .connection.prepare(
        "SELECT password_hash FROM studio_shop_agents WHERE id = ?",
      )
      .get(pending.agent.id) as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(
      await store.verifyPassword("shop-a", "AGENT@example.com", PASSWORD),
    ).toMatchObject({ id: pending.agent.id });
    expect(
      await store.verifyPassword("shop-a", "unknown@example.com", PASSWORD),
    ).toBeNull();
    const session = await store.createSession(pending.agent.id);
    expect((await store.getSession(session.token))?.agent.id).toBe(
      pending.agent.id,
    );
    const reset = await store.createResetToken(pending.agent.id);
    expect(await store.consumeResetToken(reset.token)).toBe(pending.agent.id);
    await store.updatePassword(pending.agent.id, "new correct password");
    expect(
      await store.verifyPassword(
        "shop-a",
        "agent@example.com",
        "new correct password",
      ),
    ).not.toBeNull();
  });

  it("uses generic password failures and disables sessions", async () => {
    const agent = await active();
    expect(
      await store.verifyPassword("shop-a", agent.email, "wrong"),
    ).toBeNull();
    await store.setStatus(agent.id, "disabled");
    expect(await store.getSession("missing")).toBeNull();
    expect(
      await store.verifyPassword("shop-a", agent.email, PASSWORD),
    ).toBeNull();
  });

  it("scopes sessions and duplicate emails by shop", async () => {
    const first = await active("shop-a", "same@example.com");
    const second = await active("shop-b", "same@example.com");
    expect(first.id).not.toBe(second.id);
    const session = await store.createSession(first.id);
    expect(await store.getSession(session.token)).toMatchObject({
      agent: { draftId: "shop-a" },
    });
  });

  it("enforces the cap and per-shop email uniqueness", async () => {
    for (let index = 0; index < MAX_SHOP_AGENTS_PER_WEBSITE; index += 1) {
      await store.createInvite({
        draftId: "cap",
        email: `agent-${index}@example.com`,
        name: "Agent",
        invitedBy: "owner",
      });
    }
    await expect(
      store.createInvite({
        draftId: "cap",
        email: "last@example.com",
        name: "Agent",
        invitedBy: "owner",
      }),
    ).rejects.toBeInstanceOf(ShopAgentCapError);
    await expect(
      store.createInvite({
        draftId: "other",
        email: "agent-0@example.com",
        name: "Agent",
        invitedBy: "owner",
      }),
    ).resolves.toBeTruthy();
    await expect(
      store.createInvite({
        draftId: "other",
        email: "AGENT-0@example.com",
        name: "Agent",
        invitedBy: "owner",
      }),
    ).rejects.toBeInstanceOf(ShopAgentExistsError);
  });

  it("keeps the append-only wallet invariant and refuses overdraw without a row", async () => {
    const agent = await active();
    const credit = await store.credit({
      agentId: agent.id,
      amountMinor: 5000,
      note: "opening",
      createdBy: "owner",
    });
    const deduct = await store.deduct({
      agentId: agent.id,
      amountMinor: 2000,
      createdBy: "owner",
    });
    expect(credit.balanceAfter).toBe(50);
    expect(deduct.amount).toBe(-20);
    expect(deduct.balanceAfter).toBe(30);
    await expect(
      store.deduct({
        agentId: agent.id,
        amountMinor: 3001,
        createdBy: "owner",
      }),
    ).rejects.toBeInstanceOf(WalletInsufficientError);
    expect((await store.getById(agent.id))?.balance).toBe(30);
    const rows = await store.listEntries(agent.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.balanceAfter).toBe(30);
    expect(rows[1]?.balanceAfter).toBe(50);
  });

  it("defaults and upserts discount settings, then deletes all five tables", async () => {
    await active();
    expect(await store.getSettings("shop-a")).toEqual({ discountPercent: 0 });
    expect(await store.setDiscountPercent("shop-a", 8)).toEqual({
      discountPercent: 8,
    });
    expect(await store.setDiscountPercent("shop-a", 12)).toEqual({
      discountPercent: 12,
    });
    const agent = await store.getByEmail("shop-a", "agent@example.com");
    await store.credit({
      agentId: agent!.id,
      amountMinor: 100,
      createdBy: "owner",
    });
    await store.createSession(agent!.id);
    expect(await store.deleteForDraft("shop-a")).toBe(1);
    const db = getSqliteChatStore().connection;
    for (const table of [
      "studio_shop_agents",
      "studio_shop_agent_sessions",
      "studio_shop_agent_tokens",
      "studio_shop_wallet_entries",
      "studio_shop_agent_settings",
    ]) {
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    }
  });

  it("creates the SQLite mirror idempotently and purges expired rows", async () => {
    ensureShopAgentSchema(getSqliteChatStore().connection);
    ensureShopAgentSchema(getSqliteChatStore().connection);
    const pending = await invited();
    const session = await store.createSession(
      (await store.acceptInvite(pending.token, "Agent", PASSWORD))!.id,
    );
    const result = await store.purgeExpired(
      new Date("2999-01-01T00:00:00.000Z"),
    );
    expect(result.sessions).toBe(1);
    expect(await store.getSession(session.token)).toBeNull();
  });
});
