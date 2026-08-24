import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDomainStore } from "./domains";

describe("DomainStore (SQLite)", () => {
  let store: ReturnType<typeof getDomainStore>;

  beforeEach(() => {
    store = getDomainStore();
  });

  afterEach(async () => {
    try {
      await store.deleteDomain("draft-1");
      await store.deleteDomain("draft-2");
    } catch {}
  });

  it("can set and get a domain", async () => {
    await store.setDomain("draft-1", "owner-1", "example.com", "active");
    const domain = await store.getDomain("draft-1");

    expect(domain).toBeDefined();
    expect(domain?.hostname).toBe("example.com");
    expect(domain?.status).toBe("active");
    expect(domain?.owner_id).toBe("owner-1");
  });

  it("can get domains by owner", async () => {
    await store.setDomain("draft-1", "owner-1", "one.com", "active");
    await store.setDomain("draft-2", "owner-1", "two.com", "pending");

    const domains = await store.getDomainsForOwner("owner-1");
    expect(domains.length).toBe(2);
    expect(domains.map((d) => d.hostname).sort()).toEqual([
      "one.com",
      "two.com",
    ]);
  });

  it("can get domain by hostname", async () => {
    await store.setDomain("draft-1", "owner-1", "unique.com", "active");
    const domain = await store.getDomainByHostname("unique.com");
    expect(domain?.draft_id).toBe("draft-1");
  });

  it("updates existing domain instead of failing", async () => {
    await store.setDomain("draft-1", "owner-1", "old.com", "pending");
    await store.setDomain("draft-1", "owner-1", "new.com", "active");

    const domain = await store.getDomain("draft-1");
    expect(domain?.hostname).toBe("new.com");
    expect(domain?.status).toBe("active");
  });
});
