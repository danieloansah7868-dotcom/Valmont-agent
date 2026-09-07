/**
 * Stage B — route-level tests for the five Brand Kit endpoints.
 *
 * They exercise the real route handlers (not a mock of them) against a real
 * SQLite draft store pointed at a throwaway temp directory — no `.data/`
 * file is ever opened. The session cookie is faked exactly as a signed-in
 * browser supplies it, the model provider is a fake that answers canned
 * structured output through the request's own validator (no test ever calls
 * a real model), and next/og is replaced with a deterministic 1×1 PNG so the
 * stored-image path (magic bytes, budgets, sizes) is what is actually under
 * test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimitForTests } from "@/lib/security";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";
import type {
  ModelProvider,
  ModelResponse,
  StructuredRequest,
} from "@/lib/models/types";
import { PACKAGE_NOT_INCLUDED_MESSAGE } from "@/lib/studio/plans";
import { MAX_LOGO_BYTES } from "@/lib/studio/assets";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import type { StudioDraft } from "@/lib/studio/site-brief/schema";
import type { BrandKitOutput } from "@/lib/studio/brand-kit";

const userA: SessionUser = { id: "9101", login: "ama", name: "Ama" };
const userB: SessionUser = { id: "9102", login: "kofi", name: "Kofi" };

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

/* The fake model, swapped per test. Records every structured request. */
const models = vi.hoisted(() => ({
  provider: null as ModelProvider | null,
  requests: [] as StructuredRequest<unknown>[],
}));

vi.mock("@/lib/models", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/models")>();
  return {
    ...original,
    tryCreateModelProvider: () => models.provider,
    createModelProvider: () => {
      if (!models.provider) {
        throw new Error(original.MODEL_NOT_CONFIGURED_MESSAGE);
      }
      return models.provider;
    },
  };
});

/* next/og renders real PNGs in production; a fixed 1×1 PNG is enough here. */
const og = vi.hoisted(() => ({
  lastOptions: undefined as { width?: number; height?: number } | undefined,
  pngBase64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
}));

vi.mock("next/og", () => {
  const png = Buffer.from(og.pngBase64, "base64");
  class ImageResponse {
    constructor(
      _element: unknown,
      options?: { width?: number; height?: number },
    ) {
      og.lastOptions = options;
    }
    async arrayBuffer(): Promise<ArrayBuffer> {
      return png.buffer.slice(
        png.byteOffset,
        png.byteOffset + png.byteLength,
      ) as ArrayBuffer;
    }
  }
  return { ImageResponse };
});

import { POST as suggestPOST } from "./suggest/route";
import { POST as applyPOST } from "./apply/route";
import { POST as logoPOST } from "./logo/route";
import { GET as logoSvgGET } from "./logo.svg/route";
import { GET as sheetGET } from "./sheet/route";

const CSRF = "a-sixteen-plus-character-token";
const ORIGIN = "http://localhost:3000";

function goodRequest(
  pathname: string,
  init: {
    method?: string;
    body?: string;
    csrfHeader?: string | null;
    origin?: string | null;
  } = {},
): NextRequest {
  const headers = new Headers({ host: "localhost:3000" });
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.set("origin", origin);
  const csrfHeader = init.csrfHeader === undefined ? CSRF : init.csrfHeader;
  if (csrfHeader) headers.set("x-valmont-csrf", csrfHeader);
  if (init.body !== undefined) headers.set("content-type", "application/json");

  const request = new NextRequest(`${ORIGIN}${pathname}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body,
  });
  request.cookies.set("valmont_csrf", CSRF);
  return request;
}

const dirs: string[] = [];
let store: SqliteStudioDraftStore;

beforeEach(() => {
  // Temporary files only. No real .data file is ever opened by these tests.
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-brand-kit-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  store = new SqliteStudioDraftStore();
  currentUser = userA;
  models.provider = null;
  models.requests.length = 0;
  og.lastOptions = undefined;
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

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** A canned model answer: five clean names, three readable palettes. */
function cannedOutput(
  names: string[] = [
    "Adom Mart",
    "Adepa Styles",
    "Kof Corner",
    "Nhyira Press",
    "Oseikrom Deals",
  ],
): BrandKitOutput {
  const themeIds = ["modern-bold", "community", "luxury"] as const;
  return {
    names: names.map((name) => ({
      name,
      meaning: `Meaning for ${name}`,
      tagline: `Tagline for ${name}`,
    })),
    palettes: themeIds.map((themeId, index) => ({
      label: `Palette ${index + 1}`,
      primary: "#0A1F44",
      accent: "#E8822B",
      surface: "#F8F6F0",
      text: "#0A1F44",
      themeId,
    })),
  };
}

function fakeModel(outputs: BrandKitOutput[]): ModelProvider {
  return {
    id: "fake",
    model: "fake-1",
    supportsStreaming: false,
    chat: () => {
      throw new Error("not used by the brand kit");
    },
    structured: async <T>(
      request: StructuredRequest<T>,
    ): Promise<ModelResponse & { data: T }> => {
      models.requests.push(request as StructuredRequest<unknown>);
      const output =
        outputs[Math.min(models.requests.length - 1, outputs.length - 1)]!;
      return {
        content: JSON.stringify(output),
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: "fake-1",
        provider: "fake",
        finishReason: "stop",
        data: request.validate(output),
      };
    },
    stream(): AsyncIterable<never> {
      throw new Error("not used by the brand kit");
    },
  };
}

const SUGGEST_BODY = JSON.stringify({
  whatTheySell: "Second-hand clothes and shoes",
  town: "Koforidua",
  feeling: "friendly",
  category: "online-shop",
});

async function createDraft(
  brief: Parameters<typeof createDefaultBrief>[0] = {},
): Promise<StudioDraft> {
  const data = JSON.parse(
    JSON.stringify(
      createDefaultBrief({
        businessName: "Adom Fashion House",
        adminEmail: "owner@adom.example",
        ...brief,
      }),
    ),
  ) as Record<string, unknown>;
  return store.create(userA, data);
}

async function createStarterBundleDraft(addon = false): Promise<StudioDraft> {
  return createDraft({
    businessName: "Adom Data Hub",
    category: "data-bundles",
    plan: "starter",
    brandKitAddon: addon,
  });
}

function suggest(draftId: string, body = SUGGEST_BODY) {
  return suggestPOST(
    goodRequest(`/api/studio/drafts/${draftId}/brand-kit/suggest`, { body }),
    idParams(draftId),
  );
}

describe("brand-kit suggest — answering", () => {
  it("returns names with domains and check links plus the palettes", async () => {
    const draft = await createDraft({ category: "restaurant" });
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.names).toHaveLength(5);
    expect(data.names[0].domainCandidates).toEqual([
      "adommart.com",
      "adommart.com.gh",
    ]);
    expect(data.names[0].checkLinks.instagram).toContain("instagram.com/");
    expect(data.palettes).toHaveLength(3);
    expect(models.requests).toHaveLength(1);
    expect(models.requests[0]!.temperature).toBe(0.8);
    expect(models.requests[0]!.maxTokens).toBe(1200);
  });

  it("rejects an invalid request body with 400", async () => {
    const draft = await createDraft();
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id, JSON.stringify({ feeling: "x" }));

    expect(response.status).toBe(400);
    expect(models.requests).toHaveLength(0);
  });

  it("rejects a mutation without a CSRF token with 403", async () => {
    const draft = await createDraft();
    const response = await suggestPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/suggest`, {
        body: SUGGEST_BODY,
        csrfHeader: null,
      }),
      idParams(draft.id),
    );
    expect(response.status).toBe(403);
  });
});

describe("brand-kit suggest — package gate", () => {
  it("refuses a Starter bundle shop without the add-on: 403, no model spend", async () => {
    const draft = await createStarterBundleDraft();
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: PACKAGE_NOT_INCLUDED_MESSAGE,
    });
    expect(models.requests).toHaveLength(0);
  });

  it("allows a Starter bundle shop once the add-on is ticked", async () => {
    const draft = await createStarterBundleDraft(true);
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id);
    expect(response.status).toBe(200);
  });

  it("allows a Command Center bundle shop with no add-on", async () => {
    const draft = await createDraft({
      category: "data-bundles",
      plan: "command_center",
    });
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id);
    expect(response.status).toBe(200);
  });

  it("allows a non-bundle website regardless of any plan on the brief", async () => {
    const draft = await createDraft({
      category: "restaurant",
      plan: "starter",
    });
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id);
    expect(response.status).toBe(200);
  });

  it("answers 404 for another agency user's draft", async () => {
    const draft = await createDraft();
    currentUser = userB;
    models.provider = fakeModel([cannedOutput()]);

    const response = await suggest(draft.id);
    expect(response.status).toBe(404);
    expect(models.requests).toHaveLength(0);
  });
});

describe("brand-kit suggest — budget and configuration", () => {
  it("allows ten suggests an hour, refuses the eleventh with 429", async () => {
    const draft = await createDraft();
    models.provider = fakeModel([cannedOutput()]);

    for (let i = 0; i < 10; i += 1) {
      expect((await suggest(draft.id)).status).toBe(200);
    }
    expect((await suggest(draft.id)).status).toBe(429);
    // The eleventh burned no model call.
    expect(models.requests).toHaveLength(10);
  });

  it("answers 503 when no model is configured on the server", async () => {
    const draft = await createDraft();
    models.provider = null;

    const response = await suggest(draft.id);
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(String(data.error)).toContain("MODEL_API_KEY");
  });
});

describe("brand-kit apply — the only write path for suggestions", () => {
  it("writes exactly name, tagline, theme and colours — nothing else", async () => {
    const draft = await createDraft({
      category: "restaurant",
      businessName: "Old Chop Bar",
      tagline: "Old line",
      services: ["Catering"],
      items: [
        {
          id: "item-1",
          name: "Jollof Rice",
          price: 45,
          description: "With chicken",
        },
      ],
    });

    const response = await applyPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/apply`, {
        body: JSON.stringify({
          expectedRevision: draft.revision,
          name: "Adepa Chop Bar",
          tagline: "Rice and everything nice",
          palette: {
            themeId: "community",
            primary: "#1B5E3B",
            accent: "#D4A017",
            surface: "#F6FDF7",
          },
        }),
      }),
      idParams(draft.id),
    );
    const updated = (await response.json()) as StudioDraft;

    expect(response.status).toBe(200);
    expect(updated.revision).toBe(draft.revision + 1);
    expect(updated.brief.businessName).toBe("Adepa Chop Bar");
    expect(updated.brief.tagline).toBe("Rice and everything nice");
    expect(updated.brief.selectedTheme).toBe("community");
    expect(updated.brief.preferredColours).toEqual([
      "#1B5E3B",
      "#D4A017",
      "#F6FDF7",
    ]);

    // Nothing else may have changed — compare field by field.
    const owned = new Set([
      "businessName",
      "tagline",
      "selectedTheme",
      "preferredColours",
    ]);
    for (const key of Object.keys(updated.brief) as Array<
      keyof StudioDraft["brief"]
    >) {
      if (owned.has(key)) continue;
      expect(updated.brief[key], `field ${key} must be unchanged`).toEqual(
        draft.brief[key],
      );
    }
    expect(updated.brief.items).toEqual(draft.brief.items);
    expect(updated.brief.services).toEqual(["Catering"]);
  });

  it("honours optimistic concurrency: a stale revision is a 409", async () => {
    const draft = await createDraft();

    const response = await applyPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/apply`, {
        body: JSON.stringify({
          expectedRevision: draft.revision + 5,
          name: "Some Other Name",
        }),
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(409);
  });

  it("refuses a Starter bundle shop without the add-on with 403", async () => {
    const draft = await createStarterBundleDraft();

    const response = await applyPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/apply`, {
        body: JSON.stringify({
          expectedRevision: draft.revision,
          name: "Some Other Name",
        }),
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: PACKAGE_NOT_INCLUDED_MESSAGE,
    });
  });

  it("answers 404 for another agency user's draft", async () => {
    const draft = await createDraft();
    currentUser = userB;

    const response = await applyPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/apply`, {
        body: JSON.stringify({
          expectedRevision: draft.revision,
          name: "Some Other Name",
        }),
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a bad palette with 400 instead of half-applying", async () => {
    const draft = await createDraft();

    const response = await applyPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/apply`, {
        body: JSON.stringify({
          expectedRevision: draft.revision,
          palette: {
            themeId: "not-a-theme",
            primary: "#123",
            accent: "#123456",
            surface: "#123456",
          },
        }),
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(400);
    expect((await store.get(userA, draft.id))!.brief.businessName).toBe(
      draft.brief.businessName,
    );
  });
});

describe("brand-kit logo — rendering, saving, limits", () => {
  function logoBody(draft: StudioDraft, overrides = {}) {
    return JSON.stringify({
      expectedRevision: draft.revision,
      layout: "wordmark",
      name: "Adom Mart",
      palette: {
        primary: "#0A1F44",
        accent: "#E8822B",
        surface: "#F8F6F0",
      },
      ...overrides,
    });
  }

  it("saves a StoredImage into brief.assets.logo, inside every limit", async () => {
    const draft = await createDraft();

    const response = await logoPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/logo`, {
        body: logoBody(draft),
      }),
      idParams(draft.id),
    );
    const updated = (await response.json()) as StudioDraft;

    expect(response.status).toBe(200);
    const logo = updated.brief.assets.logo!;
    expect(logo.fileName).toBe("adommart-logo.png");
    expect(logo.mime).toBe("image/png");
    expect(logo.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(logo.width).toBe(600);
    expect(logo.height).toBe(160);
    expect(logo.width).toBeLessThanOrEqual(600);
    expect(logo.height).toBeLessThanOrEqual(600);
    expect(logo.size).toBeGreaterThan(0);
    expect(logo.size).toBeLessThanOrEqual(MAX_LOGO_BYTES);
    // The rasteriser was asked for the same 600×160 wordmark canvas.
    expect(og.lastOptions).toEqual({ width: 600, height: 160 });
    // PNG bytes survive as valid base64 with PNG magic.
    const bytes = Buffer.from(logo.dataUrl.split(",")[1]!, "base64");
    expect(bytes[0]).toBe(0x89);
    expect(bytes.length).toBe(logo.size);
  });

  it("keeps the stacked layout inside the 600px square too", async () => {
    const draft = await createDraft();

    const response = await logoPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/logo`, {
        body: logoBody(draft, { layout: "stacked" }),
      }),
      idParams(draft.id),
    );
    const updated = (await response.json()) as StudioDraft;

    expect(response.status).toBe(200);
    expect(updated.brief.assets.logo!.width).toBe(480);
    expect(updated.brief.assets.logo!.height).toBe(480);
  });

  it("refuses a Starter bundle shop without the add-on with 403", async () => {
    const draft = await createStarterBundleDraft();

    const response = await logoPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/logo`, {
        body: logoBody(draft),
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(403);
  });

  it("answers 404 for another agency user's draft", async () => {
    const draft = await createDraft();
    currentUser = userB;

    const response = await logoPOST(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/logo`, {
        body: logoBody(draft),
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(404);
  });
});

describe("brand-kit logo.svg — the live preview", () => {
  it("serves the escaped SVG, owner-only, no-store", async () => {
    const draft = await createDraft();
    const query = new URLSearchParams({
      layout: "badge",
      name: `Adom <script>alert("x")</script> & "Sons"`,
      primary: "#0A1F44",
      accent: "#E8822B",
      surface: "#F8F6F0",
    });

    const response = await logoSvgGET(
      goodRequest(
        `/api/studio/drafts/${draft.id}/brand-kit/logo.svg?${query}`,
        { method: "GET" },
      ),
      idParams(draft.id),
    );
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot;");
  });

  it("rejects an unknown layout with 400", async () => {
    const draft = await createDraft();
    const query = new URLSearchParams({
      layout: "billboard",
      name: "Adom Mart",
      primary: "#0A1F44",
      accent: "#E8822B",
      surface: "#F8F6F0",
    });

    const response = await logoSvgGET(
      goodRequest(
        `/api/studio/drafts/${draft.id}/brand-kit/logo.svg?${query}`,
        { method: "GET" },
      ),
      idParams(draft.id),
    );

    expect(response.status).toBe(400);
  });

  it("answers 404 for another agency user's draft", async () => {
    const draft = await createDraft();
    currentUser = userB;
    const query = new URLSearchParams({
      layout: "badge",
      name: "Adom Mart",
      primary: "#0A1F44",
      accent: "#E8822B",
      surface: "#F8F6F0",
    });

    const response = await logoSvgGET(
      goodRequest(
        `/api/studio/drafts/${draft.id}/brand-kit/logo.svg?${query}`,
        { method: "GET" },
      ),
      idParams(draft.id),
    );

    expect(response.status).toBe(404);
  });
});

describe("brand-kit sheet — the printable PNG", () => {
  it("answers a 1200×1600 PNG, no-store, owner-only", async () => {
    const draft = await createDraft({
      businessName: "Adom Mart",
      tagline: "Everyday essentials, delivered",
    });

    const response = await sheetGET(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/sheet`, {
        method: "GET",
      }),
      idParams(draft.id),
    );
    const bytes = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain(
      "adommart-brand-sheet.png",
    );
    expect(og.lastOptions).toEqual({ width: 1200, height: 1600 });
    expect(bytes[0]).toBe(0x89);
  });

  it("refuses a Starter bundle shop without the add-on with 403", async () => {
    const draft = await createStarterBundleDraft();

    const response = await sheetGET(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/sheet`, {
        method: "GET",
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(403);
  });

  it("answers 404 for another agency user's draft", async () => {
    const draft = await createDraft();
    currentUser = userB;

    const response = await sheetGET(
      goodRequest(`/api/studio/drafts/${draft.id}/brand-kit/sheet`, {
        method: "GET",
      }),
      idParams(draft.id),
    );

    expect(response.status).toBe(404);
  });
});
