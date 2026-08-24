import { describe, it, expect, vi, beforeEach } from "vitest";
import { proxy } from "./proxy";
import { NextRequest } from "next/server";

vi.mock("@/lib/studio/domains", () => {
  const getDomainByHostname = vi.fn();
  return {
    getDomainStore: () => ({
      getDomainByHostname
    }),
    __mocks: { getDomainByHostname }
  };
});

import { __mocks } from "@/lib/studio/domains";

describe("Proxy Middleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STUDIO_PLATFORM_HOST = "valmont.test";
  });

  it("rewrites to /s/[draftId] for connected domain", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "active",
      hostname: "shop.com"
    });

    const req = new NextRequest("http://shop.com/");
    req.headers.set("host", "shop.com");
    
    const res = await proxy(req);
    expect(res.headers.get("x-middleware-rewrite")).toBe("http://shop.com/s/my-draft-123");
  });

  it("does not rewrite if domain is not active", async () => {
    __mocks.getDomainByHostname.mockResolvedValue({
      draft_id: "my-draft-123",
      status: "pending",
      hostname: "shop.com"
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
      hostname: "shop.com"
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
