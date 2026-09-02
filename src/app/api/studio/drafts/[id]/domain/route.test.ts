import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import type { DomainRow } from "@/lib/studio/domains";

vi.mock("@/lib/auth");
vi.mock("@/lib/security", () => ({ assertCsrf: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, assertOwnerRateLimit: vi.fn() };
});

const dns = vi.hoisted(() => ({
  resolveCname: vi.fn(),
  resolveTxt: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ default: dns }));

/**
 * An in-memory domain store: the route's behaviour is what is under test,
 * and the SQLite/PostgreSQL stores have their own suite.
 */
const rows = new Map<string, DomainRow>();
vi.mock("@/lib/studio/domains", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/studio/domains")>();
  return {
    ...original,
    getDomainStore: () => ({
      async getDomain(draftId: string) {
        return rows.get(draftId) ?? null;
      },
      async getDomainByHostname(hostname: string) {
        return (
          [...rows.values()].find((row) => row.hostname === hostname) ?? null
        );
      },
      async setDomain(input: {
        draftId: string;
        ownerId: string;
        hostname: string;
        status: DomainRow["status"];
        verificationToken: string;
        verifiedAt?: string | null;
        lastCheckedAt?: string | null;
      }) {
        rows.set(input.draftId, {
          draft_id: input.draftId,
          owner_id: input.ownerId,
          hostname: input.hostname,
          status: input.status,
          verification_token: input.verificationToken,
          verified_at: input.verifiedAt ?? null,
          last_checked_at: input.lastCheckedAt ?? null,
          created_at: "2026-09-02T00:00:00.000Z",
          updated_at: "2026-09-02T00:00:00.000Z",
        });
      },
      async deleteDomain(draftId: string) {
        rows.delete(draftId);
      },
    }),
  };
});

import { GET, POST } from "./route";

const draftId = "draft-123";
const userId = "user-123";

function post(hostname: unknown) {
  return new NextRequest(
    `http://localhost/api/studio/drafts/${draftId}/domain`,
    {
      method: "POST",
      body: JSON.stringify({ hostname }),
      headers: { "content-type": "application/json" },
    },
  );
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("Custom Domain API", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    rows.clear();
    vi.mocked(auth.requireApiSessionUser).mockResolvedValue({
      id: userId,
      login: "danny",
      name: "Danny",
    });

    const fakeStore = {
      get: vi.fn().mockResolvedValue({ id: draftId, ownerId: userId }),
    } as unknown as import("@/lib/studio/draft-store").StudioDraftStore;
    vi.spyOn(
      await import("@/lib/studio/draft-store"),
      "getStudioDraftStore",
    ).mockReturnValue(fakeStore);

    vi.stubEnv("STUDIO_PLATFORM_HOST", "valmont.test");
    dns.resolveCname.mockRejectedValue(new Error("ENODATA"));
    dns.resolveTxt.mockRejectedValue(new Error("ENODATA"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues a verification token and both DNS records for a new hostname", async () => {
    const res = await POST(post("Shop.Example.com"), params());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.hostname).toBe("shop.example.com");
    expect(data.status).toBe("pending");
    expect(data.records.txt.name).toBe("_valmont-verify.shop.example.com");
    expect(data.records.txt.value).toMatch(/^valmont-verify=[0-9a-f]{32}$/);
    expect(data.records.cname).toEqual({
      name: "shop.example.com",
      target: "valmont.test",
    });
    // The TXT lookup used the draft's own record name.
    expect(dns.resolveTxt).toHaveBeenCalledWith(
      "_valmont-verify.shop.example.com",
    );
  });

  it("activates only when the TXT proof and the CNAME both resolve", async () => {
    const first = await POST(post("shop.example.com"), params());
    const token = (await first.json()).records.txt.value as string;

    dns.resolveTxt.mockResolvedValue([[token]]);
    dns.resolveCname.mockResolvedValue(["valmont.test"]);
    const res = await POST(post("shop.example.com"), params());
    const data = await res.json();

    expect(data.status).toBe("active");
    expect(data.verifiedAt).toEqual(expect.any(String));
    // Re-checking the same hostname keeps the token the owner already
    // published rather than invalidating their TXT record.
    expect(data.records.txt.value).toBe(token);
  });

  it("does not activate a matching CNAME without the ownership proof", async () => {
    dns.resolveCname.mockResolvedValue(["valmont.test"]);

    const res = await POST(post("abandoned.example.com"), params());
    const data = await res.json();

    expect(data.status).toBe("error");
    expect(data.verifiedAt).toBeNull();
    expect(data.detail).toMatch(/ownership TXT record was not found/i);
  });

  it("never treats a matching IP address as a connection", async () => {
    // CNAME lookup fails (an A record only); the old code fell back to
    // comparing resolved addresses. dns.lookup is not even part of the mock.
    dns.resolveCname.mockRejectedValue(new Error("ENODATA"));

    const res = await POST(post("shared-host.example.com"), params());
    const data = await res.json();

    expect(data.status).toBe("pending");
  });

  it("mints a fresh token when the hostname changes", async () => {
    const first = await POST(post("one.example.com"), params());
    const firstToken = (await first.json()).records.txt.value;
    const second = await POST(post("two.example.com"), params());
    const secondToken = (await second.json()).records.txt.value;

    expect(secondToken).not.toBe(firstToken);
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "intranet",
    "https://example.com",
    "example.com/path",
    "bad_host.example.com",
  ])("rejects %s as a hostname with 400", async (hostname) => {
    const res = await POST(post(hostname), params());
    expect(res.status).toBe(400);
    expect(rows.size).toBe(0);
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it("refuses a hostname already attached to another website with 409", async () => {
    rows.set("other-draft", {
      draft_id: "other-draft",
      owner_id: "someone-else",
      hostname: "taken.example.com",
      status: "active",
      verification_token: "x",
      verified_at: null,
      last_checked_at: null,
      created_at: "",
      updated_at: "",
    });

    const res = await POST(post("taken.example.com"), params());

    expect(res.status).toBe(409);
    expect(rows.get(draftId)).toBeUndefined();
  });

  it("stays pending when the platform host is not configured, even with a CNAME", async () => {
    vi.stubEnv("STUDIO_PLATFORM_HOST", "");
    dns.resolveCname.mockResolvedValue(["anything.example"]);

    const res = await POST(post("shop.example.com"), params());
    const data = await res.json();

    expect(data.status).toBe("pending");
    expect(data.records.cname.target).toBeNull();
  });

  it("returns the saved records on GET", async () => {
    await POST(post("shop.example.com"), params());

    const res = await GET(
      new NextRequest(`http://localhost/api/studio/drafts/${draftId}/domain`),
      params(),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.hostname).toBe("shop.example.com");
    expect(data.records.txt.name).toBe("_valmont-verify.shop.example.com");
  });
});
