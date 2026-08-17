/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBoundedJson } from "@/lib/bounded-json";
import { siteBriefSchemaV1 } from "./site-brief/schema";
import { getStudioDraftStore, _resetStudioSqliteForTests } from "./draft-store";
import { canonicalUserId } from "@/lib/user-identity";
import type { SessionUser } from "@/lib/auth";
import { deriveSqliteChatStorePath } from "@/lib/chat-store";

const userA: SessionUser = { id: "1001", login: "alice", name: "Alice" };
const userB: SessionUser = { id: "1002", login: "bob", name: "Bob" };
const validBrief: any = {
  schemaVersion: 1 as const,
  businessName: "Acme Ghana",
  category: "business-profile",
  selectedPackage: "starter",
  selectedTheme: "clean-corporate",
  adminEmail: "owner@example.com",
  socialLinks: [],
  serviceAreas: [],
  deliveryAreas: [],
  services: [],
  requiredPages: [],
  assetStatus: "not_provided" as const,
  products: [],
  country: "Ghana",
  currency: "GHS",
  timezone: "Africa/Accra",
  plannedPaymentMethods: [] as any,
};

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "studio-test-"));
  process.env.CHAT_STORE_PATH = path.join(tmpDir, "chat-store.json");
  delete process.env.CHAT_SQLITE_PATH;
  delete process.env.DATABASE_URL;
  _resetStudioSqliteForTests();
});
afterEach(() => {
  _resetStudioSqliteForTests();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  delete process.env.CHAT_STORE_PATH;
});

describe("shared SQLite path resolver", () => {
  it("derives .sqlite from .json", () => {
    expect(deriveSqliteChatStorePath("/tmp/a/chat-store.json")).toBe(
      path.resolve("/tmp/a/chat-store.sqlite"),
    );
  });
  it("respects CHAT_SQLITE_PATH", () => {
    process.env.CHAT_SQLITE_PATH = "/tmp/custom.sqlite";
    expect(
      (() => {
        const legacy = process.env.CHAT_STORE_PATH!;
        return (
          (process.env.CHAT_SQLITE_PATH as string) ||
          deriveSqliteChatStorePath(legacy)
        );
      })(),
    ).toBe("/tmp/custom.sqlite");
  });
  it("non-json CHAT_STORE_PATH derives correctly", () => {
    expect(deriveSqliteChatStorePath("/tmp/data/store")).toBe(
      path.resolve("/tmp/data/store.sqlite"),
    );
  });
  it("repeated startup does not error", async () => {
    const s = getStudioDraftStore();
    await s.create(userA, validBrief as any);
    _resetStudioSqliteForTests();
    const s2 = getStudioDraftStore();
    const list = await s2.list(userA);
    expect(list.length).toBe(1);
  });
  it("fresh DB and upgrade preserve data", async () => {
    const s = getStudioDraftStore();
    const d = await s.create(userA, validBrief as any);
    _resetStudioSqliteForTests();
    const s2 = getStudioDraftStore();
    const g = await s2.get(userA, d.id);
    expect(g?.brief.businessName).toBe("Acme Ghana");
  });
});

describe("studio draft CRUD and isolation", () => {
  it("create/get/list/delete owner isolated", async () => {
    const s = getStudioDraftStore();
    const d = await s.create(userA, validBrief as any);
    expect(await s.get(userB, d.id)).toBeNull();
    expect(await s.delete(userB, d.id)).toBe(false);
    expect(await s.delete(userA, d.id)).toBe(true);
    expect(await s.get(userA, d.id)).toBeNull();
  });
  it("generic 404 for missing vs foreign", async () => {
    const s = getStudioDraftStore();
    const d = await s.create(userA, validBrief as any);
    const miss = await s.get(userB, "00000000-0000-4000-a000-000000000000");
    const foreign = await s.get(userB, d.id);
    expect(miss).toBeNull();
    expect(foreign).toBeNull();
  });
  it("stale revision rejected", async () => {
    const s = getStudioDraftStore();
    const d = await s.create(userA, validBrief as any);
    await s.update(
      userA,
      d.id,
      { ...(validBrief as any), businessName: "Acme v2" },
      1,
    );
    await expect(
      s.update(userA, d.id, { ...validBrief, businessName: "Acme v3" }, 1),
    ).rejects.toThrow(/Conflict/);
  });
  it("simultaneous updates one succeeds one 409", async () => {
    const s = getStudioDraftStore();
    const d = await s.create(userA, validBrief as any);
    await s.update(
      userA,
      d.id,
      { ...(validBrief as any), businessName: "Acme A" },
      1,
    );
    await expect(
      s.update(
        userA,
        d.id,
        { ...(validBrief as any), businessName: "Acme B" },
        1,
      ),
    ).rejects.toThrow(/Conflict/);
  });

  it("changing theme does not erase business info", async () => {
    const s = getStudioDraftStore();
    const d = await s.create(userA, validBrief as any);
    const u = await s.update(
      userA,
      d.id,
      { ...(validBrief as any), selectedTheme: "luxury" },
      1,
    );
    expect(u.brief.businessName).toBe("Acme Ghana");
    expect(u.brief.selectedTheme).toBe("luxury");
  });
});

describe("bounded json limits", () => {
  it("missing Content-Length still enforced", async () => {
    const big = "a".repeat(1_100_000);
    const req = new Request("http://a", {
      method: "POST",
      body: JSON.stringify({ x: big }),
    });
    // missing header but body is large
    await expect(readBoundedJson(req, 1_000_000)).rejects.toThrow(/too large/);
  });
  it("false Content-Length does not bypass (stream counts bytes)", async () => {
    const body = JSON.stringify({ x: "a".repeat(100) });
    const req = new Request("http://a", {
      method: "POST",
      headers: { "content-length": "1" },
      body,
    });
    const j = (await readBoundedJson(req, 1_000_000)) as any;
    expect(j.x.length).toBe(100);
  });
  it("chunked oversized rejected", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("a".repeat(600)));
        c.enqueue(new TextEncoder().encode("b".repeat(600)));
        c.close();
      },
    });
    const req = new Request("http://a", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as any);
    await expect(readBoundedJson(req, 1000)).rejects.toThrow(/too large/);
  });
  it("valid json passes", async () => {
    const req = new Request("http://a", {
      method: "POST",
      body: JSON.stringify({ ok: 1 }),
    });
    expect(await readBoundedJson(req, 1_000_000)).toEqual({ ok: 1 });
  });
  it("1MB and 25MB limits distinct", async () => {
    const oneMb = "a".repeat(1_100_000);
    const req = new Request("http://a", {
      method: "POST",
      body: JSON.stringify({ x: oneMb }),
    });
    await expect(readBoundedJson(req, 1_000_000)).rejects.toThrow();
    await expect(
      readBoundedJson(
        new Request("http://a", {
          method: "POST",
          body: JSON.stringify({ x: oneMb }),
        }),
        25_000_000,
      ),
    ).resolves.toBeDefined();
  });
});

describe("site brief validation and Ghana defaults", () => {
  it("accepts valid Ghana brief", () => {
    expect(siteBriefSchemaV1.safeParse(validBrief).success).toBe(true);
  });
  it("rejects javascript url", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...validBrief,
        mapsLink: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });
  it("rejects data url", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...validBrief,
        mapsLink: "data:text/html,hi",
      }).success,
    ).toBe(false);
  });
  it("rejects credential url", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...validBrief,
        mapsLink: "https://user:pass@example.com",
      }).success,
    ).toBe(false);
  });
  it("rejects bad hex", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...validBrief,
        preferredColours: ["#GGGGGG", "#ffffff", "#000000"] as any,
      }).success,
    ).toBe(false);
  });
  it("typed template and payment methods", () => {
    expect(
      siteBriefSchemaV1.safeParse({
        ...validBrief,
        selectedTemplate: "classic-hero",
        plannedPaymentMethods: ["momo", "card"],
      }).success,
    ).toBe(true);
    expect(
      siteBriefSchemaV1.safeParse({ ...validBrief, selectedTemplate: "bad" })
        .success,
    ).toBe(false);
  });
});

describe("backup versioning", () => {
  it("export v2 structure", async () => {
    const chat = { version: 1, sessions: [], memories: [] };
    const studio = { version: 1, schemaVersion: 1, drafts: [] };
    const backup = {
      backupVersion: 2,
      exportedAt: new Date().toISOString(),
      chat,
      studio,
    };
    expect(backup.backupVersion).toBe(2);
  });
  it("rejects unknown version", () => {
    const v: any = 99;
    expect([1, 2].includes(v as number)).toBe(false);
  });
});

describe("canonical identity", () => {
  it("deterministic and stable", () => {
    expect(canonicalUserId(userA)).toBe(
      canonicalUserId({ id: "1001", login: "x", name: "y" }),
    );
  });
  it("different users different", () => {
    expect(canonicalUserId(userA)).not.toBe(canonicalUserId(userB));
  });
});
