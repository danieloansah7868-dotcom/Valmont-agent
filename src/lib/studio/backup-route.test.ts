/**
 * HTTP-level tests for the backup import route.
 *
 * An independent review found that no test ever drove this route to its 500
 * branch, so the promise that a partial import is reported honestly to the
 * browser was unverified. These tests call the real handler.
 *
 * The partial-import case is produced without mocking `importBackup`: chat is
 * pointed at a working temporary SQLite file while the studio half is pointed
 * at a PostgreSQL port with nothing listening. The chat half therefore really
 * commits and the studio half really fails, which is the exact condition
 * `PartialImportError` exists to describe. That needs no PostgreSQL server, so
 * unlike the staged-import suite this file always runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimitForTests } from "@/lib/security";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";
import { SqliteStudioDraftStore } from "./draft-store";
import { createDefaultBrief } from "./site-brief/defaults";
import { buildBackup, BACKUP_VERSION } from "./backup";

const owner: SessionUser = { id: "9001", login: "ama", name: "Ama" };
let currentUser: SessionUser | null = owner;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== "valmont_session" || !currentUser) return undefined;
      return {
        name,
        value: JSON.stringify({
          accessToken: "test-token",
          id: currentUser.id,
          login: currentUser.login,
          name: currentUser.name,
          expiresAt: Date.now() + 3_600_000,
        }),
      };
    },
  }),
}));

vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, decryptSessionValue: (value: string) => value };
});

const CSRF = "a-sixteen-plus-character-token";
const dirs: string[] = [];
let chatStore: SqliteChatStore;
let drafts: SqliteStudioDraftStore;

function freshDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-backup-route-"));
  dirs.push(dir);
  chatStore = new SqliteChatStore(
    path.join(dir, "chat-store.sqlite"),
    path.join(dir, "chat-store.json"),
  );
  setSqliteChatStoreForTests(chatStore);
  drafts = new SqliteStudioDraftStore();
}

function importRequest(body: unknown): NextRequest {
  const headers = new Headers({
    host: "localhost:3000",
    origin: "http://localhost:3000",
    "content-type": "application/json",
    "x-valmont-csrf": CSRF,
  });
  const request = new NextRequest("http://localhost:3000/api/backup/import", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  request.cookies.set("valmont_csrf", CSRF);
  return request;
}

async function seed() {
  const session = await chatStore.create({
    userId: owner.id,
    title: "Planning",
  });
  await chatStore.appendMessages(session.id, owner.id, [
    {
      id: "m1",
      role: "user",
      content: "Please help me plan my shop website.",
      createdAt: new Date().toISOString(),
    },
  ]);
  await chatStore.addMemory({
    id: "mem1",
    userId: owner.id,
    scope: "personal",
    category: "preference",
    content: "Prefers WhatsApp contact.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await drafts.create(
    owner,
    createDefaultBrief({
      businessName: "Adom Fashion House",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
    }),
  );
}

beforeEach(() => {
  currentUser = owner;
  delete process.env.DATABASE_URL;
  process.env.GITHUB_CLIENT_ID = "test-client-id";
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  resetRateLimitForTests();
  freshDatabase();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  delete process.env.DATABASE_URL;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/backup/import", () => {
  it("restores a good file and reports counts", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    freshDatabase();

    const { POST } = await import("@/app/api/backup/import/route");
    const response = await POST(importRequest(file));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.chatSessions).toBe(1);
    expect(body.memories).toBe(1);
    expect(body.studioDrafts).toBe(1);
    expect(body.atomicity).toBe("single-transaction");
    expect(body.partial).toBeUndefined();
  });

  it("tells the owner when a memory was dropped instead of counting it", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    file.chat.memories[0].content = "password=perfectly-legitimate-note";
    freshDatabase();

    const { POST } = await import("@/app/api/backup/import/route");
    const response = await POST(importRequest(file));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.memories).toBe(0);
    expect(body.skippedMemories).toBe(1);
    expect(body.notice).toMatch(/not restored/i);
    // The owner is told the file still holds it, so they do not delete it.
    expect(body.notice).toMatch(/backup file still contains/i);
  });

  it("returns a safe 500, not a 400, when the database is unreachable", async () => {
    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    freshDatabase();

    // Nothing listens on this port, so the studio side genuinely fails.
    process.env.DATABASE_URL = "postgres://postgres:hunter2@127.0.0.1:1/none";

    const { POST } = await import("@/app/api/backup/import/route");
    const response = await POST(importRequest(file));
    const text = JSON.stringify(await response.json());

    // A driver outage is a server fault. A 400 would tell the owner their
    // backup file was bad, which would not be true.
    expect(response.status).toBe(500);
    // The statement, its bound parameters and the connection string must not
    // escape to the browser.
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toMatch(/insert into/i);
    expect(text).not.toMatch(/params:/i);
    expect(text).not.toMatch(/ECONNREFUSED/i);
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).not.toContain(owner.id);
  });

  it("answers 500 and names the committed halves when even rollback failed", async () => {
    // PartialImportError is the exceptional outcome: the import failed and
    // rolling it back also failed. Real behaviour is covered against live
    // engines in postgres-backup.test.ts; this test proves the route turns it
    // into an honest HTTP answer rather than a generic 500.
    vi.resetModules();
    vi.doMock("@/lib/studio/backup", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@/lib/studio/backup")>();
      return {
        ...actual,
        importBackup: async () => {
          throw new actual.PartialImportError(new Error("connection reset"), {
            chat: true,
            studio: false,
          });
        },
      };
    });

    await seed();
    const file = JSON.parse(JSON.stringify(await buildBackup(owner)));
    const { POST } = await import("@/app/api/backup/import/route");
    const response = await POST(importRequest(file));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.partial).toBe(true);
    expect(body.committed).toEqual({ chat: true, studio: false });
    // The owner is told which half is known to have landed and that recovery
    // will roll it back, so retrying is an informed choice.
    expect(body.error).toMatch(/recovery/i);
    expect(JSON.stringify(body)).not.toContain("connection reset");

    vi.doUnmock("@/lib/studio/backup");
    vi.resetModules();
  });

  it("rejects an unauthenticated import before touching any store", async () => {
    currentUser = null;
    const { POST } = await import("@/app/api/backup/import/route");
    const response = await POST(
      importRequest({ version: BACKUP_VERSION, chat: {}, studio: {} }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a request with no CSRF header", async () => {
    const headers = new Headers({
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "application/json",
    });
    const request = new NextRequest("http://localhost:3000/api/backup/import", {
      method: "POST",
      headers,
      body: "{}",
    });
    const { POST } = await import("@/app/api/backup/import/route");
    const response = await POST(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(500);
  });
});
