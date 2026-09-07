/**
 * Stage 6b — the shop admin API (`/api/manage/[id]/*`) against a real
 * throwaway SQLite database. No store is mocked: what these tests prove is
 * the behaviour a browser sees, including that a session for shop A is worth
 * nothing on shop B, that an order of a sibling website is a 404 even for the
 * same agency owner, and that every login failure reads identically.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { resetRateLimitForTests } from "@/lib/security";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { SqliteOrdersStore } from "@/lib/studio/orders";
import { canonicalUserId } from "@/lib/user-identity";
import { hashCustomerToken } from "@/lib/customer-password";
import {
  resetShopAdminPurgeClockForTests,
  SqliteShopAdminStore,
} from "@/lib/shop-admin/store";
import { SHOP_SESSION_COOKIE } from "@/lib/shop-admin/auth";
import { MAX_SHOP_LOGINS_PER_WEBSITE } from "@/lib/shop-admin/permissions";
import { POST as login } from "./[id]/auth/login/route";
import { POST as logout } from "./[id]/auth/logout/route";
import { POST as acceptInvite } from "./[id]/auth/accept-invite/route";
import { POST as forgotPassword } from "./[id]/auth/forgot-password/route";
import { POST as resetPassword } from "./[id]/auth/reset-password/route";
import { GET as listTeam, POST as inviteMember } from "./[id]/team/route";
import { PATCH as patchMember } from "./[id]/team/[adminId]/route";
import { POST as resendMember } from "./[id]/team/[adminId]/resend/route";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const PASSWORD = "correct horse battery";
const csrf = "shop-admin-route-csrf-token-1234";

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;
let store: SqliteShopAdminStore;
let orders: SqliteOrdersStore;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TRUST_PROXY", "false");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  resetRateLimitForTests();
  resetShopAdminPurgeClockForTests();
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-shop-routes-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  store = new SqliteShopAdminStore();
  orders = new SqliteOrdersStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mutation(
  url: string,
  body: unknown,
  options: { cookie?: string; method?: string; csrf?: boolean } = {},
) {
  const cookies = [
    options.csrf === false ? null : `valmont_csrf=${csrf}`,
    options.cookie ? `${SHOP_SESSION_COOKIE}=${options.cookie}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return new NextRequest(`http://localhost${url}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(cookies ? { cookie: cookies } : {}),
      ...(options.csrf === false ? {} : { "x-valmont-csrf": csrf }),
    },
    body: JSON.stringify(body),
  });
}

function read(url: string, cookie?: string) {
  return new NextRequest(`http://localhost${url}`, {
    method: "GET",
    headers: cookie ? { cookie: `${SHOP_SESSION_COOKIE}=${cookie}` } : {},
  });
}

function params(id: string, adminId?: string) {
  return {
    params: Promise.resolve(
      adminId ? { id, adminId } : ({ id } as { id: string; adminId: string }),
    ),
  };
}

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
    invitedBy: canonicalUserId(agency),
  });
  const admin = await store.acceptInvite(invite.token, "Kofi", PASSWORD);
  if (!admin) throw new Error("invite should have been accepted");
  return admin;
}

async function seedActiveMember(draftId: string, invitedBy: string) {
  const invite = await store.createMemberInvite({
    draftId,
    email: "staff@example.com",
    name: "Staff",
    permissions: ["orders.fulfil"],
    invitedBy,
  });
  const admin = await store.acceptInvite(invite.token, "Staff", PASSWORD);
  if (!admin) throw new Error("invite should have been accepted");
  return admin;
}

function sessionCookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${SHOP_SESSION_COOKIE}=([^;]+)`));
  if (!match) throw new Error(`No ${SHOP_SESSION_COOKIE} cookie in response`);
  return match[1];
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("POST /api/manage/[id]/auth/login", () => {
  it("requires CSRF", async () => {
    const shop = await seedShop();
    const response = await login(
      mutation(
        `/api/manage/${shop.id}/auth/login`,
        { email: "owner@example.com", password: PASSWORD },
        { csrf: false },
      ),
      params(shop.id),
    );
    expect(response.status).toBe(403);
  });

  it("signs the owner in with a hashed, httpOnly, lax, path=/ 30-day cookie", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const response = await login(
      mutation(`/api/manage/${shop.id}/auth/login`, {
        email: "OWNER@example.com",
        password: PASSWORD,
        next: `/manage/${shop.id}/team`,
      }),
      params(shop.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      admin: { id: owner.id, role: "owner" },
      next: `/manage/${shop.id}/team`,
    });
    // Nothing secret in the body.
    expect(JSON.stringify(body)).not.toMatch(/hash|password|token/i);

    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain(`${SHOP_SESSION_COOKIE}=`);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=2592000/);
    // Not Secure outside production (the e2e server runs on plain http).
    expect(header).not.toMatch(/;\s*Secure/i);

    const token = sessionCookieFrom(response);
    const row = chatStore.connection
      .prepare("SELECT token_hash FROM studio_shop_admin_sessions")
      .get() as { token_hash: string };
    expect(row.token_hash).toBe(hashCustomerToken(token));
    expect(row.token_hash).not.toBe(token);

    expect((await store.getById(owner.id))?.lastLoginAt).toBeTruthy();
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { POST: prodLogin } = await import("./[id]/auth/login/route");
    const shop = await seedShop();
    await seedActiveOwner(shop.id);
    const response = await prodLogin(
      mutation(`/api/manage/${shop.id}/auth/login`, {
        email: "owner@example.com",
        password: PASSWORD,
      }),
      params(shop.id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").toMatch(/;\s*Secure/i);
  });

  it("answers every failure with the same 401 and the same words", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await store.createMemberInvite({
      draftId: shop.id,
      email: "pending@example.com",
      name: "Pending",
      permissions: [],
      invitedBy: owner.id,
    });
    const disabledInvite = await store.createMemberInvite({
      draftId: shop.id,
      email: "off@example.com",
      name: "Off",
      permissions: [],
      invitedBy: owner.id,
    });
    await store.acceptInvite(disabledInvite.token, "Off", PASSWORD);
    await store.setStatus(disabledInvite.admin.id, "disabled");

    const attempts = [
      { id: shop.id, email: "nobody@example.com", password: PASSWORD },
      { id: shop.id, email: "owner@example.com", password: "wrong password!" },
      { id: shop.id, email: "pending@example.com", password: PASSWORD },
      { id: shop.id, email: "off@example.com", password: PASSWORD },
      // Right credentials, a shop that does not exist.
      {
        id: "00000000-0000-4000-a000-000000000000",
        email: "owner@example.com",
        password: PASSWORD,
      },
    ];
    const bodies = [];
    for (const attempt of attempts) {
      const response = await login(
        mutation(`/api/manage/${attempt.id}/auth/login`, {
          email: attempt.email,
          password: attempt.password,
        }),
        params(attempt.id),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      bodies.push(await response.json());
    }
    for (const body of bodies) {
      expect(body).toEqual({ error: "Email or password is incorrect." });
    }
  });

  it("rate-limits an email after ten attempts even when proxy headers rotate", async () => {
    const shop = await seedShop();
    let lastStatus = 0;
    for (let index = 0; index < 11; index += 1) {
      const request = mutation(`/api/manage/${shop.id}/auth/login`, {
        email: "owner@example.com",
        password: "wrong password!",
      });
      request.headers.set("x-forwarded-for", `10.0.0.${index}`);
      lastStatus = (await login(request, params(shop.id))).status;
    }
    expect(lastStatus).toBe(429);
  });

  it("ignores a next that points outside this shop", async () => {
    const shop = await seedShop();
    await seedActiveOwner(shop.id);
    for (const next of [
      "/studio",
      "//evil.example",
      "/manage/other-shop",
      "https://evil.example/manage",
    ]) {
      const response = await login(
        mutation(`/api/manage/${shop.id}/auth/login`, {
          email: "owner@example.com",
          password: PASSWORD,
          next,
        }),
        params(shop.id),
      );
      expect((await response.json()).next).toBe(`/manage/${shop.id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sessions: logout, isolation
// ---------------------------------------------------------------------------

describe("sessions across shops", () => {
  it("a session for shop A is 401 with no cookie and 404 on shop B", async () => {
    const shopA = await seedShop("Shop A");
    const shopB = await seedShop("Shop B");
    const ownerA = await seedActiveOwner(shopA.id);
    await seedActiveOwner(shopB.id, "b@example.com");
    const session = await store.createSession(ownerA.id);

    const mine = await listTeam(
      read(`/api/manage/${shopA.id}/team`, session.token),
      params(shopA.id),
    );
    expect(mine.status).toBe(200);

    const theirs = await listTeam(
      read(`/api/manage/${shopB.id}/team`, session.token),
      params(shopB.id),
    );
    expect(theirs.status).toBe(404);

    const anonymous = await listTeam(
      read(`/api/manage/${shopA.id}/team`),
      params(shopA.id),
    );
    expect(anonymous.status).toBe(401);
  });

  it("logout revokes the server-side session and clears the cookie", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);

    const response = await logout(
      mutation(
        `/api/manage/${shop.id}/auth/logout`,
        {},
        { cookie: session.token },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/);
    expect(await store.getSession(session.token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invite / forgot / reset
// ---------------------------------------------------------------------------

describe("POST /api/manage/[id]/auth/accept-invite", () => {
  it("sets the password, signs in, and refuses the same link twice", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    const first = await acceptInvite(
      mutation(`/api/manage/${shop.id}/auth/accept-invite`, {
        token: invite.token,
        name: "Kofi Mensah",
        password: PASSWORD,
      }),
      params(shop.id),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie") ?? "").toContain(
      `${SHOP_SESSION_COOKIE}=`,
    );

    const second = await acceptInvite(
      mutation(`/api/manage/${shop.id}/auth/accept-invite`, {
        token: invite.token,
        name: "Kofi Mensah",
        password: PASSWORD,
      }),
      params(shop.id),
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({
      error: "This link is invalid or has expired.",
    });
  });

  it("rejects a short password and a token minted for another shop", async () => {
    const shopA = await seedShop("Shop A");
    const shopB = await seedShop("Shop B");
    const invite = await store.createOwnerInvite({
      draftId: shopA.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    const short = await acceptInvite(
      mutation(`/api/manage/${shopA.id}/auth/accept-invite`, {
        token: invite.token,
        name: "Kofi",
        password: "short",
      }),
      params(shopA.id),
    );
    expect(short.status).toBe(400);
    // The short password must not have burnt the token.
    expect(await store.peekInvite(invite.token)).not.toBeNull();

    const wrongShop = await acceptInvite(
      mutation(`/api/manage/${shopB.id}/auth/accept-invite`, {
        token: invite.token,
        name: "Kofi",
        password: PASSWORD,
      }),
      params(shopB.id),
    );
    expect(wrongShop.status).toBe(400);
  });
});

describe("forgot + reset password", () => {
  it("forgot always says the same thing and never returns a link", async () => {
    const shop = await seedShop();
    await seedActiveOwner(shop.id);
    const known = await forgotPassword(
      mutation(`/api/manage/${shop.id}/auth/forgot-password`, {
        email: "owner@example.com",
      }),
      params(shop.id),
    );
    const unknown = await forgotPassword(
      mutation(`/api/manage/${shop.id}/auth/forgot-password`, {
        email: "nobody@example.com",
      }),
      params(shop.id),
    );
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const knownBody = await known.json();
    expect(knownBody).toEqual(await unknown.json());
    expect(knownBody).toEqual({
      ok: true,
      message: "If that email exists, we sent a link.",
    });
    expect(JSON.stringify(knownBody)).not.toContain("token");
    // A reset token was still minted for the real login (email is not
    // configured here, so it simply has nowhere to go).
    const rows = chatStore.connection
      .prepare(
        "SELECT COUNT(*) AS n FROM studio_shop_admin_tokens WHERE purpose = 'reset'",
      )
      .get() as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it("forgot is limited to five per email per hour", async () => {
    const shop = await seedShop();
    let lastStatus = 0;
    for (let index = 0; index < 6; index += 1) {
      lastStatus = (
        await forgotPassword(
          mutation(`/api/manage/${shop.id}/auth/forgot-password`, {
            email: "owner@example.com",
          }),
          params(shop.id),
        )
      ).status;
    }
    expect(lastStatus).toBe(429);
  });

  it("reset changes the password, revokes every session, and burns the link", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const oldSession = await store.createSession(owner.id);
    const reset = await store.createResetToken(owner.id);

    const response = await resetPassword(
      mutation(`/api/manage/${shop.id}/auth/reset-password`, {
        token: reset.token,
        password: "a brand new password",
      }),
      params(shop.id),
    );
    expect(response.status).toBe(200);
    expect(await store.getSession(oldSession.token)).toBeNull();
    expect(
      await store.verifyPassword(shop.id, owner.email, "a brand new password"),
    ).toMatchObject({ id: owner.id });

    const again = await resetPassword(
      mutation(`/api/manage/${shop.id}/auth/reset-password`, {
        token: reset.token,
        password: "yet another password",
      }),
      params(shop.id),
    );
    expect(again.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

describe("team routes", () => {
  it("members can list but only the owner can invite, edit or disable", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id);
    const memberSession = await store.createSession(member.id);

    const list = await listTeam(
      read(`/api/manage/${shop.id}/team`, memberSession.token),
      params(shop.id),
    );
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.admins).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toMatch(/passwordHash|password_hash/);

    const invite = await inviteMember(
      mutation(
        `/api/manage/${shop.id}/team`,
        { name: "New", email: "new@example.com", permissions: [] },
        { cookie: memberSession.token },
      ),
      params(shop.id),
    );
    expect(invite.status).toBe(403);

    const patch = await patchMember(
      mutation(
        `/api/manage/${shop.id}/team/${member.id}`,
        { status: "disabled" },
        { cookie: memberSession.token, method: "PATCH" },
      ),
      params(shop.id, member.id),
    );
    expect(patch.status).toBe(403);

    const resend = await resendMember(
      mutation(
        `/api/manage/${shop.id}/team/${member.id}/resend`,
        {},
        { cookie: memberSession.token },
      ),
      params(shop.id, member.id),
    );
    expect(resend.status).toBe(403);
  });

  it("owner invites a member with ticked boxes; response carries no link", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);

    const response = await inviteMember(
      mutation(
        `/api/manage/${shop.id}/team`,
        {
          name: "Staff",
          email: "staff@example.com",
          permissions: ["reports.view", "orders.fulfil"],
        },
        { cookie: session.token },
      ),
      params(shop.id),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.admin).toMatchObject({
      role: "member",
      status: "invited",
      permissions: ["orders.fulfil", "reports.view"],
    });
    expect(body.delivered).toBe(false);
    expect(body.link).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("accept-invite");
  });

  it("rejects unknown permission ids at the boundary", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);
    const response = await inviteMember(
      mutation(
        `/api/manage/${shop.id}/team`,
        {
          name: "Staff",
          email: "staff@example.com",
          permissions: ["wallets.topup"],
        },
        { cookie: session.token },
      ),
      params(shop.id),
    );
    expect(response.status).toBe(400);
  });

  it("the owner row cannot be disabled or edited from the admin side", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);
    for (const body of [{ status: "disabled" }, { permissions: [] }]) {
      const response = await patchMember(
        mutation(`/api/manage/${shop.id}/team/${owner.id}`, body, {
          cookie: session.token,
          method: "PATCH",
        }),
        params(shop.id, owner.id),
      );
      expect(response.status).toBe(403);
    }
    expect((await store.getById(owner.id))?.status).toBe("active");
  });

  it("disabling a member revokes their sessions immediately; enabling restores access", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id);
    const ownerSession = await store.createSession(owner.id);
    const memberSession = await store.createSession(member.id);

    const disable = await patchMember(
      mutation(
        `/api/manage/${shop.id}/team/${member.id}`,
        { status: "disabled", permissions: ["bundles.manage"] },
        { cookie: ownerSession.token, method: "PATCH" },
      ),
      params(shop.id, member.id),
    );
    expect(disable.status).toBe(200);
    expect((await disable.json()).admin).toMatchObject({
      status: "disabled",
      permissions: ["bundles.manage"],
    });
    expect(
      (
        await listTeam(
          read(`/api/manage/${shop.id}/team`, memberSession.token),
          params(shop.id),
        )
      ).status,
    ).toBe(401);

    const enable = await patchMember(
      mutation(
        `/api/manage/${shop.id}/team/${member.id}`,
        { status: "active" },
        { cookie: ownerSession.token, method: "PATCH" },
      ),
      params(shop.id, member.id),
    );
    expect((await enable.json()).admin.status).toBe("active");
    expect(
      await store.verifyPassword(shop.id, member.email, PASSWORD),
    ).toMatchObject({ id: member.id });
  });

  it("a member of another shop is a 404 to this shop's owner", async () => {
    const shopA = await seedShop("Shop A");
    const shopB = await seedShop("Shop B");
    const ownerA = await seedActiveOwner(shopA.id);
    const ownerB = await seedActiveOwner(shopB.id, "b@example.com");
    const memberB = await seedActiveMember(shopB.id, ownerB.id);
    const session = await store.createSession(ownerA.id);
    const response = await patchMember(
      mutation(
        `/api/manage/${shopA.id}/team/${memberB.id}`,
        { status: "disabled" },
        { cookie: session.token, method: "PATCH" },
      ),
      params(shopA.id, memberB.id),
    );
    expect(response.status).toBe(404);
    expect((await store.getById(memberB.id))?.status).toBe("active");
  });

  it("stops at ten logins with the agreed message", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);
    for (let index = 1; index < MAX_SHOP_LOGINS_PER_WEBSITE; index += 1) {
      await store.createMemberInvite({
        draftId: shop.id,
        email: `staff${index}@example.com`,
        name: `Staff ${index}`,
        permissions: [],
        invitedBy: owner.id,
      });
    }
    const response = await inviteMember(
      mutation(
        `/api/manage/${shop.id}/team`,
        { name: "Extra", email: "extra@example.com", permissions: [] },
        { cookie: session.token },
      ),
      params(shop.id),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This shop already has 10 logins.",
    });
  });

  it("resend mints a fresh invite for a pending member only", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const session = await store.createSession(owner.id);
    const pending = await store.createMemberInvite({
      draftId: shop.id,
      email: "pending@example.com",
      name: "Pending",
      permissions: [],
      invitedBy: owner.id,
    });
    const ok = await resendMember(
      mutation(
        `/api/manage/${shop.id}/team/${pending.admin.id}/resend`,
        {},
        {
          cookie: session.token,
        },
      ),
      params(shop.id, pending.admin.id),
    );
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.link).toBeUndefined();
    const tokens = chatStore.connection
      .prepare(
        "SELECT COUNT(*) AS n FROM studio_shop_admin_tokens WHERE admin_id = ? AND purpose = 'invite' AND used_at IS NULL",
      )
      .get(pending.admin.id) as { n: number };
    expect(Number(tokens.n)).toBe(2);

    const active = await seedActiveMember(shop.id, owner.id);
    const notPending = await resendMember(
      mutation(
        `/api/manage/${shop.id}/team/${active.id}/resend`,
        {},
        {
          cookie: session.token,
        },
      ),
      params(shop.id, active.id),
    );
    expect(notPending.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Orders isolation (the read path the pages use)
// ---------------------------------------------------------------------------

describe("orders read path", () => {
  it("pins reads to the website even when the same agency user owns both shops", async () => {
    const shopA = await seedShop("Shop A");
    const shopB = await seedShop("Shop B");
    const ownerId = canonicalUserId(agency);
    const base = {
      ownerId,
      status: "paid" as const,
      currency: "GHS",
      subtotal: 10,
      deliveryFee: 0,
      total: 10,
      lines: [{ itemId: "i1", name: "MTN 1GB", price: 10, quantity: 1 }],
      customerName: "Kwame",
      customerPhone: "0240000001",
      paymentMethod: "momo",
    };
    const orderA = await orders.create({
      ...base,
      draftId: shopA.id,
      accessCode: "access-a",
    });
    const orderB = await orders.create({
      ...base,
      draftId: shopB.id,
      accessCode: "access-b",
    });

    // What `/manage/[id]` does: owner-scoped list, ALWAYS pinned to draftId.
    const listA = await orders.listForOwner(ownerId, {
      limit: 50,
      filter: "all",
      draftId: shopA.id,
    });
    expect(listA.map((order) => order.id)).toEqual([orderA.id]);

    // What `/manage/[id]/orders/[orderId]` does: owner-scoped get, then the
    // draft check that turns a sibling website's order into a 404.
    const crossRead = await orders.getForOwner(ownerId, orderB.id);
    expect(crossRead?.draftId).toBe(shopB.id);
    expect(crossRead?.draftId === shopA.id).toBe(false);
  });
});
