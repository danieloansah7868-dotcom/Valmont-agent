import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalUserId } from "@/lib/user-identity";
import type { SessionUser } from "@/lib/auth";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { starterBundleCatalogue } from "@/lib/studio/bundles";
import { SqliteShopAdminStore } from "@/lib/shop-admin/store";
import { SHOP_SESSION_COOKIE } from "@/lib/shop-admin/auth";
import { resetRateLimitForTests } from "@/lib/security";
import { resetShopAdminPurgeClockForTests } from "@/lib/shop-admin/store";
import { SqliteShopAgentStore } from "@/lib/shop-agent/store";
import { PACKAGE_NOT_INCLUDED_MESSAGE } from "@/lib/studio/plans";
import { POST as createAgent } from "./[id]/agents/route";
import { POST as wallet } from "./[id]/agents/[agentId]/wallet/route";
import { POST as agentLogin } from "../a/[id]/auth/login/route";
import { SHOP_AGENT_SESSION_COOKIE } from "@/lib/shop-agent/auth";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const password = "correct horse battery";
const csrf = "csrf-token-for-shop-agent-tests";
let dir: string;
let shopId: string;
let ownerCookie: string;
let adminStore: SqliteShopAdminStore;
let agentStore: SqliteShopAgentStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "valmont-agent-routes-"));
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat.sqlite"),
      path.join(dir, "chat.json"),
    ),
  );
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TRUST_PROXY = "false";
  resetRateLimitForTests();
  resetShopAdminPurgeClockForTests();
  const drafts = new SqliteStudioDraftStore();
  const draft = await drafts.create(agency, {
    ...createDefaultBrief({
      businessName: "Data GH",
      category: "data-bundles",
      items: starterBundleCatalogue(),
    }),
    plan: "command_center",
  });
  shopId = draft.id;
  adminStore = new SqliteShopAdminStore();
  const invite = await adminStore.createOwnerInvite({
    draftId: shopId,
    email: "owner@example.com",
    name: "Owner",
    invitedBy: canonicalUserId(agency),
  });
  const owner = await adminStore.acceptInvite(invite.token, "Owner", password);
  ownerCookie = (await adminStore.createSession(owner!.id)).token;
  agentStore = new SqliteShopAgentStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
});

function request(url: string, body: unknown, cookie = ownerCookie) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SHOP_SESSION_COOKIE}=${cookie}; valmont_csrf=${csrf}`,
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify(body),
  });
}
function params<T extends Record<string, string>>(values: T) {
  return { params: Promise.resolve(values) };
}

describe("Stage 7a route boundaries", () => {
  it("creates an agent without returning an invite link, and writes owner wallet entries", async () => {
    const response = await createAgent(
      request(`/api/manage/${shopId}/agents`, {
        name: "Reseller",
        email: "reseller@example.com",
      }),
      params({ id: shopId }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.delivered).toBe(false);
    expect(body).not.toHaveProperty("link");
    expect(JSON.stringify(body)).not.toContain("valmont_shop_agent");
    const agent = await agentStore.getByEmail(shopId, "reseller@example.com");
    expect(agent).not.toBeNull();
    const added = await wallet(
      request(`/api/manage/${shopId}/agents/${agent!.id}/wallet`, {
        kind: "credit",
        amount: 50,
      }),
      params({ id: shopId, agentId: agent!.id }),
    );
    expect(added.status).toBe(201);
    const removed = await wallet(
      request(`/api/manage/${shopId}/agents/${agent!.id}/wallet`, {
        kind: "deduct",
        amount: 20,
      }),
      params({ id: shopId, agentId: agent!.id }),
    );
    expect(removed.status).toBe(201);
    const overdraw = await wallet(
      request(`/api/manage/${shopId}/agents/${agent!.id}/wallet`, {
        kind: "deduct",
        amount: 31,
      }),
      params({ id: shopId, agentId: agent!.id }),
    );
    expect(overdraw.status).toBe(409);
    expect((await agentStore.getById(agent!.id))?.balance).toBe(30);
  });

  it("refuses a non-bundle agent API with the package error", async () => {
    const other = await new SqliteStudioDraftStore().create(agency, {
      ...createDefaultBrief({
        businessName: "Other Shop",
        category: "business-profile",
      }),
      plan: "command_center",
    });
    const response = await agentLogin(
      request(`/api/a/${other.id}/auth/login`, {
        email: "nobody@example.com",
        password,
      }),
      params({ id: other.id }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PACKAGE_NOT_INCLUDED_MESSAGE);
  });

  it("signs an active agent in with a separate cookie", async () => {
    const agent = await agentStore.createInvite({
      draftId: shopId,
      email: "active@example.com",
      name: "Active",
      invitedBy: "owner",
    });
    const token = await agentStore.createInviteToken(agent.id);
    await agentStore.acceptInvite(token.token, "Active", password);
    const response = await agentLogin(
      request(
        `/api/a/${shopId}/auth/login`,
        { email: "active@example.com", password },
        "not-an-admin-session",
      ),
      params({ id: shopId }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      SHOP_AGENT_SESSION_COOKIE,
    );
    expect((await response.json()).agent.email).toBe("active@example.com");
  });
});
