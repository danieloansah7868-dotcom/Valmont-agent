/**
 * Stage 5 — the Studio connection routes over HTTP.
 *
 * The rules being pinned down are the ones that protect the key and the
 * tenant: the key never appears in any response, a malformed key is rejected
 * before TechChief is ever called, a rejected key stores nothing, another
 * person's website is a plain 404, and every mutating route needs the CSRF
 * header.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE,
  GET,
  PUT,
} from "@/app/api/studio/drafts/[id]/integrations/techchief/route";
import { POST as POST_TEST } from "@/app/api/studio/drafts/[id]/integrations/techchief/test/route";
import { POST as POST_SYNC } from "@/app/api/studio/drafts/[id]/integrations/techchief/sync-bundles/route";
import { resetRateLimitForTests } from "@/lib/security";
import { canonicalUserId } from "@/lib/user-identity";
import type {
  StudioIntegration,
  TechChiefConnectResult,
} from "@/lib/studio/integrations";

const mocks = vi.hoisted(() => ({
  requireApiSessionUser: vi.fn(),
  draftGet: vi.fn(),
  connectTechChief: vi.fn(),
  getTechChiefIntegration: vi.fn(),
  removeTechChiefIntegration: vi.fn(),
  testTechChiefConnection: vi.fn(),
  syncTechChiefBundles: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireApiSessionUser: mocks.requireApiSessionUser };
});

vi.mock("@/lib/studio/draft-store", () => ({
  getStudioDraftStore: () => ({ get: mocks.draftGet }),
}));

// A partial mock: the real view builder and key-format check stay in place, so
// the route's response shape is genuinely exercised.
vi.mock("@/lib/studio/integrations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/studio/integrations")>();
  return {
    ...actual,
    connectTechChief: mocks.connectTechChief,
    getTechChiefIntegration: mocks.getTechChiefIntegration,
    removeTechChiefIntegration: mocks.removeTechChiefIntegration,
    testTechChiefConnection: mocks.testTechChiefConnection,
    syncTechChiefBundles: mocks.syncTechChiefBundles,
  };
});

const csrf = "studio-integration-csrf-token-1234";
const draftId = "11111111-2222-4333-8444-555555555555";
const integrationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const apiKey = "TCHX-9F8E7D6C5B4A3210FEDCBA9876543210";
const sessionUser = { id: "user-1", login: "merchant", name: "Merchant" };
/** The stable internal id every owner-scoped write is keyed on. */
const ownerId = canonicalUserId(sessionUser);

const draft = {
  id: draftId,
  slug: "data-gh",
  status: "draft",
  updatedAt: new Date(0).toISOString(),
  brief: {
    schemaVersion: 2,
    category: "data-bundles",
    website: { name: "Data GH", locale: "en-GH" },
    items: [
      {
        id: "item-1",
        name: "MTN 1GB",
        price: 6.5,
        bundle: { network: "mtn", dataMb: 1024 },
      },
      {
        id: "item-2",
        name: "Telecel 5GB",
        price: 30,
        bundle: { network: "telecel", dataMb: 5120 },
      },
      // Not priced, so it is not something a customer can buy and never
      // appears in the "cannot be delivered" list.
      {
        id: "item-3",
        name: "MTN 500MB",
        bundle: { network: "mtn", dataMb: 512 },
      },
    ],
  },
};

/**
 * The shape the store hands back: camelCase, with the cached price list
 * already parsed and **no key** — only the prefix survives a read.
 */
const integration: StudioIntegration = {
  id: integrationId,
  draftId,
  ownerId: "user-1",
  provider: "techchief",
  keyPrefix: "TCHX-9F8E",
  webhookSecretSet: false,
  status: "verified",
  lastCheckedAt: "2026-09-01T10:00:00.000Z",
  walletBalance: 120,
  lowBalance: false,
  accountStatus: "active",
  lastError: undefined,
  bundles: [
    {
      id: 101,
      network: "MTN",
      sizeGb: 1,
      validityDays: 30,
      price: 6.2,
      currency: "GHS",
    },
  ],
  bundlesSyncedAt: "2026-09-01T10:00:00.000Z",
  pollWindowStart: "2026-09-01T10:00:00.000Z",
  pollCount: 3,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

const errorIntegration: StudioIntegration = {
  ...integration,
  status: "error",
  lastError:
    "TechChief rejected this key. Check it in your TechChief dashboard.",
};

function url(path: string) {
  return `http://localhost/api/studio/drafts/${draftId}/integrations/techchief${path}`;
}

function mutatingRequest(path: string, body: unknown = {}) {
  return new NextRequest(url(path), {
    method: "POST",
    headers: {
      cookie: `valmont_csrf=${csrf}`,
      "content-type": "application/json",
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("TechChief integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitForTests();
    vi.stubEnv("APP_URL", "https://shop.example.com");
    mocks.requireApiSessionUser.mockResolvedValue(sessionUser);
    mocks.draftGet.mockResolvedValue(draft);
    mocks.getTechChiefIntegration.mockResolvedValue(integration);
  });

  describe("GET the connection", () => {
    it("shows the state of the connection without any part of the key", async () => {
      const response = await GET(
        new NextRequest(url(""), { method: "GET" }),
        params(),
      );
      expect(response.status).toBe(200);

      const raw = await response.text();
      expect(raw).not.toContain(apiKey);
      expect(raw).not.toContain("AES256:");
      expect(raw).not.toContain("apiKey");

      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body.connected).toBe(true);
      expect(body.status).toBe("verified");
      expect(body.keyPrefix).toBe("TCHX-9F8E");
      expect(body.walletBalance).toBe(120);
      expect(body.bundleCount).toBe(1);
      expect(body.requestsThisHour).toBe(3);
      expect(body.requestsPerHour).toBe(60);
      // The webhook URL to paste into the TechChief dashboard.
      expect(body.webhookUrl).toBe(
        `https://shop.example.com/api/bundle-delivery/techchief/webhook?integration=${integrationId}`,
      );
      expect(body.webhookUrlIsHttps).toBe(true);
    });

    it("reports the catalogue items TechChief cannot deliver", async () => {
      const response = await GET(
        new NextRequest(url(""), { method: "GET" }),
        params(),
      );
      const body = (await response.json()) as {
        unmatchedItems: Array<{ itemId: string; reason: string }>;
      };
      expect(body.unmatchedItems.map((item) => item.itemId)).toEqual([
        "item-2",
      ]);
    });

    it("answers with an empty connection when nothing is saved", async () => {
      mocks.getTechChiefIntegration.mockResolvedValueOnce(null);
      const response = await GET(
        new NextRequest(url(""), { method: "GET" }),
        params(),
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.connected).toBe(false);
      expect(body.status).toBeNull();
      expect(body.keyPrefix).toBeNull();
      expect(body.webhookUrl).toBeNull();
    });

    it("never reports unmatched items for a website that is not a bundle shop", async () => {
      mocks.draftGet.mockResolvedValueOnce({
        ...draft,
        brief: { ...draft.brief, category: "food" },
      });
      const response = await GET(
        new NextRequest(url(""), { method: "GET" }),
        params(),
      );
      const body = (await response.json()) as { unmatchedItems: unknown[] };
      expect(body.unmatchedItems).toEqual([]);
    });
  });

  describe("PUT a key", () => {
    it("stores a key TechChief accepts and answers with the connection", async () => {
      const result: TechChiefConnectResult = {
        ok: true,
        integration,
        wallet: {
          walletBalance: 120,
          currency: "GHS",
          lowBalance: false,
          threshold: 50,
          accountStatus: "active",
          apiActivated: true,
          keyName: "Valmont shop",
        },
        bundleCount: 1,
      };
      mocks.connectTechChief.mockResolvedValue(result);

      const response = await PUT(
        new NextRequest(url(""), {
          method: "PUT",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "content-type": "application/json",
            "x-valmont-csrf": csrf,
          },
          body: JSON.stringify({ apiKey }),
        }),
        params(),
      );

      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain(apiKey);
      expect(mocks.connectTechChief).toHaveBeenCalledWith({
        draftId,
        ownerId,
        apiKey,
        webhookSecret: null,
      });
      expect((JSON.parse(raw) as Record<string, unknown>).status).toBe(
        "verified",
      );
    });

    it("rejects a malformed key with the owner's own wording and never calls TechChief", async () => {
      const response = await PUT(
        new NextRequest(url(""), {
          method: "PUT",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "content-type": "application/json",
            "x-valmont-csrf": csrf,
          },
          body: JSON.stringify({ apiKey: "not-a-key" }),
        }),
        params(),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("TCHX-");
      expect(mocks.connectTechChief).not.toHaveBeenCalled();
    });

    it("answers 400 when TechChief rejects the key", async () => {
      mocks.connectTechChief.mockResolvedValue({
        ok: false,
        reason: "rejected",
        message: "TechChief rejected this key.",
      } satisfies TechChiefConnectResult);

      const response = await PUT(
        new NextRequest(url(""), {
          method: "PUT",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "content-type": "application/json",
            "x-valmont-csrf": csrf,
          },
          body: JSON.stringify({ apiKey }),
        }),
        params(),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        "rejected",
      );
    });

    it("answers 502 when TechChief is unreachable, leaving the saved key alone", async () => {
      mocks.connectTechChief.mockResolvedValue({
        ok: false,
        reason: "unreachable",
        message: "TechChief did not answer.",
      } satisfies TechChiefConnectResult);

      const response = await PUT(
        new NextRequest(url(""), {
          method: "PUT",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "content-type": "application/json",
            "x-valmont-csrf": csrf,
          },
          body: JSON.stringify({ apiKey }),
        }),
        params(),
      );

      expect(response.status).toBe(502);
    });

    it("refuses without the CSRF header", async () => {
      const response = await PUT(
        new NextRequest(url(""), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey }),
        }),
        params(),
      );

      expect(response.status).toBe(403);
      expect(mocks.connectTechChief).not.toHaveBeenCalled();
    });

    it("answers 401 when nobody is signed in", async () => {
      const { NotConnectedError } = await import("@/lib/api-errors");
      mocks.requireApiSessionUser.mockRejectedValueOnce(
        new NotConnectedError(),
      );

      const response = await PUT(
        new NextRequest(url(""), {
          method: "PUT",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "content-type": "application/json",
            "x-valmont-csrf": csrf,
          },
          body: JSON.stringify({ apiKey }),
        }),
        params(),
      );

      expect(response.status).toBe(401);
      expect(mocks.connectTechChief).not.toHaveBeenCalled();
    });
  });

  describe("cross-tenant access", () => {
    it("answers 404 for somebody else's website and touches nothing", async () => {
      // An owner-scoped draft read finds nothing: another person's website and
      // a made-up id are indistinguishable from here.
      mocks.draftGet.mockResolvedValue(null);

      const get = await GET(
        new NextRequest(url(""), { method: "GET" }),
        params(),
      );
      expect(get.status).toBe(404);
      expect(mocks.getTechChiefIntegration).not.toHaveBeenCalled();

      const remove = await DELETE(
        new NextRequest(url(""), {
          method: "DELETE",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "x-valmont-csrf": csrf,
          },
        }),
        params(),
      );
      expect(remove.status).toBe(404);
      expect(mocks.removeTechChiefIntegration).not.toHaveBeenCalled();
    });
  });

  describe("DELETE the connection", () => {
    it("removes the saved key", async () => {
      const response = await DELETE(
        new NextRequest(url(""), {
          method: "DELETE",
          headers: {
            cookie: `valmont_csrf=${csrf}`,
            "x-valmont-csrf": csrf,
          },
        }),
        params(),
      );

      expect(response.status).toBe(204);
      expect(mocks.removeTechChiefIntegration).toHaveBeenCalledWith(draftId);
    });

    it("refuses without the CSRF header", async () => {
      const response = await DELETE(
        new NextRequest(url(""), { method: "DELETE" }),
        params(),
      );
      expect(response.status).toBe(403);
      expect(mocks.removeTechChiefIntegration).not.toHaveBeenCalled();
    });
  });

  describe("POST /test — check the balance", () => {
    it("answers with the wallet balance when the key works", async () => {
      mocks.testTechChiefConnection.mockResolvedValue({
        ok: true,
        integration: integration,
        wallet: {
          walletBalance: 88.5,
          lowBalance: false,
          accountStatus: "active",
        },
      });

      const response = await POST_TEST(mutatingRequest("/test"), params());

      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain(apiKey);
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body.walletBalance).toBe(88.5);
      expect(body.lowBalance).toBe(false);
      expect((body.connection as Record<string, unknown>).status).toBe(
        "verified",
      );
    });

    it("answers 404 when no key is saved yet", async () => {
      mocks.testTechChiefConnection.mockResolvedValue({
        ok: false,
        reason: "not_connected",
        message: "This website has no TechChief key saved yet.",
        integration: null,
      });

      const response = await POST_TEST(mutatingRequest("/test"), params());
      expect(response.status).toBe(404);
    });

    it("answers 429 when the hour's request budget is used up", async () => {
      mocks.testTechChiefConnection.mockResolvedValue({
        ok: false,
        reason: "budget",
        message: "TechChief request budget used up for this hour.",
        integration: integration,
      });

      const response = await POST_TEST(mutatingRequest("/test"), params());
      expect(response.status).toBe(429);
    });

    it("answers 400 when TechChief rejects the saved key", async () => {
      mocks.testTechChiefConnection.mockResolvedValue({
        ok: false,
        reason: "rejected",
        message: "TechChief rejected this key.",
        integration: errorIntegration,
      });

      const response = await POST_TEST(mutatingRequest("/test"), params());
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        connection: Record<string, unknown>;
      };
      expect(body.connection.status).toBe("error");
      expect(body.connection.lastError).toContain("rejected");
    });

    it("answers 502 when TechChief is unreachable", async () => {
      mocks.testTechChiefConnection.mockResolvedValue({
        ok: false,
        reason: "unreachable",
        message: "TechChief did not answer.",
        integration: integration,
      });

      const response = await POST_TEST(mutatingRequest("/test"), params());
      expect(response.status).toBe(502);
    });

    it("refuses without the CSRF header", async () => {
      const response = await POST_TEST(
        new NextRequest(url("/test"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        params(),
      );
      expect(response.status).toBe(403);
      expect(mocks.testTechChiefConnection).not.toHaveBeenCalled();
    });
  });

  describe("POST /sync-bundles — refresh the cached catalogue", () => {
    it("answers with the bundle count and the items TechChief cannot deliver", async () => {
      mocks.syncTechChiefBundles.mockResolvedValue({
        synced: true,
        count: 1,
        integration: integration,
      });

      const response = await POST_SYNC(
        mutatingRequest("/sync-bundles"),
        params(),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        count: number;
        unmatchedItems: Array<{ itemId: string }>;
      };
      expect(body.count).toBe(1);
      expect(body.unmatchedItems.map((item) => item.itemId)).toEqual([
        "item-2",
      ]);
      expect(mocks.syncTechChiefBundles).toHaveBeenCalledWith(integrationId);
    });

    it("answers 404 when no key is saved yet", async () => {
      mocks.getTechChiefIntegration.mockResolvedValueOnce(null);

      const response = await POST_SYNC(
        mutatingRequest("/sync-bundles"),
        params(),
      );

      expect(response.status).toBe(404);
      expect(mocks.syncTechChiefBundles).not.toHaveBeenCalled();
    });

    it("answers 502 when TechChief is unreachable and keeps the old cache", async () => {
      mocks.syncTechChiefBundles.mockResolvedValue({
        synced: false,
        count: 0,
        integration: integration,
      });

      const response = await POST_SYNC(
        mutatingRequest("/sync-bundles"),
        params(),
      );

      expect(response.status).toBe(502);
      // The cached catalogue is still reported, so the owner sees what they had.
      const body = (await response.json()) as {
        connection: { bundleCount: number };
      };
      expect(body.connection.bundleCount).toBe(1);
    });

    it("refuses without the CSRF header", async () => {
      const response = await POST_SYNC(
        new NextRequest(url("/sync-bundles"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        params(),
      );
      expect(response.status).toBe(403);
      expect(mocks.syncTechChiefBundles).not.toHaveBeenCalled();
    });
  });

  describe("rate limiting", () => {
    it("refuses an owner who hammers the connection routes", async () => {
      mocks.testTechChiefConnection.mockResolvedValue({
        ok: true,
        integration: integration,
        wallet: {
          walletBalance: 10,
          lowBalance: false,
          accountStatus: "active",
        },
      });

      let limited = 0;
      for (let index = 0; index < 40; index += 1) {
        const response = await POST_TEST(mutatingRequest("/test"), params());
        if (response.status === 429) limited += 1;
      }
      expect(limited).toBeGreaterThan(0);
    });
  });
});
