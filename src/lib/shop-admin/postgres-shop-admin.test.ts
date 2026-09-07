/**
 * PostgreSQL shop-admin contract tests (Stage 6b).
 *
 * Migration `0015_shop_admins` adds the three tables a shop login lives in,
 * the unique (draft_id, email) index that makes "one login per email per
 * shop" a database rule, and the cascades that take sessions and one-time
 * links away with their login — and the login away with its website. Those
 * are engine behaviours, so they are checked against the real engine.
 * Skipped when no throwaway database is supplied:
 *
 *   STUDIO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/valmont_test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";

const connectionString = process.env.STUDIO_TEST_DATABASE_URL;
const owner: SessionUser = {
  id: "pg-shop-admin-owner",
  login: "shop-admin-owner",
  name: "Shop Admin Owner",
};
const PASSWORD = "correct horse battery";

describe.runIf(connectionString)("PostgreSQL shop admins", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let store: any;
  let drafts: any;
  let getDatabase: any;
  let closeDatabase: any;
  let studioShopAdmins: any;
  let studioShopAdminSessions: any;
  let studioShopAdminTokens: any;
  let studioDrafts: any;
  let users: any;
  let eq: any;
  let ensureStudioUser: any;
  let createDefaultBrief: any;
  let hashCustomerToken: any;
  let apiErrors: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let ownerId = "";
  let draftId = "";
  let secondDraftId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
    const shopAdmin = await import("./store");
    const draftStore = await import("@/lib/studio/draft-store");
    const defaults = await import("@/lib/studio/site-brief/defaults");
    const db = await import("@/db");
    const schema = await import("@/db/schema");
    const drizzle = await import("drizzle-orm");
    const identity = await import("@/lib/user-identity");
    const password = await import("@/lib/customer-password");
    apiErrors = await import("@/lib/api-errors");

    store = new shopAdmin.PostgresShopAdminStore();
    shopAdmin.resetShopAdminPurgeClockForTests();
    drafts = new draftStore.PostgresStudioDraftStore();
    createDefaultBrief = defaults.createDefaultBrief;
    ensureStudioUser = identity.ensureStudioUser;
    getDatabase = db.getDatabase;
    closeDatabase = db.closeDatabase;
    studioShopAdmins = schema.studioShopAdmins;
    studioShopAdminSessions = schema.studioShopAdminSessions;
    studioShopAdminTokens = schema.studioShopAdminTokens;
    studioDrafts = schema.studioDrafts;
    users = schema.users;
    eq = drizzle.eq;
    hashCustomerToken = password.hashCustomerToken;

    ownerId = await ensureStudioUser(owner);
    draftId = (
      await drafts.create(
        owner,
        createDefaultBrief({
          businessName: "PG Shop Admin Shop",
          category: "data-bundles",
        }),
      )
    ).id;
    secondDraftId = (
      await drafts.create(
        owner,
        createDefaultBrief({
          businessName: "PG Shop Admin Second",
          category: "data-bundles",
        }),
      )
    ).id;
  });

  afterAll(async () => {
    // Drafts cascade to shop admins, which cascade to sessions and tokens.
    await getDatabase()
      .delete(studioDrafts)
      .where(eq(studioDrafts.ownerId, ownerId));
    await getDatabase().delete(users).where(eq(users.id, ownerId));
    await closeDatabase();
    vi.unstubAllEnvs();
    delete process.env.DATABASE_URL;
  });

  it("getShopAdminStore picks PostgreSQL when DATABASE_URL is set", async () => {
    const { getShopAdminStore, PostgresShopAdminStore } =
      await import("./store");
    expect(getShopAdminStore()).toBeInstanceOf(PostgresShopAdminStore);
  });

  it("round-trips invite → accept → login → session, with only hashes stored", async () => {
    const invite = await store.createOwnerInvite({
      draftId,
      email: "PG-Owner@Example.com",
      name: "Kofi",
      invitedBy: ownerId,
    });
    expect(invite.admin).toMatchObject({
      role: "owner",
      status: "invited",
      email: "pg-owner@example.com",
      hasPassword: false,
    });

    const [tokenRow] = await getDatabase()
      .select()
      .from(studioShopAdminTokens)
      .where(eq(studioShopAdminTokens.adminId, invite.admin.id));
    expect(tokenRow.tokenHash).toBe(hashCustomerToken(invite.token));
    expect(tokenRow.purpose).toBe("invite");
    expect(tokenRow.usedAt).toBeNull();

    expect(await store.peekInvite(invite.token)).toMatchObject({
      id: invite.admin.id,
    });
    const admin = await store.acceptInvite(invite.token, "Kofi M.", PASSWORD);
    expect(admin).toMatchObject({ status: "active", hasPassword: true });
    expect(
      await store.acceptInvite(invite.token, "Again", PASSWORD),
    ).toBeNull();

    const [adminRow] = await getDatabase()
      .select()
      .from(studioShopAdmins)
      .where(eq(studioShopAdmins.id, admin.id));
    expect(adminRow.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(adminRow.passwordHash).not.toContain(PASSWORD);

    expect(
      await store.verifyPassword(draftId, "pg-owner@example.com", PASSWORD),
    ).toMatchObject({ id: admin.id });
    expect(
      await store.verifyPassword(draftId, "pg-owner@example.com", "wrong pw!"),
    ).toBeNull();
    expect(
      await store.verifyPassword(
        secondDraftId,
        "pg-owner@example.com",
        PASSWORD,
      ),
    ).toBeNull();

    const session = await store.createSession(admin.id);
    const [sessionRow] = await getDatabase()
      .select()
      .from(studioShopAdminSessions)
      .where(eq(studioShopAdminSessions.adminId, admin.id));
    expect(sessionRow.tokenHash).toBe(hashCustomerToken(session.token));
    expect(sessionRow.draftId).toBe(draftId);
    expect(await store.getSession(session.token)).toMatchObject({
      admin: { id: admin.id, draftId },
    });
    await store.touchLastLogin(admin.id);
    expect((await store.getById(admin.id)).lastLoginAt).toBeTruthy();
  });

  it("enforces UNIQUE(draft_id, email) and one owner per shop, but allows one email on two shops", async () => {
    await expect(
      store.createMemberInvite({
        draftId,
        email: "pg-owner@example.com",
        name: "Dup",
        permissions: [],
        invitedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(apiErrors.ShopAdminExistsError);
    await expect(
      store.createOwnerInvite({
        draftId,
        email: "second-owner@example.com",
        name: "Second",
        invitedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(apiErrors.ShopOwnerExistsError);
    const other = await store.createOwnerInvite({
      draftId: secondDraftId,
      email: "pg-owner@example.com",
      name: "Same person, other shop",
      invitedBy: ownerId,
    });
    expect(other.admin.draftId).toBe(secondDraftId);
  });

  it("stores only allow-listed permissions and lists the owner first", async () => {
    const member = await store.createMemberInvite({
      draftId,
      email: "pg-staff@example.com",
      name: "Staff",
      permissions: ["reports.view", "wallets.topup", "orders.fulfil", "root"],
      invitedBy: ownerId,
    });
    expect(member.admin.permissions).toEqual(["orders.fulfil", "reports.view"]);
    const [row] = await getDatabase()
      .select({ permissions: studioShopAdmins.permissions })
      .from(studioShopAdmins)
      .where(eq(studioShopAdmins.id, member.admin.id));
    expect(row.permissions).toBe('["orders.fulfil","reports.view"]');

    const updated = await store.setPermissions(member.admin.id, [
      "bundles.manage",
      "wallets.topup",
    ]);
    expect(updated.permissions).toEqual(["bundles.manage"]);

    const listed = await store.listForDraft(draftId);
    expect(listed[0].role).toBe("owner");
    expect(listed.map((admin: { email: string }) => admin.email)).toContain(
      "pg-staff@example.com",
    );
    expect(await store.countForDraft(draftId)).toBe(2);
  });

  it("disabling revokes sessions; reset tokens are single-use", async () => {
    const admin = await store.getByEmail(draftId, "pg-owner@example.com");
    const session = await store.createSession(admin.id);
    const reset = await store.createResetToken(admin.id);
    expect(await store.consumeResetToken(reset.token)).toBe(admin.id);
    expect(await store.consumeResetToken(reset.token)).toBeNull();

    await store.updatePassword(admin.id, "a brand new password");
    expect(
      await store.verifyPassword(draftId, admin.email, "a brand new password"),
    ).toMatchObject({ id: admin.id });

    await store.setStatus(admin.id, "disabled");
    expect(await store.getSession(session.token)).toBeNull();
    expect(
      await store.verifyPassword(draftId, admin.email, "a brand new password"),
    ).toBeNull();
    await store.setStatus(admin.id, "active");
  });

  it("purgeExpired removes used tokens and nothing live", async () => {
    const admin = await store.getByEmail(draftId, "pg-owner@example.com");
    const live = await store.createSession(admin.id);
    const result = await store.purgeExpired();
    expect(result.tokens).toBeGreaterThanOrEqual(1);
    expect(await store.getSession(live.token)).not.toBeNull();
  });

  it("cascades: deleting the website removes its logins, sessions and tokens", async () => {
    const admin = await store.getByEmail(draftId, "pg-owner@example.com");
    await store.createSession(admin.id);
    await store.createResetToken(admin.id);

    expect(await drafts.delete(owner, draftId)).toBe(true);

    expect(await store.listForDraft(draftId)).toEqual([]);
    const sessions = await getDatabase()
      .select()
      .from(studioShopAdminSessions)
      .where(eq(studioShopAdminSessions.draftId, draftId));
    expect(sessions).toEqual([]);
    const tokens = await getDatabase()
      .select()
      .from(studioShopAdminTokens)
      .where(eq(studioShopAdminTokens.adminId, admin.id));
    expect(tokens).toEqual([]);
    // The second website's login is untouched.
    expect(await store.listForDraft(secondDraftId)).toHaveLength(1);
  });
});
