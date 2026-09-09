/**
 * Stage 6c — the wizard save path keeps the shop's pause ticks.
 *
 * The PATCH route for a draft is what the wizard's autosave hits. The wizard
 * has no notion of `paused`, so its payload arrives without the key; without
 * the carry-over every save would silently unpause every bundle the shop
 * paused. The agency session is mocked (that is what `requireApiSessionUser`
 * is for); the draft store is real, on a throwaway SQLite database, so the
 * whole read → merge → validate → compare-and-set path runs as in
 * production. The optimistic-concurrency contract (`expectedRevision`) is
 * untouched — 6b's and Phase 3's suites still cover it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteChatStore, setSqliteChatStoreForTests } from "@/lib/chat-store";
import { setIdeaStoreForTests } from "@/lib/idea-store";
import type { SessionUser } from "@/lib/auth";
import { resetRateLimitForTests } from "@/lib/security";
import { SqliteStudioDraftStore } from "@/lib/studio/draft-store";
import { createDefaultBrief } from "@/lib/studio/site-brief/defaults";
import { starterBundleCatalogue } from "@/lib/studio/bundles";
import { PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  requireApiSessionUser: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireApiSessionUser: mocks.requireApiSessionUser };
});

const agency: SessionUser = { id: "9001", login: "ama", name: "Ama" };
const csrf = "studio-draft-paused-csrf-token-123456";

const dirs: string[] = [];
let drafts: SqliteStudioDraftStore;
let draftId = "";

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TRUST_PROXY", "false");
  vi.stubEnv("APP_URL", "https://valmont.example");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-that-is-long-enough");
  delete process.env.DATABASE_URL;
  resetRateLimitForTests();
  mocks.requireApiSessionUser.mockReset();
  mocks.requireApiSessionUser.mockResolvedValue(agency);
  const dir = mkdtempSync(path.join(os.tmpdir(), "valmont-paused-carry-"));
  dirs.push(dir);
  setSqliteChatStoreForTests(
    new SqliteChatStore(
      path.join(dir, "chat-store.sqlite"),
      path.join(dir, "chat-store.json"),
    ),
  );
  setIdeaStoreForTests(null);
  drafts = new SqliteStudioDraftStore();
  const draft = await drafts.create(
    agency,
    createDefaultBrief({
      businessName: "Adom Data Hub",
      category: "data-bundles",
      phone: "+233201234567",
      adminEmail: "owner@adom.example",
      items: starterBundleCatalogue(),
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        valmontPay: { provisioned: true },
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        notifications: { email: "owner@adom.example" },
        staged: { enabled: false, stages: [] },
      },
    }),
  );
  draftId = draft.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSqliteChatStoreForTests(null);
  setIdeaStoreForTests(null);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** The stored brief with exactly one item paused by the shop. */
async function pauseOneItem(itemId: string): Promise<void> {
  const current = (await drafts.list(agency)).find((d) => d.id === draftId)!;
  const saved = await drafts.update(
    agency,
    draftId,
    {
      ...current.brief,
      items: current.brief.items.map((item) =>
        item.id === itemId ? { ...item, paused: true } : item,
      ),
    },
    current.revision,
  );
  void saved;
}

function saveRequest(brief: object, expectedRevision: number) {
  return new NextRequest(`http://localhost/api/studio/drafts/${draftId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: `valmont_csrf=${csrf}`,
      "x-valmont-csrf": csrf,
    },
    body: JSON.stringify({ ...brief, expectedRevision }),
  });
}

function params() {
  return { params: Promise.resolve({ id: draftId }) };
}

describe("wizard save keeps the shop's paused flags (Stage 6c)", () => {
  it("an incoming item with NO paused key inherits the stored value", async () => {
    await pauseOneItem("bundle-00");
    const stored = (await drafts.list(agency)).find((d) => d.id === draftId)!;
    expect(stored.brief.items.find((i) => i.id === "bundle-00")?.paused).toBe(
      true,
    );

    // The wizard's autosave: the same items, prices edited, NO paused keys.
    const wizardBrief = {
      ...stored.brief,
      items: stored.brief.items.map((item) => {
        const { paused: _paused, ...rest } = item;
        void _paused;
        return { ...rest, price: (rest.price ?? 10) + 1 };
      }),
    };

    const response = await PATCH(
      saveRequest(wizardBrief, stored.revision),
      params(),
    );
    expect(response.status).toBe(200);

    const after = (await drafts.list(agency)).find((d) => d.id === draftId)!;
    const item = after.brief.items.find((i) => i.id === "bundle-00")!;
    expect(item.paused).toBe(true);
    // The price edit from the autosave still landed.
    expect(item.price).toBe(
      (stored.brief.items.find((i) => i.id === "bundle-00")!.price ?? 10) + 1,
    );
  });

  it("an item that explicitly carries the key wins — the agency can resume a paused bundle on purpose", async () => {
    await pauseOneItem("bundle-00");
    const stored = (await drafts.list(agency)).find((d) => d.id === draftId)!;
    const wizardBrief = {
      ...stored.brief,
      items: stored.brief.items.map((item) =>
        item.id === "bundle-00" ? { ...item, paused: false } : item,
      ),
    };

    const response = await PATCH(
      saveRequest(wizardBrief, stored.revision),
      params(),
    );
    expect(response.status).toBe(200);
    const after = (await drafts.list(agency)).find((d) => d.id === draftId)!;
    expect(after.brief.items.find((i) => i.id === "bundle-00")?.paused).toBe(
      false,
    );
  });

  it("a brand-new item is saved without a paused key (no flag invented)", async () => {
    const stored = (await drafts.list(agency)).find((d) => d.id === draftId)!;
    const wizardBrief = {
      ...stored.brief,
      items: [
        ...stored.brief.items,
        {
          id: "bundle-new",
          name: "MTN 500MB",
          price: 6,
          bundle: { network: "mtn", dataMb: 512, validity: "7 days" },
        },
      ],
    };

    const response = await PATCH(
      saveRequest(wizardBrief, stored.revision),
      params(),
    );
    expect(response.status).toBe(200);
    const after = (await drafts.list(agency)).find((d) => d.id === draftId)!;
    expect(
      after.brief.items.find((i) => i.id === "bundle-new")?.paused,
    ).toBeUndefined();
  });
});
