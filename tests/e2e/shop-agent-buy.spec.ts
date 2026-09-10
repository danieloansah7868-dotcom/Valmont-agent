/**
 * Stage 7b end-to-end — the whole agent wallet journey through a real
 * production build on a throwaway SQLite database: priced at the shop
 * discount, paid from the wallet, delivered by the SAME engine as public
 * orders (the simulator in test mode), refunded back by the owner exactly
 * once. Nothing real: no model calls, no TechChief, no email.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "../../src/lib/chat-store";
import { SqliteStudioDraftStore } from "../../src/lib/studio/draft-store";
import { createDefaultBrief } from "../../src/lib/studio/site-brief/defaults";
import { starterBundleCatalogue } from "../../src/lib/studio/bundles";
import { SqliteShopAdminStore } from "../../src/lib/shop-admin/store";
import { SqliteShopAgentStore } from "../../src/lib/shop-agent/store";
import { canonicalUserId } from "../../src/lib/user-identity";
import type { SessionUser } from "../../src/lib/auth";

// The cookie names stay literals here on purpose: the server module that
// defines them (shop-agent/auth) imports next/headers, which only exists
// inside a Next.js bundle — importing it from a Playwright worker would
// make the spec unloadable. The store-side contract tests pin the real
// constant, so a rename can never drift silently.
const SHOP_AGENT_SESSION_COOKIE_NAME = "valmont_shop_agent_session";

const e2eDataDir = path.resolve(process.env.E2E_DATA_DIR ?? ".e2e-data");
setSqliteChatStoreForTests(
  new SqliteChatStore(
    path.join(e2eDataDir, "chat-store.sqlite"),
    path.join(e2eDataDir, "chat-store.json"),
  ),
);
const agency: SessionUser = {
  id: `stage7b-${process.pid}`,
  login: `stage7b-${process.pid}`,
  name: "Stage 7b agency",
};

async function cookies(
  context: BrowserContext,
  baseURL: string,
  name: string,
  value: string,
) {
  const host = new URL(baseURL).hostname;
  await context.addCookies([
    { name, value, domain: host, path: "/" },
    {
      name: "valmont_csrf",
      value: randomBytes(16).toString("hex"),
      domain: host,
      path: "/",
    },
  ]);
}

test.describe("shop agent wallet checkout", () => {
  test("the agent buys at the discount, the owner refunds to the wallet", async ({
    page,
    context,
    baseURL,
  }) => {
    // A Command Center bundle shop with agents enabled, like 7a seeds it.
    // The default brief leaves payments off ("not accepting orders yet"),
    // so flip them on before the create — the buy page 409s without them.
    const brief = {
      ...createDefaultBrief({
        businessName: "Stage 7b Data GH",
        category: "data-bundles",
        plan: "command_center",
        items: starterBundleCatalogue(),
      }),
    };
    brief.payments = {
      ...brief.payments,
      enabled: true,
      methods: ["valmont_pay"] as never,
    };
    const shop = await new SqliteStudioDraftStore().create(agency, brief);
    const adminStore = new SqliteShopAdminStore();
    const ownerInvite = await adminStore.createOwnerInvite({
      draftId: shop.id,
      email: "owner@example.com",
      name: "Owner",
      invitedBy: canonicalUserId(agency),
    });
    const owner = await adminStore.acceptInvite(
      ownerInvite.token,
      "Kofi Owner",
      "correct horse battery",
    );
    const ownerToken = (await adminStore.createSession(owner!.id)).token;

    // 8 percent agent pricing, a funded agent with a GHS 50.00 wallet.
    const agents = new SqliteShopAgentStore();
    await agents.setDiscountPercent(shop.id, 8);
    const invite = await agents.createInvite({
      draftId: shop.id,
      email: "agent@example.com",
      name: "Reseller",
      invitedBy: "owner",
    });
    const inviteToken = await agents.createInviteToken(invite.id);
    const agent = await agents.acceptInvite(
      inviteToken.token,
      "Reseller",
      "correct horse battery",
    );
    await agents.credit({
      agentId: agent!.id,
      amountMinor: 5000,
      createdBy: "owner",
    });
    const agentToken = (await agents.createSession(agent!.id)).token;

    // The agent's home: server-rendered discounted price, one Order button
    // per bundle row.
    await cookies(
      context,
      baseURL!,
      SHOP_AGENT_SESSION_COOKIE_NAME,
      agentToken,
    );
    await page.goto(`/a/${shop.id}`);
    await expect(page.getByTestId("agent-balance")).toContainText("GH₵50.00");
    await expect(page.getByTestId("agent-nav-orders")).toBeVisible();
    const mtnRow = page
      .getByTestId("agent-bundle-row")
      .filter({ hasText: "MTN 1GB" })
      .first();
    await expect(mtnRow.getByTestId("agent-bundle-price")).toContainText(
      "GH₵9.20",
    );
    await mtnRow.getByTestId("agent-buy-open").click();
    await expect(mtnRow.getByTestId("agent-buy-total")).toContainText(
      "GHS 9.20",
    );
    await expect(mtnRow.getByTestId("agent-buy-after")).toContainText(
      "GHS 40.80",
    );
    await mtnRow.getByTestId("agent-buy-recipient").fill("024 000 0001");
    await mtnRow.getByTestId("agent-buy-confirm").click();

    // Confirmation lands on the agent's own order page: paid, delivered by
    // the simulator, and the wallet shows what it cost.
    await page.waitForURL(new RegExp(`/a/${shop.id}/orders/`), {
      waitUntil: "domcontentloaded",
    });
    const orderId = page.url().split("/orders/")[1]!;
    await expect(page.getByTestId("agent-order-status")).toContainText("Paid");
    await expect(page.getByTestId("agent-delivery-delivered")).toBeVisible();
    await expect(page.getByTestId("agent-order-balance-after")).toContainText(
      "GH₵40.80",
    );

    // The expensive bundle can't come out of GH₵40.80: explain, don't 409.
    await page.goto(`/a/${shop.id}`);
    const bigRow = page
      .getByTestId("agent-bundle-row")
      .filter({ hasText: "MTN 10GB" })
      .first();
    await bigRow.getByTestId("agent-buy-open").click();
    await expect(bigRow.getByTestId("agent-buy-topup")).toContainText(
      "Top up first. Ask Stage 7b Data GH to add credit.",
    );
    await expect(bigRow.getByTestId("agent-buy-confirm")).toHaveCount(0);

    // The owner's order list carries the Agent badge.
    await cookies(context, baseURL!, "valmont_shop_session", ownerToken);
    await page.goto(`/manage/${shop.id}`);
    await expect(page.getByTestId("shop-order-agent-badge")).toBeVisible();
    await page.goto(`/manage/${shop.id}/orders/${orderId}`);
    await expect(page.getByTestId("shop-order-agent")).toContainText(
      "Paid from agent wallet - Reseller",
    );
    await expect(page.getByTestId("shop-order-agent-link")).toHaveAttribute(
      "href",
      `/manage/${shop.id}/agents/${agent!.id}`,
    );

    // Refund to wallet — owner-only, confirmed, exactly once.
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("shop-refund-wallet").click();
    await expect(page.getByTestId("shop-order-refund-note")).toContainText(
      /Refunded to wallet on .+ by Kofi Owner/,
    );
    await expect(page.getByTestId("shop-refund-wallet")).toHaveCount(0);
    await expect(page.getByText("Refunded").first()).toBeVisible();

    // The agent's statement shows the Refund row and the restored balance.
    await page.goto(`/a/${shop.id}/wallet`);
    await expect(
      page.getByTestId("agent-entry-order-link").first(),
    ).toContainText(/Refund - Order /);
    const refundRow = page
      .getByTestId("agent-entry-row")
      .filter({ hasText: "Refund" })
      .first();
    await expect(refundRow).toContainText("GH₵50.00");
    await page.goto(`/a/${shop.id}`);
    await expect(page.getByTestId("agent-balance")).toContainText("GH₵50.00");

    // And the refunded order tells the agent where the money went.
    await page.goto(`/a/${shop.id}/orders/${orderId}`);
    await expect(page.getByTestId("agent-order-status")).toContainText(
      "Refunded",
    );
  });
});
