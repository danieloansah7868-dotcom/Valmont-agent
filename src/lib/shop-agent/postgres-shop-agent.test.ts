/**
 * PostgreSQL contract tests for Stage 7a agent logins and the wallet ledger.
 *
 * These tests intentionally use the real PostgreSQL store and are skipped when
 * the CI-only throwaway database is not configured locally:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";
import type { WalletEntry } from "./store";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";
const owner: SessionUser = {
  id: `pg-shop-agent-owner-${process.pid}`,
  login: "pg-shop-agent-owner",
  name: "Shop Agent Test Owner",
};

describe.runIf(connectionString)("PostgreSQL shop agents", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let drafts: any;
  let db: any;
  let closeDatabase: any;
  let studioDrafts: any;
  let studioShopAgents: any;
  let studioShopAgentSessions: any;
  let studioShopAgentTokens: any;
  let studioShopWalletEntries: any;
  let studioShopAgentSettings: any;
  let users: any;
  let eq: any;
  let ensureStudioUser: any;
  let createDefaultBrief: any;
  let apiErrors: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerId = "";
  let draftId = "";
  let otherDraftId = "";

  async function activeAgent(draft: string, email: string, name = "Agent One") {
    const invited = await store.createInvite({
      draftId: draft,
      email,
      name,
      invitedBy: ownerId,
    });
    const inviteToken = await store.createInviteToken(invited.id);
    const agent = await store.acceptInvite(inviteToken.token, name, PASSWORD);
    expect(agent).toMatchObject({ id: invited.id, status: "active" });
    return agent;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");

    const agentStore = await import("./store");
    const draftStore = await import("@/lib/studio/draft-store");
    const defaults = await import("@/lib/studio/site-brief/defaults");
    const database = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");
    const identity = await import("@/lib/user-identity");
    apiErrors = await import("@/lib/api-errors");

    store = new agentStore.PostgresShopAgentStore();
    drafts = new draftStore.PostgresStudioDraftStore();
    db = database.getDatabase();
    closeDatabase = database.closeDatabase;
    studioDrafts = schema.studioDrafts;
    studioShopAgents = schema.studioShopAgents;
    studioShopAgentSessions = schema.studioShopAgentSessions;
    studioShopAgentTokens = schema.studioShopAgentTokens;
    studioShopWalletEntries = schema.studioShopWalletEntries;
    studioShopAgentSettings = schema.studioShopAgentSettings;
    users = schema.users;
    eq = drizzle.eq;
    ensureStudioUser = identity.ensureStudioUser;
    createDefaultBrief = defaults.createDefaultBrief;
    ownerId = await ensureStudioUser(owner);

    const makeDraft = (businessName: string) =>
      drafts.create(
        owner,
        createDefaultBrief({
          businessName,
          category: "data-bundles",
          plan: "command_center",
        }),
      );
    draftId = (await makeDraft("Postgres Agent Shop")).id;
    otherDraftId = (await makeDraft("Postgres Agent Other Shop")).id;
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

  it("round-trips invites, hashes passwords, scopes sessions, and disables cleanly", async () => {
    const invited = await store.createInvite({
      draftId,
      email: "PG-Agent@Example.com",
      name: "Pending Agent",
      invitedBy: ownerId,
    });
    const token = await store.createInviteToken(invited.id);
    expect(await store.peekInvite(token.token)).toMatchObject({
      id: invited.id,
      status: "invited",
    });

    const accepted = await store.acceptInvite(
      token.token,
      "Active Agent",
      PASSWORD,
    );
    expect(accepted).toMatchObject({
      id: invited.id,
      email: "pg-agent@example.com",
      status: "active",
      hasPassword: true,
    });
    expect(await store.acceptInvite(token.token, "Again", PASSWORD)).toBeNull();

    const [row] = await db
      .select()
      .from(studioShopAgents)
      .where(eq(studioShopAgents.id, invited.id));
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(
      await store.verifyPassword(draftId, "pg-agent@example.com", PASSWORD),
    ).toMatchObject({ id: invited.id });
    expect(
      await store.verifyPassword(draftId, "pg-agent@example.com", "wrong"),
    ).toBeNull();
    expect(
      await store.verifyPassword(
        otherDraftId,
        "pg-agent@example.com",
        PASSWORD,
      ),
    ).toBeNull();

    const session = await store.createSession(invited.id);
    expect(await store.getSession(session.token)).toMatchObject({
      agent: { id: invited.id, draftId },
    });
    const [sessionRow] = await db
      .select()
      .from(studioShopAgentSessions)
      .where(eq(studioShopAgentSessions.agentId, invited.id));
    expect(sessionRow.tokenHash).not.toBe(session.token);

    await store.setStatus(invited.id, "disabled");
    expect(await store.getSession(session.token)).toBeNull();
    expect(
      await store.verifyPassword(draftId, "pg-agent@example.com", PASSWORD),
    ).toBeNull();

    const sameEmail = await activeAgent(
      otherDraftId,
      "pg-agent@example.com",
      "Other Shop Agent",
    );
    expect(sameEmail.draftId).toBe(otherDraftId);
    await expect(
      store.createInvite({
        draftId,
        email: "PG-Agent@example.com",
        name: "Duplicate",
        invitedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(apiErrors.ShopAgentExistsError);
  });

  it("keeps the wallet append-only, conditional, and safe under concurrent deducts", async () => {
    const agent = await activeAgent(
      draftId,
      "wallet-agent@example.com",
      "Wallet Agent",
    );

    await store.credit({
      agentId: agent.id,
      amountMinor: 5000,
      note: "opening credit",
      createdBy: ownerId,
    });
    const removed = await store.deduct({
      agentId: agent.id,
      amountMinor: 2000,
      createdBy: ownerId,
    });
    expect(removed.balanceAfter).toBe(30);
    expect((await store.getById(agent.id))?.balance).toBe(30);
    expect(
      (await store.listEntries(agent.id)).map(
        (entry: WalletEntry) => entry.balanceAfter,
      ),
    ).toEqual([30, 50]);

    await expect(
      store.deduct({
        agentId: agent.id,
        amountMinor: 3001,
        createdBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(apiErrors.WalletInsufficientError);
    expect(await store.listEntries(agent.id)).toHaveLength(2);

    const concurrent = await activeAgent(
      draftId,
      "concurrent-agent@example.com",
      "Concurrent Agent",
    );
    await store.credit({
      agentId: concurrent.id,
      amountMinor: 5000,
      createdBy: ownerId,
    });
    const results = await Promise.allSettled([
      store.deduct({
        agentId: concurrent.id,
        amountMinor: 3000,
        createdBy: ownerId,
      }),
      store.deduct({
        agentId: concurrent.id,
        amountMinor: 3000,
        createdBy: ownerId,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null,
    ).toBeInstanceOf(apiErrors.WalletInsufficientError);
    expect((await store.getById(concurrent.id))?.balance).toBe(20);
    expect(
      (await store.listEntries(concurrent.id)).filter(
        (entry: WalletEntry) => entry.kind === "deduct",
      ),
    ).toHaveLength(1);
  });

  it("upserts settings and deletes every agent table for a draft", async () => {
    const agent = await activeAgent(
      draftId,
      "cleanup-agent@example.com",
      "Cleanup Agent",
    );
    await store.createSession(agent.id);
    await store.createResetToken(agent.id);
    await store.credit({
      agentId: agent.id,
      amountMinor: 100,
      createdBy: ownerId,
    });
    expect(await store.getSettings(draftId)).toEqual({ discountPercent: 0 });
    expect(await store.setDiscountPercent(draftId, 8)).toEqual({
      discountPercent: 8,
    });
    expect(await store.setDiscountPercent(draftId, 12)).toEqual({
      discountPercent: 12,
    });

    expect(await store.deleteForDraft(draftId)).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select()
        .from(studioShopAgents)
        .where(eq(studioShopAgents.id, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopAgentSessions)
        .where(eq(studioShopAgentSessions.agentId, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopAgentTokens)
        .where(eq(studioShopAgentTokens.agentId, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopWalletEntries)
        .where(eq(studioShopWalletEntries.agentId, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopAgentSettings)
        .where(eq(studioShopAgentSettings.draftId, draftId)),
    ).toEqual([]);
  });

  it("lets the draft foreign-key cascade remove agent rows", async () => {
    const agent = await activeAgent(
      otherDraftId,
      "cascade-agent@example.com",
      "Cascade Agent",
    );
    await store.createSession(agent.id);
    await store.createResetToken(agent.id);
    await store.credit({
      agentId: agent.id,
      amountMinor: 100,
      createdBy: ownerId,
    });
    await store.setDiscountPercent(otherDraftId, 8);

    await db.delete(studioDrafts).where(eq(studioDrafts.id, otherDraftId));
    expect(
      await db
        .select()
        .from(studioShopAgents)
        .where(eq(studioShopAgents.id, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopAgentSessions)
        .where(eq(studioShopAgentSessions.agentId, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopAgentTokens)
        .where(eq(studioShopAgentTokens.agentId, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopWalletEntries)
        .where(eq(studioShopWalletEntries.agentId, agent.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(studioShopAgentSettings)
        .where(eq(studioShopAgentSettings.draftId, otherDraftId)),
    ).toEqual([]);
  });
});
