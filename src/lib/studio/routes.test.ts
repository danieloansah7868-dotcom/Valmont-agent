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

/**
 * Route-level tests for the security controls that guard the Studio API:
 * authentication, CSRF, same-origin, body limits, validation, owner isolation
 * and the generic 404. These exercise the real route handlers, not a mock of
 * them, so a control that is removed from a route makes a test fail.
 *
 * Only the session cookie is faked, exactly as a signed-in browser supplies it.
 * No production code path is weakened.
 */

const userA: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "9002", login: "kofi", name: "Kofi" };

/** Whoever the fake cookie jar currently reports as signed in. */
let currentUser: SessionUser | null = userA;

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

// `getGitHubSession` decrypts the cookie; here the cookie is already plain JSON.
vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, decryptSessionValue: (value: string) => value };
});

const CSRF = "a-sixteen-plus-character-token";
const ORIGIN = "http://localhost:3000";

function url(pathname: string): string {
  return `${ORIGIN}${pathname}`;
}

/** A request that passes every guard, so each test can remove exactly one. */
function goodRequest(
  pathname: string,
  init: {
    method?: string;
    body?: string;
    csrfHeader?: string | null;
    csrfCookie?: string | null;
    origin?: string | null;
  } = {},
): NextRequest {
  const headers = new Headers({ host: "localhost:3000" });
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.set("origin", origin);
  const csrfHeader = init.csrfHeader === undefined ? CSRF : init.csrfHeader;
  if (csrfHeader) headers.set("x-valmont-csrf", csrfHeader);

  const request = new NextRequest(url(pathname), {
    method: init.method ?? "POST",
    headers,
    body: init.body,
  });

  const csrfCookie = init.csrfCookie === undefined ? CSRF : init.csrfCookie;
  if (csrfCookie) request.cookies.set("valmont_csrf", csrfCookie);
  return request;
}

function newBriefBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...createDefaultBrief({
      businessName: "Adom Fashion House",
      adminEmail: "owner@adom.example",
    }),
    ...overrides,
  });
}

const dirs: string[] = [];
let store: SqliteStudioDraftStore;

beforeEach(() => {
  // Temporary files only. No real .data file is ever opened by these tests.
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-routes-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  store = new SqliteStudioDraftStore();
  currentUser = userA;
  delete process.env.DATABASE_URL;
  process.env.GITHUB_CLIENT_ID = "test-client-id";
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  resetRateLimitForTests();
});

afterEach(() => {
  setSqliteChatStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function listRoute() {
  return import("@/app/api/studio/drafts/route");
}
async function itemRoute() {
  return import("@/app/api/studio/drafts/[id]/route");
}
function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("studio routes: authentication", () => {
  it("refuses to list drafts when nobody is signed in", async () => {
    currentUser = null;
    const { GET } = await listRoute();
    expect((await GET()).status).toBe(401);
  });

  it("refuses to create a draft when nobody is signed in", async () => {
    currentUser = null;
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", { body: newBriefBody() }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses to read one draft when nobody is signed in", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    currentUser = null;
    const { GET } = await itemRoute();
    const response = await GET(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "GET" }),
      idParams(draft.id),
    );
    expect(response.status).toBe(401);
  });
});

describe("studio routes: CSRF and origin", () => {
  it("rejects a mutation with no CSRF header", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", {
        body: newBriefBody(),
        csrfHeader: null,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a mutation whose CSRF header does not match the cookie", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", {
        body: newBriefBody(),
        csrfHeader: "a-different-sixteen-plus-token",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a mutation sent from another site", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", {
        body: newBriefBody(),
        origin: "https://evil.example",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a delete with no CSRF token", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    const { DELETE } = await itemRoute();
    const response = await DELETE(
      goodRequest(`/api/studio/drafts/${draft.id}`, {
        method: "DELETE",
        csrfHeader: null,
      }),
      idParams(draft.id),
    );
    expect(response.status).toBe(403);
    // The draft is still there: a blocked request changed nothing.
    expect(await store.get(userA, draft.id)).not.toBeNull();
  });
});

describe("studio routes: body limits and validation", () => {
  it("rejects a draft body over 1 MB with 413", async () => {
    const { POST } = await listRoute();
    const huge = newBriefBody({ description: "x".repeat(1_100_000) });
    const response = await POST(
      goodRequest("/api/studio/drafts", { body: huge }),
    );
    expect(response.status).toBe(413);
  });

  it("rejects an invalid brief with 400 and no echoed value", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", {
        body: newBriefBody({ existingWebsite: "javascript:alert(1)" }),
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("javascript:alert(1)");
  });

  it("does not repeat private business details back in an error", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", {
        body: newBriefBody({
          adminEmail: "not-an-email",
          address: "House 12, Secret Lane, Osu",
        }),
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("Secret Lane");
    expect(text).not.toContain("not-an-email");
  });

  it("rejects a body that is not JSON at all", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", { body: "this is not json" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("studio routes: owner isolation and the generic 404", () => {
  it("gives owner B the identical 404 for owner A's draft and a random id", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    currentUser = userB;
    const { GET } = await itemRoute();

    const foreign = await GET(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "GET" }),
      idParams(draft.id),
    );
    const random = await GET(
      goodRequest("/api/studio/drafts/does-not-exist", { method: "GET" }),
      idParams("00000000-0000-4000-a000-000000000000"),
    );

    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect(await foreign.json()).toEqual(await random.json());
  });

  it("does not list another owner's drafts", async () => {
    await store.create(userA, JSON.parse(newBriefBody()));
    currentUser = userB;
    const { GET } = await listRoute();
    const body = (await (await GET()).json()) as { drafts: unknown[] };
    expect(body.drafts).toHaveLength(0);
  });

  it("refuses to update another owner's draft and leaves it unchanged", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    currentUser = userB;
    const { PATCH } = await itemRoute();
    const response = await PATCH(
      goodRequest(`/api/studio/drafts/${draft.id}`, {
        method: "PATCH",
        body: newBriefBody({
          businessName: "Stolen",
          expectedRevision: draft.revision,
        }),
      }),
      idParams(draft.id),
    );
    expect(response.status).toBe(404);

    currentUser = userA;
    const still = await store.get(userA, draft.id);
    expect(still?.brief.businessName).toBe("Adom Fashion House");
  });

  it("refuses to delete another owner's draft", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    currentUser = userB;
    const { DELETE } = await itemRoute();
    const response = await DELETE(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "DELETE" }),
      idParams(draft.id),
    );
    expect(response.status).toBe(404);
    expect(await store.get(userA, draft.id)).not.toBeNull();
  });
});

describe("studio routes: create, read, update, delete", () => {
  it("creates a draft and returns 201 with revision 1", async () => {
    const { POST } = await listRoute();
    const response = await POST(
      goodRequest("/api/studio/drafts", { body: newBriefBody() }),
    );
    expect(response.status).toBe(201);
    const draft = (await response.json()) as {
      id: string;
      revision: number;
      ownerId: string;
    };
    expect(draft.revision).toBe(1);
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads back the draft it just created", async () => {
    const { POST } = await listRoute();
    const created = (await (
      await POST(goodRequest("/api/studio/drafts", { body: newBriefBody() }))
    ).json()) as { id: string };

    const { GET } = await itemRoute();
    const response = await GET(
      goodRequest(`/api/studio/drafts/${created.id}`, { method: "GET" }),
      idParams(created.id),
    );
    expect(response.status).toBe(200);
    const draft = (await response.json()) as {
      brief: { businessName: string };
    };
    expect(draft.brief.businessName).toBe("Adom Fashion House");
  });

  it("updates a draft carrying the current revision", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    const { PATCH } = await itemRoute();
    const response = await PATCH(
      goodRequest(`/api/studio/drafts/${draft.id}`, {
        method: "PATCH",
        body: newBriefBody({
          businessName: "Adom Fashion House Ltd",
          expectedRevision: draft.revision,
        }),
      }),
      idParams(draft.id),
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as {
      revision: number;
      brief: { businessName: string };
    };
    expect(updated.revision).toBe(2);
    expect(updated.brief.businessName).toBe("Adom Fashion House Ltd");
  });

  it("answers 409 for a stale revision without changing anything", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    await store.update(
      userA,
      draft.id,
      { ...draft.brief, businessName: "First writer" },
      draft.revision,
    );

    const { PATCH } = await itemRoute();
    const response = await PATCH(
      goodRequest(`/api/studio/drafts/${draft.id}`, {
        method: "PATCH",
        body: newBriefBody({
          businessName: "Second writer",
          expectedRevision: draft.revision,
        }),
      }),
      idParams(draft.id),
    );
    expect(response.status).toBe(409);
    const after = await store.get(userA, draft.id);
    expect(after?.brief.businessName).toBe("First writer");
  });

  it("rejects an update with no expectedRevision at all", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    const { PATCH } = await itemRoute();
    const response = await PATCH(
      goodRequest(`/api/studio/drafts/${draft.id}`, {
        method: "PATCH",
        body: newBriefBody({ businessName: "No revision" }),
      }),
      idParams(draft.id),
    );
    expect(response.status).toBe(400);
  });

  it("deletes a draft, then returns the generic 404 for it", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    const { DELETE, GET } = await itemRoute();

    const deleted = await DELETE(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "DELETE" }),
      idParams(draft.id),
    );
    expect(deleted.status).toBe(204);

    const gone = await GET(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "GET" }),
      idParams(draft.id),
    );
    expect(gone.status).toBe(404);
  });

  it("returns 404 when deleting the same draft twice", async () => {
    const draft = await store.create(userA, JSON.parse(newBriefBody()));
    const { DELETE } = await itemRoute();
    await DELETE(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "DELETE" }),
      idParams(draft.id),
    );
    const again = await DELETE(
      goodRequest(`/api/studio/drafts/${draft.id}`, { method: "DELETE" }),
      idParams(draft.id),
    );
    expect(again.status).toBe(404);
  });

  it("does not give a signed-in owner a fresh mutation bucket by rotating X-Forwarded-For", async () => {
    const { POST } = await listRoute();
    let lastStatus = 0;
    for (let index = 0; index < 31; index += 1) {
      const request = goodRequest("/api/studio/drafts", {
        body: newBriefBody({ businessName: `Shop ${index}` }),
      });
      request.headers.set("x-forwarded-for", `203.0.113.${index + 1}`);
      request.headers.set("x-real-ip", `198.51.100.${index + 1}`);
      lastStatus = (await POST(request)).status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("backup routes", () => {
  async function backupExport() {
    return import("@/app/api/backup/export/route");
  }
  async function backupImport() {
    return import("@/app/api/backup/import/route");
  }

  it("refuses to export a backup when nobody is signed in", async () => {
    currentUser = null;
    const { GET } = await backupExport();
    const response = await GET(
      goodRequest("/api/backup/export", { method: "GET" }),
    );
    expect(response.status).toBe(401);
  });

  it("exports a version 2 backup for the signed-in owner", async () => {
    await store.create(userA, JSON.parse(newBriefBody()));
    const { GET } = await backupExport();
    const response = await GET(
      goodRequest("/api/backup/export", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      backupVersion: number;
      studio: { drafts: unknown[] };
    };
    expect(body.backupVersion).toBe(2);
    expect(body.studio.drafts).toHaveLength(1);
  });

  it("refuses an import with no CSRF token", async () => {
    const { POST } = await backupImport();
    const response = await POST(
      goodRequest("/api/backup/import", {
        body: JSON.stringify({ backupVersion: 2 }),
        csrfHeader: null,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unknown backup version with 400", async () => {
    const { POST } = await backupImport();
    const response = await POST(
      goodRequest("/api/backup/import", {
        body: JSON.stringify({ backupVersion: 99, chat: {}, studio: {} }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an import body over 25 MB with 413", async () => {
    const { POST } = await backupImport();
    const huge = JSON.stringify({
      backupVersion: 2,
      padding: "x".repeat(26_000_000),
    });
    const response = await POST(
      goodRequest("/api/backup/import", { body: huge }),
    );
    expect(response.status).toBe(413);
  });
});
