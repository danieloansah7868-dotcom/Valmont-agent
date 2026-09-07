/**
 * Stage 6b — the shop-admin store against a throwaway SQLite database.
 *
 * What these tests pin down: the invite token is stored only as a hash and
 * works exactly once inside 24 hours; the session cookie value is stored only
 * as a hash; a wrong password, an unknown email, a pending invite and a
 * disabled login all look identical to the caller; disabling revokes every
 * session; UNIQUE(draft_id, email) holds; the permissions column only ever
 * holds allow-listed ids; and deleting a website takes its logins with it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { hashCustomerToken } from "@/lib/customer-password";
import {
  ShopAdminExistsError,
  ShopLoginCapError,
  ShopOwnerExistsError,
} from "@/lib/api-errors";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import {
  MAX_SHOP_LOGINS_PER_WEBSITE,
  RESERVED_SHOP_PERMISSION,
} from "./permissions";
import {
  getShopAdminStore,
  resetShopAdminPurgeClockForTests,
  SHOP_ADMIN_INVITE_TTL_MS,
  SHOP_ADMIN_RESET_TTL_MS,
  SHOP_ADMIN_SESSION_TTL_MS,
  SqliteShopAdminStore,
} from "./store";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const PASSWORD = "correct horse battery";

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;
let store: SqliteShopAdminStore;

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-shop-admin-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  setIdeaStoreForTests(null);
  resetShopAdminPurgeClockForTests();
  drafts = new SqliteStudioDraftStore();
  store = new SqliteShopAdminStore();
});

afterEach(() => {
  vi.useRealTimers();
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function seedShop(name = "Data GH") {
  return drafts.create(agency, {
    ...createDefaultBrief(),
    category: "data-bundles",
    businessName: name,
  });
}

async function seedActiveOwner(draftId: string, email = "owner@example.com") {
  const invite = await store.createOwnerInvite({
    draftId,
    email,
    name: "Kofi",
    invitedBy: "agency",
  });
  const admin = await store.acceptInvite(invite.token, "Kofi Mensah", PASSWORD);
  if (!admin) throw new Error("invite should have been accepted");
  return admin;
}

function tokenRows() {
  return chatStore.connection
    .prepare(
      "SELECT token_hash, purpose, used_at FROM studio_shop_admin_tokens",
    )
    .all() as Array<{
    token_hash: string;
    purpose: string;
    used_at: string | null;
  }>;
}

function sessionRows() {
  return chatStore.connection
    .prepare(
      "SELECT token_hash, admin_id, draft_id FROM studio_shop_admin_sessions",
    )
    .all() as Array<{ token_hash: string; admin_id: string; draft_id: string }>;
}

describe("getShopAdminStore", () => {
  it("picks SQLite without DATABASE_URL", () => {
    expect(getShopAdminStore()).toBeInstanceOf(SqliteShopAdminStore);
  });
});

describe("owner invite", () => {
  it("creates one invited owner and returns the raw token exactly once", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "  Owner@Example.com ",
      name: "Kofi",
      invitedBy: "agency",
    });

    expect(invite.admin.role).toBe("owner");
    expect(invite.admin.status).toBe("invited");
    expect(invite.admin.hasPassword).toBe(false);
    expect(invite.admin.email).toBe("owner@example.com");
    expect(invite.token.length).toBeGreaterThanOrEqual(32);
    expect(new Date(invite.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      SHOP_ADMIN_INVITE_TTL_MS - 5_000,
    );

    // Only the hash is on disk; the raw token appears nowhere in the row.
    const rows = tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("invite");
    expect(rows[0].token_hash).toBe(hashCustomerToken(invite.token));
    expect(rows[0].token_hash).not.toBe(invite.token);
    expect(JSON.stringify(invite.admin)).not.toContain(invite.token);
  });

  it("refuses a second owner for the same shop", async () => {
    const shop = await seedShop();
    await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    await expect(
      store.createOwnerInvite({
        draftId: shop.id,
        email: "other@example.com",
        name: "Ama",
        invitedBy: "agency",
      }),
    ).rejects.toBeInstanceOf(ShopOwnerExistsError);
  });

  it("enforces UNIQUE(draft_id, email) but lets one email run two shops", async () => {
    const shopA = await seedShop("Shop A");
    const shopB = await seedShop("Shop B");
    await seedActiveOwner(shopA.id);
    await expect(
      store.createMemberInvite({
        draftId: shopA.id,
        email: "OWNER@example.com",
        name: "Dup",
        permissions: [],
        invitedBy: "x",
      }),
    ).rejects.toBeInstanceOf(ShopAdminExistsError);
    // Same address on another website is a different login.
    await expect(seedActiveOwner(shopB.id)).resolves.toMatchObject({
      draftId: shopB.id,
      email: "owner@example.com",
    });
  });
});

describe("accepting an invite", () => {
  it("activates the login, stores a hash (never the password), and burns the token", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });

    const admin = await store.acceptInvite(invite.token, "Kofi M.", PASSWORD);
    expect(admin).toMatchObject({
      status: "active",
      hasPassword: true,
      name: "Kofi M.",
    });

    const row = chatStore.connection
      .prepare("SELECT password_hash FROM studio_shop_admins WHERE id = ?")
      .get(admin!.id) as { password_hash: string };
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain(PASSWORD);

    // Single use: the same link a second time is dead.
    expect(
      await store.acceptInvite(invite.token, "Again", PASSWORD),
    ).toBeNull();
    expect(await store.peekInvite(invite.token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SHOP_ADMIN_INVITE_TTL_MS + 1_000);
    expect(await store.peekInvite(invite.token)).toBeNull();
    expect(await store.acceptInvite(invite.token, "Late", PASSWORD)).toBeNull();
  });

  it("rejects a made-up token and a token of the wrong purpose", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const reset = await store.createResetToken(owner.id);
    expect(
      await store.acceptInvite("nope-nope-nope-nope", "X", PASSWORD),
    ).toBeNull();
    expect(await store.acceptInvite(reset.token, "X", PASSWORD)).toBeNull();
    // …and the reset token is still live, because the wrong-purpose attempt
    // must not have burnt it.
    expect(await store.consumeResetToken(reset.token)).toBe(owner.id);
  });

  it("peekInvite does not consume the token", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    expect(await store.peekInvite(invite.token)).toMatchObject({
      name: "Kofi",
    });
    expect(await store.peekInvite(invite.token)).toMatchObject({
      name: "Kofi",
    });
    expect(
      await store.acceptInvite(invite.token, "Kofi", PASSWORD),
    ).not.toBeNull();
  });
});

describe("verifyPassword", () => {
  it("returns the admin for the right password and null for everything else", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);

    expect(
      await store.verifyPassword(shop.id, "OWNER@example.com", PASSWORD),
    ).toMatchObject({ id: owner.id });
    expect(
      await store.verifyPassword(
        shop.id,
        "owner@example.com",
        "wrong password",
      ),
    ).toBeNull();
    expect(
      await store.verifyPassword(shop.id, "nobody@example.com", PASSWORD),
    ).toBeNull();
    // Right email + password, wrong shop.
    expect(
      await store.verifyPassword("other-shop", "owner@example.com", PASSWORD),
    ).toBeNull();
  });

  it("treats an invited (no password) and a disabled login as a wrong password", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    expect(
      await store.verifyPassword(shop.id, "owner@example.com", PASSWORD),
    ).toBeNull();
    await store.acceptInvite(invite.token, "Kofi", PASSWORD);
    await store.setStatus(invite.admin.id, "disabled");
    expect(
      await store.verifyPassword(shop.id, "owner@example.com", PASSWORD),
    ).toBeNull();
  });
});

describe("sessions", () => {
  it("stores only the hash of the cookie value and expires after 30 days", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);

    const rows = sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashCustomerToken(session.token));
    expect(rows[0].draft_id).toBe(shop.id);

    expect(await store.getSession(session.token)).toMatchObject({
      admin: { id: owner.id, draftId: shop.id },
    });
    expect(await store.getSession("not-a-real-token")).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SHOP_ADMIN_SESSION_TTL_MS + 1_000);
    expect(await store.getSession(session.token)).toBeNull();
  });

  it("revokeSession kills one; disabling kills all", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const a = await store.createSession(owner.id);
    const b = await store.createSession(owner.id);

    await store.revokeSession(a.token);
    expect(await store.getSession(a.token)).toBeNull();
    expect(await store.getSession(b.token)).not.toBeNull();

    await store.setStatus(owner.id, "disabled");
    expect(await store.getSession(b.token)).toBeNull();
    expect(sessionRows()).toHaveLength(0);
  });

  it("revokeAllSessions leaves other admins' sessions alone", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const invite = await store.createMemberInvite({
      draftId: shop.id,
      email: "staff@example.com",
      name: "Staff",
      permissions: ["orders.fulfil"],
      invitedBy: owner.id,
    });
    const member = await store.acceptInvite(invite.token, "Staff", PASSWORD);
    const ownerSession = await store.createSession(owner.id);
    const memberSession = await store.createSession(member!.id);

    await store.revokeAllSessions(owner.id);
    expect(await store.getSession(ownerSession.token)).toBeNull();
    expect(await store.getSession(memberSession.token)).not.toBeNull();
  });
});

describe("reset tokens", () => {
  it("are single-use, one hour, and only for active logins", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const reset = await store.createResetToken(owner.id);
    expect(
      new Date(reset.expiresAt).getTime() - Date.now(),
    ).toBeLessThanOrEqual(SHOP_ADMIN_RESET_TTL_MS);

    expect(await store.consumeResetToken(reset.token)).toBe(owner.id);
    expect(await store.consumeResetToken(reset.token)).toBeNull();

    const second = await store.createResetToken(owner.id);
    await store.setStatus(owner.id, "disabled");
    expect(await store.consumeResetToken(second.token)).toBeNull();
  });

  it("expire after an hour", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const reset = await store.createResetToken(owner.id);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SHOP_ADMIN_RESET_TTL_MS + 1_000);
    expect(await store.consumeResetToken(reset.token)).toBeNull();
  });

  it("updatePassword replaces the hash so the old password stops working", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await store.updatePassword(owner.id, "a brand new password");
    expect(
      await store.verifyPassword(shop.id, owner.email, PASSWORD),
    ).toBeNull();
    expect(
      await store.verifyPassword(shop.id, owner.email, "a brand new password"),
    ).toMatchObject({ id: owner.id });
  });
});

describe("members and permissions", () => {
  it("stores only allow-listed permission ids, in canonical order", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const invite = await store.createMemberInvite({
      draftId: shop.id,
      email: "staff@example.com",
      name: "Staff",
      permissions: [
        "reports.view",
        RESERVED_SHOP_PERMISSION,
        "orders.fulfil",
        "root",
      ],
      invitedBy: owner.id,
    });
    expect(invite.admin.role).toBe("member");
    expect(invite.admin.permissions).toEqual(["orders.fulfil", "reports.view"]);

    const raw = chatStore.connection
      .prepare("SELECT permissions FROM studio_shop_admins WHERE id = ?")
      .get(invite.admin.id) as { permissions: string };
    expect(raw.permissions).toBe('["orders.fulfil","reports.view"]');
    expect(raw.permissions).not.toContain(RESERVED_SHOP_PERMISSION);

    const updated = await store.setPermissions(invite.admin.id, [
      "bundles.manage",
      RESERVED_SHOP_PERMISSION,
    ]);
    expect(updated?.permissions).toEqual(["bundles.manage"]);
  });

  it("lists owner first, caps at ten, and counts disabled logins toward the cap", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    for (let index = 1; index < MAX_SHOP_LOGINS_PER_WEBSITE; index += 1) {
      const invite = await store.createMemberInvite({
        draftId: shop.id,
        email: `staff${index}@example.com`,
        name: `Staff ${index}`,
        permissions: [],
        invitedBy: owner.id,
      });
      if (index === 1) await store.setStatus(invite.admin.id, "disabled");
    }
    expect(await store.countForDraft(shop.id)).toBe(
      MAX_SHOP_LOGINS_PER_WEBSITE,
    );
    await expect(
      store.createMemberInvite({
        draftId: shop.id,
        email: "one-too-many@example.com",
        name: "Extra",
        permissions: [],
        invitedBy: owner.id,
      }),
    ).rejects.toBeInstanceOf(ShopLoginCapError);

    const listed = await store.listForDraft(shop.id);
    expect(listed).toHaveLength(MAX_SHOP_LOGINS_PER_WEBSITE);
    expect(listed[0].role).toBe("owner");
    expect(listed.slice(1).every((admin) => admin.role === "member")).toBe(
      true,
    );
  });

  it("touchLastLogin records a timestamp", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    expect(owner.lastLoginAt).toBeNull();
    await store.touchLastLogin(owner.id);
    expect((await store.getById(owner.id))?.lastLoginAt).toBeTruthy();
  });
});

describe("hygiene", () => {
  it("purgeExpired removes expired sessions and used or expired tokens", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await store.createSession(owner.id);
    const reset = await store.createResetToken(owner.id);
    await store.consumeResetToken(reset.token);
    await store.createResetToken(owner.id);

    // `createSession` already ran the opportunistic purge once (fresh clock),
    // which removed the used invite token; the used reset token is what is
    // left for this explicit call.
    const before = await store.purgeExpired();
    expect(before).toEqual({ sessions: 0, tokens: 1 });
    expect(tokenRows()).toHaveLength(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SHOP_ADMIN_SESSION_TTL_MS + 1_000);
    const after = await store.purgeExpired();
    expect(after).toEqual({ sessions: 1, tokens: 1 });
    expect(sessionRows()).toHaveLength(0);
    expect(tokenRows()).toHaveLength(0);
  });

  it("deleting a website removes its logins, sessions and links", async () => {
    const shop = await seedShop();
    const other = await seedShop("Other");
    const owner = await seedActiveOwner(shop.id);
    const otherOwner = await seedActiveOwner(other.id, "other@example.com");
    await store.createSession(owner.id);
    await store.createSession(otherOwner.id);
    await store.createResetToken(owner.id);

    expect(await drafts.delete(agency, shop.id)).toBe(true);

    expect(await store.listForDraft(shop.id)).toEqual([]);
    expect(sessionRows().every((row) => row.draft_id === other.id)).toBe(true);
    expect(tokenRows().every((row) => row.token_hash)).toBe(true);
    expect(
      (
        chatStore.connection
          .prepare(
            "SELECT COUNT(*) AS n FROM studio_shop_admin_tokens WHERE admin_id = ?",
          )
          .get(owner.id) as { n: number }
      ).n,
    ).toBe(0);
    // The other website is untouched.
    expect(await store.listForDraft(other.id)).toHaveLength(1);
  });
});
