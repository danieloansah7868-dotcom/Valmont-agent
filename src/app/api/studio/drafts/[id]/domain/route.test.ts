import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as apiLib from "@/lib/api";
import dns from "node:dns/promises";
import { getStudioDraftStore } from "@/lib/studio/draft-store";

vi.mock("@/lib/auth");
vi.mock("@/lib/security", () => ({ assertCsrf: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, assertOwnerRateLimit: vi.fn() };
});

vi.mock("node:dns/promises");

vi.mock("@/lib/studio/domains", () => {
  const getDomainByHostname = vi.fn();
  const setDomain = vi.fn();
  return {
    getDomainStore: () => ({
      getDomainByHostname,
      setDomain
    }),
    __mocks: { getDomainByHostname, setDomain }
  };
});
import { __mocks } from "@/lib/studio/domains";

describe("Custom Domain API", () => {
  const draftId = "draft-123";
  const userId = "user-123";
  
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(auth.requireApiSessionUser).mockResolvedValue({ id: userId } as any);
    
    // Spy on getStudioDraftStore
    const fakeStore = {
      get: vi.fn().mockResolvedValue({ id: "draft-123", ownerId: "user-123" })
    } as any;
    vi.spyOn(await import("@/lib/studio/draft-store"), "getStudioDraftStore").mockReturnValue(fakeStore);
    
    __mocks.getDomainByHostname.mockResolvedValue(null);
    __mocks.setDomain.mockResolvedValue(undefined);

    process.env.STUDIO_PLATFORM_HOST = "valmont.test";
  });

  it("checks DNS and sets status active if CNAME matches", async () => {
    vi.mocked(dns.resolveCname).mockResolvedValue(["valmont.test"]);
    
    const req = new NextRequest("http://localhost/api/studio/drafts/draft-123/domain", { 
      method: "POST", 
      body: JSON.stringify({ hostname: "test.com" }),
      headers: { "content-type": "application/json" }
    });
    const res = await POST(req, { params: Promise.resolve({ id: draftId }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("active");
  });

  it("falls back to lookup and sets status active if IP matches", async () => {
    vi.mocked(dns.resolveCname).mockRejectedValue(new Error("ENODATA"));
    vi.mocked(dns.lookup).mockImplementation((hostname: string) => {
      if (hostname === "test.com" || hostname === "valmont.test") return Promise.resolve({ address: "1.2.3.4", family: 4 }) as any;
      return Promise.resolve({ address: "0.0.0.0", family: 4 }) as any;
    });

    const req = new NextRequest("http://localhost/api/studio/drafts/draft-123/domain", { 
      method: "POST",
      body: JSON.stringify({ hostname: "test.com" }),
      headers: { "content-type": "application/json" }
    });
    const res = await POST(req, { params: Promise.resolve({ id: draftId }) });
    const data = await res.json();

    expect(data.status).toBe("active");
  });

  it("sets status error if DNS doesn't match", async () => {
    vi.mocked(dns.resolveCname).mockResolvedValue(["other.test"]);
    vi.mocked(dns.lookup).mockImplementation((hostname: string) => {
      if (hostname === "test.com") return Promise.resolve({ address: "1.1.1.1", family: 4 }) as any;
      if (hostname === "valmont.test") return Promise.resolve({ address: "2.2.2.2", family: 4 }) as any;
      return Promise.resolve({ address: "0.0.0.0", family: 4 }) as any;
    });

    const req = new NextRequest("http://localhost/api/studio/drafts/draft-123/domain", { 
      method: "POST",
      body: JSON.stringify({ hostname: "test.com" }),
      headers: { "content-type": "application/json" }
    });
    const res = await POST(req, { params: Promise.resolve({ id: draftId }) });
    const data = await res.json();

    expect(data.status).toBe("error");
  });
});
