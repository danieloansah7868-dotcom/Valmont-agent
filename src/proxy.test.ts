import { describe, it, expect, vi, beforeEach } from "vitest";
import { proxy } from "./proxy";
import { NextRequest } from "next/server";

vi.mock("@/lib/studio/domains", () => {
  const getDomainByHostname = vi.fn();
  const updateStatus = vi.fn();
  return {
    getDomainStore: () => ({
      getDomainByHostname,
      updateStatus,
    }),
    __mocks: { getDomainByHostname, updateStatus },
  };
});

const verification = vi.hoisted(() => ({
  checkDomain: vi.fn(),
  needsRecheck: vi.fn(),
}));
vi.mock("@/lib/studio/domain-verification", () => verification);

import * as domainsModule from "@/lib/studio/domains";

const { __mocks } = domainsModule as unknown as {
  __mocks: Record<string, import("vitest").Mock>;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Proxy Middleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STUDIO_PLATFORM_HOST = "valmont.test";
    verification.needsRecheck.mockReturnValue(false);
    __mocks.updateStatus.mockResolvedValue(undefined);
  });

  it("re-verifies a stale active domain in the background without delaying the request", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "active",
      hostname: "shop.com",
      verification_token: "tok",
      last_checked_at: "2026-01-01T00:00:00.000Z",
    });
    verification.needsRecheck.mockReturnValue(true);
    verification.checkDomain.mockResolvedValue({
      status: "error",
      ownershipProven: false,
      cnameCorrect: true,
      detail: "proof missing",
    });

    const req = new NextRequest("http://shop.com/");
    req.headers.set("host", "shop.com");
    const res = await proxy(req);

    // The current request is still served from the previously-verified state.
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "http://shop.com/s/my-draft-123",
    );
    await flush();
    expect(verification.checkDomain).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "shop.com", token: "tok" }),
    );
    // The lost ownership proof is recorded so the NEXT request is refused.
    expect(__mocks.updateStatus).toHaveBeenCalledWith(
      "my-draft-123",
      "error",
      expect.objectContaining({ verifiedAt: null }),
    );
  });

  it("does not re-verify a recently checked domain", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "active",
      hostname: "shop.com",
      verification_token: "tok",
      last_checked_at: new Date().toISOString(),
    });

    const req = new NextRequest("http://shop.com/");
    req.headers.set("host", "shop.com");
    await proxy(req);
    await flush();

    expect(verification.checkDomain).not.toHaveBeenCalled();
  });

  it("rewrites to /s/[draftId] for connected domain", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "active",
      hostname: "shop.com",
    });

    const req = new NextRequest("http://shop.com/");
    req.headers.set("host", "shop.com");

    const res = await proxy(req);
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "http://shop.com/s/my-draft-123",
    );
  });

  it("does not rewrite if domain is not active", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "pending",
      hostname: "shop.com",
    });

    const req = new NextRequest("http://shop.com/");
    req.headers.set("host", "shop.com");

    const res = await proxy(req);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("does not rewrite protected paths", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "active",
      hostname: "shop.com",
    });

    const req = new NextRequest("http://shop.com/api/test");
    req.headers.set("host", "shop.com");

    const res = await proxy(req);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("does not rewrite platform host", async () => {
    const req = new NextRequest("http://valmont.test/");
    req.headers.set("host", "valmont.test");

    const res = await proxy(req);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
