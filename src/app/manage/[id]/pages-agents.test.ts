/** Stage 7a page and navigation gates for the owner-only Agents surface. */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopAdminSession: vi.fn(),
  publicGetDraft: vi.fn(),
  listForDraft: vi.fn(),
  getSettings: vi.fn(),
  getById: vi.fn(),
  listEntries: vi.fn(),
  listAdmins: vi.fn(),
  emailConfigured: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/shop-admin/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shop-admin/auth")>();
  return {
    ...actual,
    getShopAdminSession: mocks.getShopAdminSession,
    requireShopAdminSession: async (draftId: string, next?: string) => {
      const session = await mocks.getShopAdminSession(draftId);
      if (!session) {
        mocks.redirect(
          `/manage/${draftId}/login?next=${encodeURIComponent(next ?? "")}`,
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
    listForDraft: mocks.listForDraft,
    getSettings: mocks.getSettings,
    getById: mocks.getById,
    listEntries: mocks.listEntries,
  }),
}));

vi.mock("@/lib/shop-agent/email", () => ({
  shopAgentEmailConfigured: mocks.emailConfigured,
}));

vi.mock("@/lib/shop-admin/store", () => ({
  getShopAdminStore: () => ({ listForDraft: mocks.listAdmins }),
}));

const SHOP_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const OTHER_SHOP_ID = "bbbbbbbb-1111-4222-8333-444444444444";
const AGENT_ID = "cccccccc-1111-4222-8333-444444444444";

function draft(
  plan = "command_center",
  category = "data-bundles",
  id = SHOP_ID,
) {
  return {
    id,
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

function session(role: "owner" | "member") {
  return {
    admin: {
      id: `admin-${role}`,
      draftId: SHOP_ID,
      email: `${role}@example.com`,
      name: role === "owner" ? "Kofi" : "Staff",
      role,
      permissions: [],
      status: "active",
      hasPassword: true,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    draftId: SHOP_ID,
    email: "agent@example.com",
    name: "Reseller",
    phone: null,
    status: "active",
    balance: 30,
    hasPassword: true,
    invitedBy: "admin-owner",
    lastLoginAt: "2026-09-09T08:00:00.000Z",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-09T08:00:00.000Z",
    ...overrides,
  };
}

function entry() {
  return {
    id: "entry-1",
    draftId: SHOP_ID,
    agentId: AGENT_ID,
    kind: "credit",
    amount: 50,
    balanceAfter: 50,
    orderId: null,
    note: "Opening credit",
    createdBy: "admin-owner",
    createdAt: "2026-09-09T08:00:00.000Z",
  };
}

async function renderAgentsPage() {
  const { default: Page } = await import("./agents/page");
  const element = await Page({ params: Promise.resolve({ id: SHOP_ID }) });
  return renderToStaticMarkup(element);
}

async function renderStatementPage(agentId = AGENT_ID) {
  const { default: Page } = await import("./agents/[agentId]/page");
  const element = await Page({
    params: Promise.resolve({ id: SHOP_ID, agentId }),
  });
  return renderToStaticMarkup(element);
}

async function renderLayout() {
  const { default: Layout } = await import("./layout");
  const element = await Layout({
    params: Promise.resolve({ id: SHOP_ID }),
    children: null,
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.redirect.mockImplementation(() => {});
  mocks.getShopAdminSession.mockResolvedValue(session("owner"));
  mocks.publicGetDraft.mockResolvedValue(draft());
  mocks.listForDraft.mockResolvedValue([agent()]);
  mocks.getSettings.mockResolvedValue({ discountPercent: 8 });
  mocks.getById.mockResolvedValue(agent());
  mocks.listEntries.mockResolvedValue([entry()]);
  mocks.listAdmins.mockResolvedValue([
    {
      id: "admin-owner",
      name: "Kofi",
      role: "owner",
    },
  ]);
  mocks.emailConfigured.mockReturnValue(false);
});

describe("/manage/[id]/agents pages", () => {
  it("renders the owner Agents page for Command Center data-bundles shops", async () => {
    const html = await renderAgentsPage();
    expect(html).toContain('data-testid="shop-agents-discount"');
    expect(html).toContain('data-testid="shop-agents-add"');
    expect(html).toContain('data-testid="shop-agent-row"');
    expect(html).toContain(
      "Email is not set up on this server yet, so invite links cannot be sent.",
    );
  });

  it("is a 404 for members, non-wallet plans, and non-bundle websites", async () => {
    mocks.getShopAdminSession.mockResolvedValue(session("member"));
    await expect(renderAgentsPage()).rejects.toThrow("NEXT_NOT_FOUND");

    mocks.getShopAdminSession.mockResolvedValue(session("owner"));
    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    await expect(renderAgentsPage()).rejects.toThrow("NEXT_NOT_FOUND");

    mocks.publicGetDraft.mockResolvedValue(
      draft("command_center", "business-profile"),
    );
    await expect(renderAgentsPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("redirects a signed-out owner to this shop's login", async () => {
    mocks.getShopAdminSession.mockResolvedValue(null);
    await expect(renderAgentsPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/manage/${SHOP_ID}/login?next=${encodeURIComponent(`/manage/${SHOP_ID}/agents`)}`,
    );
  });

  it("renders a statement and 404s when the agent belongs to another shop", async () => {
    const html = await renderStatementPage();
    expect(html).toContain('data-testid="shop-agent-entry-row"');
    expect(html).toContain("Credit added");

    mocks.getById.mockResolvedValue(agent({ draftId: OTHER_SHOP_ID }));
    await expect(renderStatementPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("shop admin Agents navigation", () => {
  it("shows the link only to a Command Center owner", async () => {
    expect(await renderLayout()).toContain(
      'data-testid="shop-admin-agents-link"',
    );

    mocks.getShopAdminSession.mockResolvedValue(session("member"));
    expect(await renderLayout()).not.toContain(
      'data-testid="shop-admin-agents-link"',
    );

    mocks.getShopAdminSession.mockResolvedValue(session("owner"));
    mocks.publicGetDraft.mockResolvedValue(draft("auto_dispatch"));
    expect(await renderLayout()).not.toContain(
      'data-testid="shop-admin-agents-link"',
    );
  });
});
