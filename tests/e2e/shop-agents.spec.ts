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

const e2eDataDir = path.resolve(process.env.E2E_DATA_DIR ?? ".e2e-data");
setSqliteChatStoreForTests(
  new SqliteChatStore(
    path.join(e2eDataDir, "chat-store.sqlite"),
    path.join(e2eDataDir, "chat-store.json"),
  ),
);
const agency: SessionUser = {
  id: `stage7-${process.pid}`,
  login: `stage7-${process.pid}`,
  name: "Stage 7 agency",
};
let sequence = 0;
function suffix() {
  sequence += 1;
  return `${Date.now()}-${process.pid}-${sequence}-${randomBytes(3).toString("hex")}`;
}
function brief(plan: "command_center" | "auto_dispatch") {
  return createDefaultBrief({
    businessName: `Stage 7 ${plan} ${suffix()}`,
    category: "data-bundles",
    plan,
    items: starterBundleCatalogue(),
  });
}
async function seedShop(plan: "command_center" | "auto_dispatch") {
  return new SqliteStudioDraftStore().create(agency, brief(plan));
}
async function ownerFor(draftId: string) {
  const store = new SqliteShopAdminStore();
  const invite = await store.createOwnerInvite({
    draftId,
    email: `owner-${suffix()}@example.com`,
    name: "Owner",
    invitedBy: canonicalUserId(agency),
  });
  const owner = await store.acceptInvite(
    invite.token,
    "Owner",
    "correct horse battery",
  );
  return {
    store,
    owner: owner!,
    token: (await store.createSession(owner!.id)).token,
  };
}
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

test.describe("shop agents", () => {
  test("owner pricing, agent portal, and owner wallet ledger", async ({
    page,
    context,
    baseURL,
  }) => {
    const shop = await seedShop("command_center");
    const { token: ownerToken } = await ownerFor(shop.id);
    await cookies(context, baseURL!, "valmont_shop_session", ownerToken);
    await page.goto(`/manage/${shop.id}/agents`);
    await expect(page.getByTestId("shop-agents-discount")).toBeVisible();
    await page.getByTestId("shop-agents-discount").fill("8");
    await page.getByTestId("shop-agents-discount-save").click();
    await expect(page.getByText("Agent pricing saved.")).toBeVisible();

    const agents = new SqliteShopAgentStore();
    const invite = await agents.createInvite({
      draftId: shop.id,
      email: `agent-${suffix()}@example.com`,
      name: "Reseller",
      invitedBy: "owner",
    });
    const inviteToken = await agents.createInviteToken(invite.id);
    await context.clearCookies();
    const host = new URL(baseURL!).hostname;
    await context.addCookies([
      {
        name: "valmont_csrf",
        value: randomBytes(16).toString("hex"),
        domain: host,
        path: "/",
      },
    ]);
    await page.goto(
      `/a/${shop.id}/accept-invite?token=${encodeURIComponent(inviteToken.token)}`,
    );
    await page.getByTestId("agent-accept-name").fill("Reseller");
    await page
      .getByTestId("agent-accept-password")
      .fill("correct horse battery");
    await page
      .getByTestId("agent-accept-confirm")
      .fill("correct horse battery");
    await page
      .getByRole("button", { name: "Set password and sign in" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/a/${shop.id}$`));
    await expect(page.getByTestId("agent-balance")).toContainText("GH₵0.00");
    await expect(page.getByTestId("agent-bundle-price").first()).toContainText(
      "GH₵9.20",
    );

    await agents.credit({
      agentId: invite.id,
      amountMinor: 5000,
      createdBy: "owner",
    });
    await agents.deduct({
      agentId: invite.id,
      amountMinor: 2000,
      createdBy: "owner",
    });
    await page.reload();
    await expect(page.getByTestId("agent-balance")).toContainText("GH₵30.00");
    await page.goto(`/a/${shop.id}/wallet`);
    await expect(page.getByTestId("agent-entry-row")).toHaveCount(2);
  });

  test("members and non-Command-Center shops cannot see agents", async ({
    page,
    context,
    baseURL,
  }) => {
    const auto = await seedShop("auto_dispatch");
    const { token: ownerToken } = await ownerFor(auto.id);
    await cookies(context, baseURL!, "valmont_shop_session", ownerToken);
    await page.goto(`/manage/${auto.id}`);
    await expect(page.getByTestId("shop-admin-agents-link")).toHaveCount(0);
    const autoAgents = await page.request.get(`/manage/${auto.id}/agents`);
    expect(autoAgents.status()).toBe(404);
    const autoPortal = await page.request.get(`/a/${auto.id}/login`);
    expect(autoPortal.status()).toBe(404);
  });
});
