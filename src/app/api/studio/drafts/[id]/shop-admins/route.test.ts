/**
 * Stage 6b — the Studio → Shop logins routes over HTTP.
 *
 * The agency session is mocked (that is what `requireApiSessionUser` is
 * for); the draft store is real, on a throwaway SQLite database, because the
 * whole point of the owner-scoped `get` is that another agency user's website
 * is a plain 404 — and that must be proved against the real query. The
 * shop-admin store is real too, so the "link only when email is unconfigured"
 * rule is tested end to end.
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
import { hashCustomerToken } from "@/lib/customer-password";
import {
  resetShopAdminPurgeClockForTests,
  SqliteShopAdminStore,
} from "@/lib/shop-admin/store";
import { GET, POST } from "./route";
import { PATCH } from "./[adminId]/route";
import { POST as RESEND } from "./[adminId]/resend/route";
import { POST as RESET_LINK } from "./[adminId]/reset-link/route";

const mocks = vi.hoisted(() => ({
  requireApiSessionUser: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireApiSessionUser: mocks.requireApiSessionUser };
});

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const stranger: SessionUser = { id: "9002", login: "kofi", name: "Kofi" };
const csrf = "studio-shop-admins-csrf-token-1234";

const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;
let store: SqliteShopAdminStore;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TRUST_PROXY", "false");
  vi.stubEnv("APP_URL", "https://valmont.example");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  resetRateLimitForTests();
  resetShopAdminPurgeClockForTests();
  mocks.requireApiSessionUser.mockReset();
  mocks.requireApiSessionUser.mockResolvedValue(agency);
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-studio-shop-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  store = new SqliteShopAdminStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function mutation(
  url: string,
  body: unknown,
  options: { method?: string; csrf?: boolean } = {},
) {
  return new NextRequest(`https://valmont.example${url}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(options.csrf === false
        ? {}
        : { cookie: `valmont_csrf=${csrf}`, "x-valmont-csrf": csrf }),
    },
    body: JSON.stringify(body),
  });
}

function read(url: string) {
  return new NextRequest(`https://valmont.example${url}`, { method: "GET" });
}

function params(id: string, adminId?: string) {
  return {
    params: Promise.resolve(
      adminId ? { id, adminId } : ({ id } as { id: string; adminId: string }),
    ),
  };
}

async function seedShop(user: SessionUser = agency) {
  return drafts.create(user, {
    ...createDefaultBrief(),
    category: "data-bundles",
    businessName: "Data GH",
  });
}

const ownerBody = { name: "Kofi Mensah", email: "Owner@Example.com" };

describe("POST /api/studio/drafts/[id]/shop-admins", () => {
  it("needs the agency session and the CSRF header", async () => {
    const shop = await seedShop();
    const noCsrf = await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, ownerBody, {
        csrf: false,
      }),
      params(shop.id),
    );
    expect(noCsrf.status).toBe(403);

    const { NotConnectedError } = await import("@/lib/api-errors");
    mocks.requireApiSessionUser.mockRejectedValueOnce(new NotConnectedError());
    const anonymous = await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, ownerBody),
      params(shop.id),
    );
    expect(anonymous.status).toBe(401);
    expect(await store.listForDraft(shop.id)).toEqual([]);
  });

  it("creates the owner and returns the one-time link when email is not configured", async () => {
    const shop = await seedShop();
    const response = await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, ownerBody),
      params(shop.id),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.admin).toMatchObject({
      role: "owner",
      status: "invited",
      email: "owner@example.com",
      name: "Kofi Mensah",
    });
    expect(body.delivered).toBe(false);
    expect(body.link).toMatch(
      new RegExp(
        `^https://valmont\\.example/manage/${shop.id}/accept-invite\\?token=`,
      ),
    );

    // The link's token is exactly the invite the store holds — hashed.
    const token = new URL(body.link).searchParams.get("token")!;
    const row = chatStore.connection
      .prepare("SELECT token_hash FROM studio_shop_admin_tokens")
      .get() as { token_hash: string };
    expect(row.token_hash).toBe(hashCustomerToken(token));
    expect(await store.peekInvite(token)).toMatchObject({ id: body.admin.id });
  });

  it("emails the link and never returns it when a provider is configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_1234567890");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "Valmont <noreply@valmont.example>");
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mocks.fetch);

    const shop = await seedShop();
    const response = await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, ownerBody),
      params(shop.id),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.delivered).toBe(true);
    expect(body.link).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("accept-invite");

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const sent = JSON.parse(String(init.body)) as {
      to: string[];
      text: string;
    };
    expect(sent.to).toEqual(["owner@example.com"]);
    expect(sent.text).toContain(`/manage/${shop.id}/accept-invite?token=`);
  });

  it("answers 409 for a second owner", async () => {
    const shop = await seedShop();
    await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, ownerBody),
      params(shop.id),
    );
    const again = await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, {
        name: "Other",
        email: "other@example.com",
      }),
      params(shop.id),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "This shop already has an owner login.",
    });
  });

  it("rejects a bad email or a missing name without touching the store", async () => {
    const shop = await seedShop();
    for (const body of [
      { name: "Kofi", email: "not-an-email" },
      { name: "", email: "owner@example.com" },
      { email: "owner@example.com" },
    ]) {
      const response = await POST(
        mutation(`/api/studio/drafts/${shop.id}/shop-admins`, body),
        params(shop.id),
      );
      expect(response.status).toBe(400);
    }
    expect(await store.listForDraft(shop.id)).toEqual([]);
  });
});

describe("another agency user's website", () => {
  it("is a plain 404 on every route, and nothing is created or changed", async () => {
    const shop = await seedShop(agency);
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    mocks.requireApiSessionUser.mockResolvedValue(stranger);

    const list = await GET(
      read(`/api/studio/drafts/${shop.id}/shop-admins`),
      params(shop.id),
    );
    expect(list.status).toBe(404);

    const create = await POST(
      mutation(`/api/studio/drafts/${shop.id}/shop-admins`, {
        name: "Thief",
        email: "thief@example.com",
      }),
      params(shop.id),
    );
    expect(create.status).toBe(404);

    const patch = await PATCH(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}`,
        { status: "disabled" },
        { method: "PATCH" },
      ),
      params(shop.id, invite.admin.id),
    );
    expect(patch.status).toBe(404);

    const resend = await RESEND(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}/resend`,
        {},
      ),
      params(shop.id, invite.admin.id),
    );
    expect(resend.status).toBe(404);

    const reset = await RESET_LINK(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}/reset-link`,
        {},
      ),
      params(shop.id, invite.admin.id),
    );
    expect(reset.status).toBe(404);

    const admins = await store.listForDraft(shop.id);
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ status: "invited", name: "Kofi" });
    const tokens = chatStore.connection
      .prepare("SELECT COUNT(*) AS n FROM studio_shop_admin_tokens")
      .get() as { n: number };
    expect(Number(tokens.n)).toBe(1);
  });

  it("a login that belongs to a different website of the same user is 404", async () => {
    const shopA = await seedShop();
    const shopB = await seedShop();
    const inviteB = await store.createOwnerInvite({
      draftId: shopB.id,
      email: "b@example.com",
      name: "B",
      invitedBy: "agency",
    });
    const response = await PATCH(
      mutation(
        `/api/studio/drafts/${shopA.id}/shop-admins/${inviteB.admin.id}`,
        { status: "disabled" },
        { method: "PATCH" },
      ),
      params(shopA.id, inviteB.admin.id),
    );
    expect(response.status).toBe(404);
    expect((await store.getById(inviteB.admin.id))?.status).toBe("invited");
  });
});

describe("GET, PATCH, resend and reset-link", () => {
  it("lists logins without hashes and reports whether email is configured", async () => {
    const shop = await seedShop();
    await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    const response = await GET(
      read(`/api/studio/drafts/${shop.id}/shop-admins`),
      params(shop.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.emailConfigured).toBe(false);
    expect(body.admins).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(
      /passwordHash|password_hash|token/,
    );
  });

  it("the agency can disable and re-enable the owner; disabling revokes sessions", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    const owner = await store.acceptInvite(
      invite.token,
      "Kofi",
      "a long password",
    );
    const session = await store.createSession(owner!.id);

    const disable = await PATCH(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${owner!.id}`,
        { status: "disabled" },
        { method: "PATCH" },
      ),
      params(shop.id, owner!.id),
    );
    expect(disable.status).toBe(200);
    expect((await disable.json()).admin.status).toBe("disabled");
    expect(await store.getSession(session.token)).toBeNull();

    const enable = await PATCH(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${owner!.id}`,
        { status: "active" },
        { method: "PATCH" },
      ),
      params(shop.id, owner!.id),
    );
    expect((await enable.json()).admin.status).toBe("active");
  });

  it("re-enabling someone who never accepted goes back to invited", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });
    await store.setStatus(invite.admin.id, "disabled");
    const enable = await PATCH(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}`,
        { status: "active" },
        { method: "PATCH" },
      ),
      params(shop.id, invite.admin.id),
    );
    expect((await enable.json()).admin.status).toBe("invited");
  });

  it("resend mints a fresh invite link (returned once); reset-link needs an active login", async () => {
    const shop = await seedShop();
    const invite = await store.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Kofi",
      invitedBy: "agency",
    });

    const resend = await RESEND(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}/resend`,
        {},
      ),
      params(shop.id, invite.admin.id),
    );
    expect(resend.status).toBe(200);
    const resendBody = await resend.json();
    expect(resendBody.link).toContain(
      `/manage/${shop.id}/accept-invite?token=`,
    );
    const resendToken = new URL(resendBody.link).searchParams.get("token")!;
    expect(resendToken).not.toBe(invite.token);
    expect(await store.peekInvite(resendToken)).not.toBeNull();

    // Not active yet: no reset link.
    const tooEarly = await RESET_LINK(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}/reset-link`,
        {},
      ),
      params(shop.id, invite.admin.id),
    );
    expect(tooEarly.status).toBe(409);

    await store.acceptInvite(resendToken, "Kofi", "a long password");
    const reset = await RESET_LINK(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}/reset-link`,
        {},
      ),
      params(shop.id, invite.admin.id),
    );
    expect(reset.status).toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.link).toContain(
      `/manage/${shop.id}/reset-password?token=`,
    );
    const resetToken = new URL(resetBody.link).searchParams.get("token")!;
    expect(await store.consumeResetToken(resetToken)).toBe(invite.admin.id);

    // An accepted login cannot be re-invited.
    const lateResend = await RESEND(
      mutation(
        `/api/studio/drafts/${shop.id}/shop-admins/${invite.admin.id}/resend`,
        {},
      ),
      params(shop.id, invite.admin.id),
    );
    expect(lateResend.status).toBe(409);
  });

  it("takes the owner's rate-limit slot", async () => {
    const shop = await seedShop();
    let lastStatus = 0;
    for (let index = 0; index < 31; index += 1) {
      lastStatus = (
        await GET(
          read(`/api/studio/drafts/${shop.id}/shop-admins`),
          params(shop.id),
        )
      ).status;
    }
    expect(lastStatus).toBe(429);
  });
});
