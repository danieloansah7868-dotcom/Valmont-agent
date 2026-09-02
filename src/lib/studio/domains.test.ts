import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import {
  getDomainStore,
  normalizeHostname,
  PostgresDomainStore,
  SqliteDomainStore,
  verificationRecordName,
  verificationRecordValue,
} from "./domains";

const dirs: string[] = [];
let store: SqliteDomainStore;

beforeEach(() => {
  // A throwaway SQLite file per test: the store must never touch the real
  // .data directory from the test suite.
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-domains-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  vi.stubEnv("DATABASE_URL", "");
  store = new SqliteDomainStore();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function domain(
  overrides: Partial<Parameters<SqliteDomainStore["setDomain"]>[0]> = {},
) {
  return {
    draftId: "draft-1",
    ownerId: "owner-1",
    hostname: "example.com",
    status: "pending" as const,
    verificationToken: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("DomainStore (SQLite)", () => {
  it("can set and get a domain with its verification token", async () => {
    await store.setDomain(domain({ status: "active" }));
    const row = await store.getDomain("draft-1");

    expect(row?.hostname).toBe("example.com");
    expect(row?.status).toBe("active");
    expect(row?.owner_id).toBe("owner-1");
    expect(row?.verification_token).toBe("0123456789abcdef0123456789abcdef");
    expect(row?.verified_at).toBeNull();
  });

  it("can get domains by owner", async () => {
    await store.setDomain(domain({ hostname: "one.com" }));
    await store.setDomain(domain({ draftId: "draft-2", hostname: "two.com" }));

    const domains = await store.getDomainsForOwner("owner-1");
    expect(domains.map((d) => d.hostname).sort()).toEqual([
      "one.com",
      "two.com",
    ]);
  });

  it("can get domain by hostname", async () => {
    await store.setDomain(domain({ hostname: "unique.com" }));
    expect((await store.getDomainByHostname("unique.com"))?.draft_id).toBe(
      "draft-1",
    );
  });

  it("updates an existing domain instead of failing", async () => {
    await store.setDomain(domain({ hostname: "old.com" }));
    await store.setDomain(
      domain({
        hostname: "new.com",
        status: "active",
        verificationToken: "ffffffffffffffffffffffffffffffff",
        verifiedAt: "2026-09-01T00:00:00.000Z",
      }),
    );

    const row = await store.getDomain("draft-1");
    expect(row?.hostname).toBe("new.com");
    expect(row?.status).toBe("active");
    expect(row?.verification_token).toBe("ffffffffffffffffffffffffffffffff");
    expect(row?.verified_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("records re-check results without losing the verification timestamp", async () => {
    await store.setDomain(
      domain({ status: "active", verifiedAt: "2026-09-01T00:00:00.000Z" }),
    );
    await store.updateStatus("draft-1", "active", {
      lastCheckedAt: "2026-09-02T00:00:00.000Z",
    });
    let row = await store.getDomain("draft-1");
    expect(row?.verified_at).toBe("2026-09-01T00:00:00.000Z");
    expect(row?.last_checked_at).toBe("2026-09-02T00:00:00.000Z");

    // Ownership proof disappeared: the timestamp is cleared explicitly.
    await store.updateStatus("draft-1", "error", {
      verifiedAt: null,
      lastCheckedAt: "2026-09-03T00:00:00.000Z",
    });
    row = await store.getDomain("draft-1");
    expect(row?.status).toBe("error");
    expect(row?.verified_at).toBeNull();
  });

  it("upgrades a pre-verification table in place", async () => {
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync })
      .db;
    db.exec("DROP TABLE studio_domains");
    db.exec(`CREATE TABLE studio_domains (
      draft_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'not_set',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.prepare(
      "INSERT INTO studio_domains VALUES ('legacy', 'owner-1', 'legacy.com', 'active', 'x', 'x')",
    ).run();

    const upgraded = new SqliteDomainStore();
    const row = await upgraded.getDomain("legacy");
    expect(row?.status).toBe("active");
    // A legacy row has no proof and no check on record, so the proxy's
    // re-verification runs on the first request.
    expect(row?.verification_token).toBeNull();
    expect(row?.last_checked_at).toBeNull();
  });

  it("never writes to the repository's .data directory", () => {
    expect(
      existsSync(path.join(process.cwd(), ".data", "chat-store.sqlite")),
    ).toBe(false);
  });
});

describe("getDomainStore", () => {
  it("uses PostgreSQL when DATABASE_URL is set, like every other Studio store", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://example/valmont");
    expect(getDomainStore()).toBeInstanceOf(PostgresDomainStore);
  });

  it("uses SQLite otherwise", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(getDomainStore()).toBeInstanceOf(SqliteDomainStore);
  });
});

describe("normalizeHostname", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["  shop.example.com.  ", "shop.example.com"],
    ["akwaaba-bites.com.gh", "akwaaba-bites.com.gh"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    "localhost",
    "shop.localhost",
    "intranet.local",
    "db.internal",
    "127.0.0.1",
    "10.0.0.1",
    "example",
    "-bad.com",
    "bad-.com",
    "under_score.com",
    "https://example.com",
    "example.com/path",
    "example.com:8080",
    "user@example.com",
    "exa mple.com",
    "example.c0m",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(130)}com`,
    "",
  ])("rejects %s", (input) => {
    expect(normalizeHostname(input)).toBeNull();
  });
});

describe("verification record helpers", () => {
  it("names the TXT record under the customer's hostname with a fixed prefix", () => {
    expect(verificationRecordName("shop.example.com")).toBe(
      "_valmont-verify.shop.example.com",
    );
    expect(verificationRecordValue("abc123")).toBe("valmont-verify=abc123");
  });
});
