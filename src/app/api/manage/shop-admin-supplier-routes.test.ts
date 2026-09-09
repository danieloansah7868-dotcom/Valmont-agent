/**
 * Stage 6d — the shop's Supplier refresh route (POST …/supplier/refresh)
 * against the real handler and a throwaway SQLite database, modelled exactly
 * on 6c's `shop-admin-actions-routes.test.ts`. No store is mocked; `fetch`
 * is stubbed with every call counted by endpoint, so "TechChief was called
 * once" and "TechChief was NOT called" are both proved by count.
 *
 * The route is deliberately a thin shell over `testTechChiefConnection` (the
 * same library call the Studio "Check balance" button uses), so the matrix
 * pins the shop-side rules on top of it:
 *
 *  - csrf 403, no cookie 401, other-shop session 404, member without the
 *    supplier.manage box 403 ("Your login does not include this action."),
 *    non-bundle website 404, Starter (no supplier_page) 403 ("Not included
 *    in your package.");
 *  - no key saved → 404 with the not-connected sentence and ZERO TechChief
 *    calls;
 *  - a refresh within the 10-minute window → 429 with the too-soon sentence
 *    and ZERO TechChief calls;
 *  - a success performs EXACTLY ONE dev_wallet.php call (one budget slot)
 *    and answers with the supplier view;
 *  - the 7th refresh in the same hour → 429 (the hourly ceiling of 6), even
 *    when the last check is 11 minutes back, so the refusal is provably the
 *    hourly bucket and not the 10-minute rule;
 *  - testTechChiefConnection's own outcomes map: rejected → 400, budget
 *    (TechChief hourly allowance gone) → 429, unreachable → 502.
 *
 * Every body — success and refusal alike — carries the `supplier` projection
 * and never a secret: no key, no webhook URL, no owner id.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSqliteChatStore,
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import {
  resetShopAdminPurgeClockForTests,
  SqliteShopAdminStore,
} from "@/lib/shop-admin/store";
import { SHOP_SESSION_COOKIE } from "@/lib/shop-admin/auth";
import {
  SUPPLIER_NOT_CONNECTED_API_MESSAGE,
  SUPPLIER_REFRESH_TOO_SOON_MESSAGE,
} from "@/lib/shop-admin/supplier";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { starterBundleCatalogue } from "@/lib/studio/bundles";
import {
  connectTechChief,
  SqliteIntegrationsStore,
  TECHCHIEF_BUDGET_EXHAUSTED_MESSAGE,
  TECHCHIEF_KEY_REJECTED_MESSAGE,
  TECHCHIEF_UNREACHABLE_MESSAGE,
} from "@/lib/studio/integrations";
import { PACKAGE_NOT_INCLUDED_MESSAGE } from "@/lib/studio/plans";
import { POST as refresh } from "./[id]/supplier/refresh/route";

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const PASSWORD = "correct horse battery";
const KEY = "TCHX-Ab12Cd34Ef56Gh78";
const KEY_PREFIX = "TCHX-Ab12";
const csrf = "shop-admin-supplier-csrf-token-1234";

const dirs: string[] = [];
let drafts: SqliteStudioDraftStore;
let store: SqliteShopAdminStore;
let integrations: SqliteIntegrationsStore;

const fetchMock = vi.fn();
/** Every outbound HTTP call made during a test, by endpoint file name. */
let calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The TechChief stub. `wallet` selects what dev_wallet.php answers per test:
 * the default answers a healthy verified wallet; `reject` answers 401 (key
 * revoked — an auth failure); `unreachable` drops the network so the probe
 * fails with a network error. dev_bundles.php always answers one sellable
 * bundle so `connectTechChief` can verify a key and cache a price list.
 */
function stubFetch(wallet: "ok" | "reject" | "unreachable" = "ok") {
  fetchMock.mockImplementation((url: string) => {
    const target = new URL(url);
    calls.push(target.pathname.split("/").pop() ?? target.pathname);
    if (target.pathname.endsWith("dev_wallet.php")) {
      if (wallet === "reject") {
        return Promise.resolve(
          json({ success: false, error: "Invalid API key" }, 401),
        );
      }
      if (wallet === "unreachable") {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(
        json({
          success: true,
          wallet_balance: 42.5,
          currency: "GHS",
          low_balance: false,
          threshold: 20,
          account_status: "active",
          api_activated: true,
          key_name: "Adom Data",
        }),
      );
    }
    if (target.pathname.endsWith("dev_bundles.php")) {
      return Promise.resolve(
        json({
          success: true,
          bundles: [
            {
              id: 11,
              network: "MTN",
              size_gb: 1,
              validity_days: 7,
              price: 8.5,
              currency: "GHS",
            },
          ],
        }),
      );
    }
    return Promise.resolve(json({}, 500));
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TRUST_PROXY", "false");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  delete process.env.BUNDLE_DELIVERY_PROVIDER;
  resetRateLimitForTests();
  resetShopAdminPurgeClockForTests();
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-supplier-routes-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  store = new SqliteShopAdminStore();
  integrations = new SqliteIntegrationsStore();
  calls = [];
  fetchMock.mockReset();
  stubFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(
  url: string,
  options: {
    cookie?: string;
    csrf?: boolean;
  } = {},
) {
  const cookies = [
    options.csrf === false ? null : `valmont_csrf=${csrf}`,
    options.cookie ? `${SHOP_SESSION_COOKIE}=${options.cookie}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookies ? { cookie: cookies } : {}),
      ...(options.csrf === false ? {} : { "x-valmont-csrf": csrf }),
    },
    body: JSON.stringify({}),
  });
}

function params<T extends Record<string, string>>(values: T) {
  return { params: Promise.resolve(values) };
}

async function seedShop(
  plan: "starter" | "auto_dispatch" | "command_center" = "auto_dispatch",
  overrides: { category?: "restaurant"; name?: string } = {},
) {
  return drafts.create(
    agency,
    createDefaultBrief({
      businessName: overrides.name ?? "Data GH",
      category: overrides.category ?? "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
      items: overrides.category
        ? [{ id: "i1", name: "Jollof Rice", price: 45 }]
        : starterBundleCatalogue(),
      plan,
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        valmontPay: { provisioned: true },
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        notifications: { email: "owner@adom.example" },
        staged: { enabled: false, stages: [] },
      },
    }),
  );
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

async function seedActiveMember(
  draftId: string,
  invitedBy: string,
  permissions: readonly string[],
  email = "staff@example.com",
) {
  const invite = await store.createMemberInvite({
    draftId,
    email,
    name: "Staff",
    permissions,
    invitedBy,
  });
  const admin = await store.acceptInvite(invite.token, "Staff", PASSWORD);
  if (!admin) throw new Error("invite should have been accepted");
  return admin;
}

async function loginCookie(adminId: string): Promise<string> {
  const session = await store.createSession(adminId);
  return session.token;
}

function refreshUrl(draftId: string) {
  return `/api/manage/${draftId}/supplier/refresh`;
}

/** Saves a verified TechChief connection, then zeroes the call log. */
async function seedVerifiedConnection(draftId: string): Promise<void> {
  const result = await connectTechChief({
    draftId,
    ownerId: canonicalUserId(agency),
    apiKey: KEY,
    store: integrations,
  });
  if (!result.ok)
    throw new Error(`expected a verified connection: ${result.message}`);
  calls = [];
}

/**
 * Connecting stores `last_checked_at = now`, and the route refuses any
 * refresh within 10 minutes of the last check. A test that wants the refresh
 * to really probe must first age the stored check past the interval, exactly
 * as real usage does (Studio checked the key when it was saved, minutes ago).
 */
function ageLastCheckPastInterval(): void {
  const db = getSqliteChatStore().connection;
  db.prepare("UPDATE studio_integrations SET last_checked_at = ?").run(
    new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  );
}

/** No secret text or forbidden field name may appear in ANY response body. */
function expectNoSecrets(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("apiKey");
  expect(text).not.toContain("webhookUrl");
  expect(text).not.toContain("webhookSecret");
  expect(text).not.toContain("ownerId");
  expect(text).not.toContain(canonicalUserId(agency));
}

describe("POST /api/manage/[id]/supplier/refresh — gates first, TechChief never on a refusal", () => {
  it("requires CSRF (403) and a session cookie (401) with zero TechChief calls", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const url = refreshUrl(shop.id);

    const noCsrf = await refresh(
      request(url, { csrf: false, cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(noCsrf.status).toBe(403);

    const noCookie = await refresh(request(url), params({ id: shop.id }));
    expect(noCookie.status).toBe(401);

    expect(calls).toEqual([]);
  });

  it("answers 404 for a session of another shop", async () => {
    const shopA = await seedShop(undefined, { name: "Shop A" });
    const shopB = await seedShop(undefined, { name: "Shop B" });
    const ownerB = await seedActiveOwner(shopB.id, "b@example.com");
    const response = await refresh(
      request(refreshUrl(shopA.id), { cookie: await loginCookie(ownerB.id) }),
      params({ id: shopA.id }),
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("answers 403 for a member without the supplier.manage box", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(shop.id, owner.id, []);
    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(member.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Your login does not include this action. Ask the shop owner.",
    });
    expect(calls).toEqual([]);
  });

  it("answers 200 for a member WITH the supplier.manage box", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const member = await seedActiveMember(
      shop.id,
      owner.id,
      ["supplier.manage"],
      "supplier@example.com",
    );
    await seedVerifiedConnection(shop.id);
    ageLastCheckPastInterval();
    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(member.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(200);
    expect(
      calls.filter((endpoint) => endpoint === "dev_wallet.php"),
    ).toHaveLength(1);
  });

  it("answers 404 for a website that is not a bundle shop", async () => {
    const restaurant = await seedShop("auto_dispatch", {
      category: "restaurant",
    });
    const owner = await seedActiveOwner(restaurant.id);
    const response = await refresh(
      request(refreshUrl(restaurant.id), {
        cookie: await loginCookie(owner.id),
      }),
      params({ id: restaurant.id }),
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("answers 403 with the package sentence on a Starter shop, zero TechChief calls", async () => {
    const shop = await seedShop("starter");
    const owner = await seedActiveOwner(shop.id);
    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: PACKAGE_NOT_INCLUDED_MESSAGE,
    });
    expect(calls).toEqual([]);
  });

  it("answers 404 with the not-connected sentence when no key is saved, zero TechChief calls", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe(SUPPLIER_NOT_CONNECTED_API_MESSAGE);
    // The supplier projection says connected:false — and nothing else.
    const supplier = body.supplier as Record<string, unknown>;
    expect(supplier.connected).toBe(false);
    expect(supplier.status).toBeNull();
    expect(supplier.keyPrefix).toBeNull();
    expect(JSON.stringify(body)).not.toContain("webhookUrl");
    expect(calls).toEqual([]);
  });
});

describe("POST /api/manage/[id]/supplier/refresh — the refresh itself", () => {
  it("answers 200 with the supplier view after EXACTLY ONE dev_wallet.php call", async () => {
    const shop = await seedShop("command_center");
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    ageLastCheckPastInterval();

    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.error).toBeUndefined();

    const supplier = body.supplier as Record<string, unknown>;
    expect(supplier.connected).toBe(true);
    expect(supplier.status).toBe("verified");
    expect(supplier.keyPrefix).toBe(KEY_PREFIX);
    expect(supplier.walletBalance).toBe(42.5);
    expect(supplier.lowBalance).toBe(false);
    expect(supplier.accountStatus).toBe("active");
    expect(supplier.lastCheckedAt).toBeTruthy();
    expect(supplier.bundleCount).toBeGreaterThan(0);
    expect(supplier.requestsThisHour).toBeGreaterThan(0);
    expect(supplier.requestsPerHour).toBe(60);

    // Exactly one wallet probe — one budget slot — and nothing else.
    expect(
      calls.filter((endpoint) => endpoint === "dev_wallet.php"),
    ).toHaveLength(1);

    expectNoSecrets(text);
  });

  it("answers 429 with the too-soon sentence within 10 minutes and ZERO further TechChief calls", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    ageLastCheckPastInterval();
    const cookie = await loginCookie(owner.id);

    const first = await refresh(
      request(refreshUrl(shop.id), { cookie }),
      params({ id: shop.id }),
    );
    expect(first.status).toBe(200);
    expect(
      calls.filter((endpoint) => endpoint === "dev_wallet.php"),
    ).toHaveLength(1);

    const second = await refresh(
      request(refreshUrl(shop.id), { cookie }),
      params({ id: shop.id }),
    );
    expect(second.status).toBe(429);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.error).toBe(SUPPLIER_REFRESH_TOO_SOON_MESSAGE);
    // The stored connection state is still in the answer…
    expect((body.supplier as Record<string, unknown>).connected).toBe(true);
    expect((body.supplier as Record<string, unknown>).walletBalance).toBe(42.5);
    // …and the refusal cost nothing: the call log is unchanged.
    expect(
      calls.filter((endpoint) => endpoint === "dev_wallet.php"),
    ).toHaveLength(1);
  });

  it("the 7th refresh in the hour is refused 429 (the ceiling is 6), with the last check kept 11 minutes back", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    const cookie = await loginCookie(owner.id);

    // Six successful refreshes. Each one updates last_checked_at to now, so —
    // exactly like the spec's instruction — the stored check is aged back
    // 11 minutes before every call, keeping the 10-minute rule out of the way.
    for (let index = 0; index < 6; index += 1) {
      ageLastCheckPastInterval();
      const response = await refresh(
        request(refreshUrl(shop.id), { cookie }),
        params({ id: shop.id }),
      );
      expect(response.status).toBe(200);
    }
    expect(
      calls.filter((endpoint) => endpoint === "dev_wallet.php"),
    ).toHaveLength(6);

    // The 7th attempt inside the same hour is refused by the hourly bucket
    // before any of the refresh logic runs — one more dev_wallet.php call
    // would have happened otherwise.
    ageLastCheckPastInterval();
    const seventh = await refresh(
      request(refreshUrl(shop.id), { cookie }),
      params({ id: shop.id }),
    );
    expect(seventh.status).toBe(429);
    expect(await seventh.json()).toEqual({
      error: "Rate limit exceeded. Please wait before trying again.",
    });
    expect(
      calls.filter((endpoint) => endpoint === "dev_wallet.php"),
    ).toHaveLength(6);
  });
});

describe("POST /api/manage/[id]/supplier/refresh — testTechChiefConnection outcomes", () => {
  it("a rejected key answers 400 with the rejected sentence and the error status stored", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    ageLastCheckPastInterval();
    stubFetch("reject");

    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.error).toBe(TECHCHIEF_KEY_REJECTED_MESSAGE);
    expect((body.supplier as Record<string, unknown>).status).toBe("error");
    expectNoSecrets(text);
  });

  it("an exhausted TechChief hourly allowance answers 429 before any probe", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    ageLastCheckPastInterval();
    // Spend the whole hourly poll budget on the stored row: the refresh then
    // refuses at the budget check — dev_wallet.php is never called.
    const db = getSqliteChatStore().connection;
    const row = db
      .prepare("SELECT id FROM studio_integrations LIMIT 1")
      .get() as { id: string };
    await integrations.patch(row.id, {
      pollWindowStart: new Date().toISOString(),
      pollCount: 50,
    });

    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(429);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.error).toBe(TECHCHIEF_BUDGET_EXHAUSTED_MESSAGE);
    // The connection stays verified — the refusal changed nothing.
    expect((body.supplier as Record<string, unknown>).status).toBe("verified");
    expect(calls).toEqual([]);
    expectNoSecrets(text);
  });

  it("an unreachable TechChief answers 502 with the unreachable sentence", async () => {
    const shop = await seedShop();
    const owner = await seedActiveOwner(shop.id);
    await seedVerifiedConnection(shop.id);
    ageLastCheckPastInterval();
    stubFetch("unreachable");

    const response = await refresh(
      request(refreshUrl(shop.id), { cookie: await loginCookie(owner.id) }),
      params({ id: shop.id }),
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.error).toBe(TECHCHIEF_UNREACHABLE_MESSAGE);
    // A network blip says nothing about the key: the row stays verified.
    expect((body.supplier as Record<string, unknown>).status).toBe("verified");
    expectNoSecrets(text);
  });
});
