/** Stage 7a agent portal page and layout gates. */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAgentSession: vi.fn(),
  publicGetDraft: vi.fn(),
  getSettings: vi.fn(),
  listEntries: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/shop-agent/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shop-agent/auth")>();
  return {
    ...actual,
    getShopAgentSession: mocks.getShopAgentSession,
    requireShopAgentSession: async (draftId: string, next?: string) => {
      const session = await mocks.getShopAgentSession(draftId);
      if (!session) {
        mocks.redirect(
          `/a/${draftId}/login?next=${encodeURIComponent(next ?? "")}`,
        );
        throw new Error("NEXT_REDIRECT");
      }
      return session;
    },
  };
});

vi.mock("@/lib/studio/draft-public", () => ({
  publicGetDraft: mocks.publicGetDraft,
}));

vi.mock("@/lib/shop-agent/store", () => ({
  getShopAgentStore: () => ({
    getSettings: mocks.getSettings,
    listEntries: mocks.listEntries,
  }),
}));

const SHOP_ID = "aaaaaaaa-1111-4222-8333-444444444444";

function draft(plan = "command_center", category = "data-bundles") {
  return {
    id: SHOP_ID,
    ownerId: "agency-owner-1",
    brief: {
      businessName: "Data GH",
      category,
      plan,
      items: [
        {
          id: "bundle-00",
          name: "MTN 1GB",
          price: 10,
          bundle: { network: "mtn", dataMb: 1024, validity: "7 days" },
        },
      ],
    },
  };
}

function session() {
  return {
    agent: {
      id: "agent-1",
      draftId: SHOP_ID,
      email: "agent@example.com",
      name: "Reseller",
      phone: null,
      status: "active",
      balance: 30,
      hasPassword: true,
      invitedBy: "owner",
      lastLoginAt: "2026-09-09T08:00:00.000Z",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-09T08:00:00.000Z",
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function entry() {
  return {
    id: "entry-1",
    draftId: SHOP_ID,
    agentId: "agent-1",
    kind: "credit",
    amount: 50,
    balanceAfter: 50,
    orderId: null,
    note: "Opening credit",
    createdBy: "owner",
    createdAt: "2026-09-09T08:00:00.000Z",
  };
}

async function renderLayout() {
  const { default: Layout } = await import("./layout");
  const element = await Layout({
    params: Promise.resolve({ id: SHOP_ID }),
    children: null,
  });
  return renderToStaticMarkup(element);
}

async function renderHome() {
  const { default: Page } = await import("./page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

async function renderWallet() {
  const { default: Page } = await import("./wallet/page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.redirect.mockImplementation(() => {});
  mocks.getShopAgentSession.mockResolvedValue(session());
  mocks.publicGetDraft.mockResolvedValue(draft());
  mocks.getSettings.mockResolvedValue({ discountPercent: 8 });
  mocks.listEntries.mockResolvedValue([entry()]);
});

describe("/a/[id] agent portal layout", () => {
  it("404s for an unknown shop, Auto-Dispatch, and non-bundle shops", async () => {
    mocks.publicGetDraft.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");

    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");

    mocks.publicGetDraft.mockResolvedValue(
      draft("command_center", "business-profile"),
    );
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/a/[id] agent portal pages", () => {
  it("redirects the home page to login without an agent session", async () => {
    mocks.getShopAgentSession.mockResolvedValue(null);
    await expect(renderHome()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/a/${SHOP_ID}/login?next=${encodeURIComponent(`/a/${SHOP_ID}`)}`,
    );
  });

  it("shows the balance, discount, and agent bundle price without buying", async () => {
    const html = await renderHome();
    expect(html).toContain('data-testid="agent-balance"');
    expect(html).toContain("GH₵30.00");
    expect(html).toContain('data-testid="agent-discount"');
    expect(html).toContain("Your price: 8% below the shop price.");
    expect(html).toContain('data-testid="agent-bundle-price"');
    expect(html).toContain("GH₵9.20");
    expect(html).not.toContain("Buy");
  });

  it("renders one wallet statement row per entry", async () => {
    const html = await renderWallet();
    expect(html).toContain('data-testid="agent-entry-row"');
    expect((html.match(/data-testid="agent-entry-row"/g) ?? []).length).toBe(1);
  });
});
