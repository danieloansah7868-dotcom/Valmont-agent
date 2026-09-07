import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "../../src/lib/chat-store";
import { encryptSessionValue } from "../../src/lib/security";
import { createDefaultBrief } from "../../src/lib/studio/site-brief/defaults";
import { SqliteStudioDraftStore } from "../../src/lib/studio/draft-store";
import { starterBundleCatalogue } from "../../src/lib/studio/bundles";
import { SqliteOrdersStore } from "../../src/lib/studio/orders";
import { canonicalUserId } from "../../src/lib/user-identity";

/**
 * Stage 6b — the shop owner's side, end to end.
 *
 * The agency user creates the owner login from the Studio card; the e2e
 * server has no email provider, so the card shows the one-time link. The
 * owner follows it, sets a password, lands on the orders list, opens an
 * order (full recipient number), and logs out — after which the same page
 * sends them back to the login form. A second shop's session is worth
 * nothing on the first.
 */

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("SESSION_SECRET (32+ characters) must be set for e2e tests.");
}

const e2eDataDir = path.resolve(process.env.E2E_DATA_DIR ?? ".e2e-data");
setSqliteChatStoreForTests(
  new SqliteChatStore(
    path.join(e2eDataDir, "chat-store.sqlite"),
    path.join(e2eDataDir, "chat-store.json"),
  ),
);

type StudioOwner = { id: string; login: string; name: string };

let sequence = 0;

function uniqueSuffix(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}-${randomBytes(4).toString("hex")}`;
}

function nextOwner(): StudioOwner {
  const suffix = uniqueSuffix("agency");
  return {
    id: `e2e-${suffix}`,
    login: suffix,
    name: `Agency ${suffix}`,
  };
}

function sessionCookieValue(user: StudioOwner): string {
  return encryptSessionValue(
    JSON.stringify({
      accessToken: "e2e-access-token",
      id: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: "",
      expiresAt: Date.now() + 3_600_000,
    }),
    SECRET,
  );
}

async function signInStudio(
  context: BrowserContext,
  user: StudioOwner,
  baseURL: string,
): Promise<void> {
  await context.clearCookies();
  const host = new URL(baseURL).hostname;
  await context.addCookies([
    {
      name: "valmont_session",
      value: sessionCookieValue(user),
      domain: host,
      path: "/",
    },
    {
      name: "valmont_csrf",
      value: randomBytes(16).toString("hex"),
      domain: host,
      path: "/",
    },
  ]);
}

async function seedBundleShop(owner: StudioOwner, label: string) {
  const draftStore = new SqliteStudioDraftStore();
  return draftStore.create(
    owner,
    createDefaultBrief({
      businessName: `E2E ${label} ${owner.login}`,
      category: "data-bundles",
      selectedTemplate: "bundle-shop",
      adminEmail: `${owner.login}@example.com`,
      phone: "+233240000000",
      description: "Instant MTN, Telecel and AirtelTigo bundles.",
      items: starterBundleCatalogue(),
      payments: {
        enabled: true,
        methods: ["valmont_pay"],
        valmontPay: { provisioned: false },
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
      features: { customerAccounts: false },
    }),
  );
}

async function seedPaidOrder(owner: StudioOwner, draftId: string) {
  const bundle = starterBundleCatalogue().find(
    (item) => item.bundle?.network === "mtn",
  )!;
  const price = bundle.price ?? 10;
  return new SqliteOrdersStore().create({
    ownerId: canonicalUserId(owner),
    draftId,
    accessCode: `e2e-${randomBytes(12).toString("hex")}`,
    status: "paid",
    currency: "GHS",
    subtotal: price,
    deliveryFee: 0,
    total: price,
    lines: [
      {
        itemId: bundle.id,
        name: bundle.name,
        price,
        quantity: 1,
        bundle: bundle.bundle,
      },
    ],
    customerName: "Kwame Buyer",
    customerPhone: "0200000002",
    recipientPhone: "0240000001",
    paymentMethod: "valmont_pay",
    paymentMode: "live",
  });
}

test.describe("shop admin", () => {
  test("invite → set password → login → open order → logout", async ({
    page,
    context,
    baseURL,
  }) => {
    const agency = nextOwner();
    await signInStudio(context, agency, baseURL!);
    const shop = await seedBundleShop(agency, "Shop");
    const order = await seedPaidOrder(agency, shop.id);
    const ownerEmail = `owner-${uniqueSuffix("mail")}@example.com`;
    const password = "a very long shop password";

    // 1. The agency creates the owner login from the Studio card. No email
    //    provider on the e2e server, so the one-time link is shown once.
    await page.goto(`/studio/drafts/${shop.id}`);
    const card = page.getByTestId("shop-logins-card");
    await expect(card).toBeVisible();
    await card.getByTestId("shop-owner-name").fill("Kofi Mensah");
    await card.getByTestId("shop-owner-email").fill(ownerEmail);
    await card.getByTestId("shop-owner-invite").click();
    const linkBox = card.getByTestId("shop-login-link");
    await expect(linkBox).toBeVisible();
    await expect(linkBox).toContainText(
      "Send this link to the owner on WhatsApp",
    );
    const inviteLink = (await linkBox
      .locator("p")
      .last()
      .textContent())!.trim();
    expect(inviteLink).toContain(`/manage/${shop.id}/accept-invite?token=`);
    await expect(card.getByTestId("shop-owner-status")).toContainText(
      "Invited",
    );

    // 2. The owner (a different browser: no agency cookie) follows the link
    //    and sets a password. The frame is the shop's own — no Studio nav.
    await context.clearCookies();
    await page.goto(inviteLink);
    await expect(page.getByTestId("shop-admin-name")).toContainText(
      shop.brief.businessName,
    );
    await expect(page.getByText("Welcome, Kofi Mensah")).toBeVisible();
    await expect(page.getByText("Website Studio")).toHaveCount(0);
    await page.getByTestId("shop-accept-password").fill(password);
    await page.getByTestId("shop-accept-confirm").fill(password);
    await page.getByTestId("shop-accept-submit").click();

    // 3. Signed in: the orders list, newest first, with the seeded order.
    await expect(page).toHaveURL(new RegExp(`/manage/${shop.id}$`));
    await expect(page.getByTestId("shop-orders-list")).toBeVisible();
    const row = page.getByTestId("shop-order-row").first();
    await expect(row).toContainText("Kwame Buyer");
    await expect(page.getByTestId("shop-admin-team-link")).toBeVisible();

    // The same link a second time is dead.
    const again = await context.newPage();
    await again.goto(inviteLink);
    await expect(again.getByTestId("shop-invite-invalid")).toBeVisible();
    await again.close();

    // 4. Open the order: the recipient's number in full.
    await row.click();
    await expect(page).toHaveURL(
      new RegExp(`/manage/${shop.id}/orders/${order.id}$`),
    );
    await expect(page.getByTestId("shop-order-recipient")).toHaveText(
      "0240000001",
    );
    await expect(page.getByTestId("shop-order-status")).toHaveText("Paid");
    await expect(page.getByText("Update this order")).toHaveCount(0);

    // 5. Logout, then the order page bounces to login with a return path.
    await page.getByTestId("shop-logout").click();
    await expect(page).toHaveURL(new RegExp(`/manage/${shop.id}/login`));
    await page.goto(`/manage/${shop.id}/orders/${order.id}`);
    await expect(page).toHaveURL(
      new RegExp(`/manage/${shop.id}/login\\?next=`),
    );

    // 6. Sign in again with the password; a wrong one gets the neutral 401.
    await page.getByTestId("shop-login-email").fill(ownerEmail);
    await page.getByTestId("shop-login-password").fill("not the password");
    await page.getByTestId("shop-login-submit").click();
    await expect(page.getByTestId("shop-form-error")).toHaveText(
      "Email or password is incorrect.",
    );
    await page.getByTestId("shop-login-password").fill(password);
    await page.getByTestId("shop-login-submit").click();
    await expect(page).toHaveURL(
      new RegExp(`/manage/${shop.id}/orders/${order.id}$`),
    );
    await expect(page.getByTestId("shop-order-recipient")).toHaveText(
      "0240000001",
    );

    // 7. The owner's session is for this shop only: another website of the
    //    same agency user asks for a login, and its admin API says 404.
    const other = await seedBundleShop(agency, "Other");
    await page.goto(`/manage/${other.id}`);
    await expect(page).toHaveURL(new RegExp(`/manage/${other.id}/login`));
    // Fetched from inside the page so the browser's own (Secure) session
    // cookie travels with the request, exactly as the admin UI would send it.
    const statusOf = (url: string) =>
      page.evaluate(async (target) => (await fetch(target)).status, url);
    expect(await statusOf(`/api/manage/${other.id}/team`)).toBe(404);
    expect(await statusOf(`/api/manage/${shop.id}/team`)).toBe(200);
  });

  test("the owner adds a member from Team; the member cannot open Team", async ({
    page,
    context,
    baseURL,
  }) => {
    const agency = nextOwner();
    await signInStudio(context, agency, baseURL!);
    const shop = await seedBundleShop(agency, "Team");
    const ownerEmail = `owner-${uniqueSuffix("mail")}@example.com`;
    const password = "a very long shop password";

    await page.goto(`/studio/drafts/${shop.id}`);
    const card = page.getByTestId("shop-logins-card");
    await card.getByTestId("shop-owner-name").fill("Ama Owner");
    await card.getByTestId("shop-owner-email").fill(ownerEmail);
    await card.getByTestId("shop-owner-invite").click();
    const inviteLink = (await card
      .getByTestId("shop-login-link")
      .locator("p")
      .last()
      .textContent())!.trim();

    await context.clearCookies();
    await page.goto(inviteLink);
    await page.getByTestId("shop-accept-password").fill(password);
    await page.getByTestId("shop-accept-confirm").fill(password);
    await page.getByTestId("shop-accept-submit").click();
    await expect(page.getByTestId("shop-orders-empty")).toBeVisible();

    // Team: invite a member with one box ticked.
    await page.getByTestId("shop-admin-team-link").click();
    await expect(page).toHaveURL(new RegExp(`/manage/${shop.id}/team$`));
    await expect(page.getByTestId("shop-team-row")).toHaveCount(1);
    await page.getByTestId("team-invite-name").fill("Yaw Staff");
    await page
      .getByTestId("team-invite-email")
      .fill(`staff-${uniqueSuffix("m")}@example.com`);
    await page.locator("#team-invite-orders\\.fulfil").check();
    await page.getByTestId("team-invite-submit").click();
    await expect(page.getByTestId("shop-team-row")).toHaveCount(2);
    // No provider on this server, so the notice says the agency passes the
    // link on — and the page never shows a link.
    await expect(page.getByTestId("shop-team-notice")).toContainText(
      "ask the person who built your website",
    );
    await expect(page.getByText(/accept-invite\?token=/)).toHaveCount(0);

    // The member's boxes are exactly what was ticked.
    const memberRow = page.getByTestId("shop-team-row").nth(1);
    await expect(memberRow.getByTestId("perm-orders.fulfil")).toBeChecked();
    await expect(memberRow.getByTestId("perm-reports.view")).not.toBeChecked();

    // Disable the member: their row says so; the owner's row has no toggle.
    await memberRow.getByTestId("shop-team-toggle").click();
    await expect(memberRow).toContainText("Disabled");
    await expect(
      page.getByTestId("shop-team-row").first().getByTestId("shop-team-toggle"),
    ).toHaveCount(0);
  });
});
