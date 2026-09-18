/**
 * The portfolio landing page shows the venture cards AND, by owner decision,
 * every saved idea from the notebook — ideas are public. The rules under
 * test:
 *
 *  - saved ideas render in the "Ideas & future plans" section, newest first
 *    straight from the store,
 *  - with zero ideas (or a store that cannot be read) the section and its
 *    nav link stay hidden and the page still renders, but the navy
 *    "Connected by design" grid always shows an Ideas tile linking to #ideas,
 *  - the active ventures link out to their real websites,
 *  - only genuinely live ventures carry the LIVE badge (Chat is not live).
 *
 * The page is a server component, so the test calls it and renders the
 * element it returns — the markup is the contract.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPublic: vi.fn(),
}));

vi.mock("@/lib/idea-store", () => ({
  getIdeaStore: () => ({ listPublic: mocks.listPublic }),
}));

import PortfolioPage from "./page";

function idea(overrides: Record<string, unknown> = {}) {
  return {
    id: "idea-1",
    userId: "user-1",
    title: "Open a repair workshop",
    details: "Bench space, tools, and a parts shelf.",
    status: "planned",
    priority: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

async function renderPage(): Promise<string> {
  const page = await PortfolioPage();
  return renderToStaticMarkup(page);
}

describe("portfolio landing page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows every saved idea in the Ideas & future plans section", async () => {
    mocks.listPublic.mockResolvedValue([
      idea({ id: "idea-2", title: "Newest first", status: "building" }),
      idea(),
    ]);
    const html = await renderPage();

    expect(html).toContain("Ideas &amp; future plans");
    expect(html).toContain("From the idea board");
    expect(html).toContain("Newest first");
    expect(html).toContain("Open a repair workshop");
    expect(html).toContain("Bench space, tools, and a parts shelf.");
    expect(html).toContain("portfolio-idea-idea-2");
    expect(html).toContain("Building");
    expect(html).toContain("Planned");
    // The nav grows an Ideas link only when the section exists, plus the navy grid Ideas tile.
    expect(html).toContain('href="#ideas"');
  });

  it("hides the ideas section and nav link when there are no ideas, but keeps the Ideas tile in the navy grid", async () => {
    mocks.listPublic.mockResolvedValue([]);
    const html = await renderPage();

    expect(html).not.toContain("From the idea board");
    // The navy "Connected by design" grid now always shows an Ideas tile that links to #ideas
    expect(html).toContain('href="#ideas"');
    expect(html).toContain("Ideas");
    // The rest of the portfolio still renders.
    expect(html).toContain("The Ventures");
  });

  it("still renders when the notebook cannot be read", async () => {
    mocks.listPublic.mockRejectedValue(new Error("db offline"));
    const html = await renderPage();

    expect(html).toContain("The Ventures");
    expect(html).not.toContain("From the idea board");
    // Grid Ideas tile remains even when the store fails
    expect(html).toContain('href="#ideas"');
  });

  it("links the active ventures to their real websites", async () => {
    mocks.listPublic.mockResolvedValue([]);
    const html = await renderPage();

    for (const url of [
      "https://valmontpay.app",
      "https://valmontelectricals.com",
      "https://gadgets.com",
      "https://valmontweb.com",
    ]) {
      expect(html).toContain(url);
    }
    expect(html).toContain("Visit website");
  });

  it("marks five ventures live — Chat is not one of them", async () => {
    mocks.listPublic.mockResolvedValue([]);
    const html = await renderPage();

    expect(html.match(/LIVE</g)?.length ?? 0).toBe(5);
    expect(html).toContain("5 live now");
  });
});
