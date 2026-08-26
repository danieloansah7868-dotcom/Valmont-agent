import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "../../src/lib/chat-store";
import { SqliteCustomerAccountStore } from "../../src/lib/customer-account-store";
import { encryptSessionValue } from "../../src/lib/security";
import { createDefaultBrief } from "../../src/lib/studio/site-brief/defaults";
import { SqliteStudioDraftStore } from "../../src/lib/studio/draft-store";

/**
 * These tests seed only the throwaway SQLite database used by the Playwright
 * server. Authentication still uses the application's real encrypted Studio
 * session cookie and real customer session rows; there is no test-only auth
 * branch in application code.
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

type SeededCustomer = {
  email: string;
  name: string;
  sessionToken: string;
};

let sequence = 0;

function uniqueSuffix(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}-${randomBytes(4).toString("hex")}`;
}

function nextOwner(): StudioOwner {
  const suffix = uniqueSuffix("owner");
  return {
    id: `e2e-${suffix}`,
    login: suffix,
    name: `Merchant ${suffix}`,
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

async function signInCustomer(
  context: BrowserContext,
  customer: SeededCustomer,
  baseURL: string,
): Promise<void> {
  await context.addCookies([
    {
      name: "valmont_customer_session",
      value: customer.sessionToken,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function seedCustomer(namePrefix: string): Promise<SeededCustomer> {
  const suffix = uniqueSuffix(namePrefix);
  const email = `${suffix}@example.com`;
  const name = `${namePrefix} Customer`;
  const store = new SqliteCustomerAccountStore();
  const account = await store.createAccount({
    email,
    name,
    password: "e2e-customer-password-123",
  });
  await store.verifyEmail(account.id);
  const session = await store.createSession(account.id);
  return { email, name, sessionToken: session.token };
}

async function seedShop(owner: StudioOwner) {
  const draftStore = new SqliteStudioDraftStore();
  return draftStore.create(
    owner,
    createDefaultBrief({
      businessName: `E2E Kitchen ${owner.login}`,
      category: "online-shop",
      adminEmail: `${owner.login}@example.com`,
      phone: "+233240000000",
      description: "Fresh Ghanaian meals for local delivery.",
      items: [
        {
          id: "jollof-rice",
          name: "Jollof Rice",
          price: 25,
        },
      ],
      payments: {
        enabled: true,
        methods: ["cod"],
        valmontPay: { provisioned: false },
        delivery: { enabled: false, fee: 0, minimumOrder: 0 },
        notifications: {},
        staged: { enabled: false, stages: [] },
      },
    }),
  );
}

async function placeCashOrder(
  page: Page,
  draftId: string,
  customerName: string,
): Promise<string> {
  await page.goto(`/s/${draftId}`);
  await expect(page.getByTestId("public-storefront")).toBeVisible();
  await page.getByTestId("add-jollof-rice").click();
  await page.getByTestId("start-checkout").click();
  await page.getByLabel("Your name").fill(customerName);
  await page.getByLabel("Phone number").fill("+233240000001");
  // Email intentionally remains blank in both flows: guest checkout must work
  // without it, while a signed-in customer is linked using the session email.
  await page.getByTestId("place-order").click();
  await expect(page.getByTestId("order-success")).toBeVisible();

  const detailsLink = page.getByRole("link", { name: "View order details" });
  const href = await detailsLink.getAttribute("href");
  const match = href?.match(/^\/orders\/([^/]+)\/confirmed$/);
  if (!match?.[1]) throw new Error("Checkout did not return an order link");
  return decodeURIComponent(match[1]);
}

test.describe("customer storefront and order tracking", () => {
  test("keeps guest checkout available without an account or email", async ({
    page,
  }) => {
    const owner = nextOwner();
    const draft = await seedShop(owner);
    const orderId = await placeCashOrder(page, draft.id, "Guest Ama");

    await page.goto(`/orders/${orderId}/confirmed`);
    await expect(
      page.getByText("Guest order account linking unavailable"),
    ).toBeVisible();
    await expect(page.getByText(/Cash on delivery/).first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Track this order in your account/i }),
    ).toHaveCount(0);
  });

  test("lets a signed-in customer track only their order and see merchant updates", async ({
    page,
    context,
    browser,
    baseURL,
  }) => {
    const owner = nextOwner();
    await signInStudio(context, owner, baseURL!);
    const draft = await seedShop(owner);
    const customer = await seedCustomer("Primary");
    const customerContext = await browser.newContext({ baseURL });
    await signInCustomer(customerContext, customer, baseURL!);
    const customerPage = await customerContext.newPage();

    const orderId = await placeCashOrder(customerPage, draft.id, customer.name);

    // The public confirmation page only exposes the account tracking CTA to
    // the customer account that owns this order.
    await customerPage.goto(`/orders/${orderId}/confirmed`);
    await expect(
      customerPage.getByRole("link", {
        name: /Track this order in your account/i,
      }),
    ).toBeVisible();

    await customerPage.goto("/account");
    await expect(
      customerPage.getByRole("heading", { name: /Your orders/i }),
    ).toBeVisible();
    await customerPage.getByRole("link", { name: "Track order" }).click();
    await customerPage.waitForURL(
      new RegExp(`/account/orders/${orderId.replaceAll("-", "\\-")}$`),
    );
    await expect(
      customerPage.getByText("Cash on delivery").first(),
    ).toBeVisible();
    await expect(customerPage.getByText("Jollof Rice")).toBeVisible();
    await expect(customerPage.getByText("Order timeline")).toBeVisible();

    // The merchant can move the order through the real Studio UI, and the
    // signed-in customer sees the new status after refreshing their tracker.
    await page.goto(`/studio/orders/${orderId}`);
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Order ${orderId.slice(0, 8)}`),
      }),
    ).toBeVisible();
    await page.getByTestId("order-action-preparing").click();
    await expect(
      page.getByText("Preparing", { exact: true }).first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    await customerPage.reload();
    await expect(
      customerPage.getByText("Preparing", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      customerPage.getByText("The business is preparing your order."),
    ).toBeVisible();

    // A second real customer session receives the same not-found response for
    // this order as it would for a random ID; the owner scope is not UI-only.
    const otherCustomer = await seedCustomer("Other");
    const otherContext = await browser.newContext({ baseURL });
    await signInCustomer(otherContext, otherCustomer, baseURL!);
    const otherPage = await otherContext.newPage();
    const response = await otherPage.goto(`/account/orders/${orderId}`);
    expect(response?.status()).toBe(404);
    await expect(
      otherPage.getByText("This page could not be found"),
    ).toBeVisible();

    // An unauthenticated visitor is sent to customer login instead of seeing
    // whether this order exists.
    const anonymousContext = await browser.newContext({ baseURL });
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(`/account/orders/${orderId}`);
    await expect(anonymousPage).toHaveURL(/\/account\/login\?next=/);

    await anonymousContext.close();
    await otherContext.close();
    await customerContext.close();
  });
});
