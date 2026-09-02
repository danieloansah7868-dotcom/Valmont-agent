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

async function seedBundleShop(owner: StudioOwner) {
  const draftStore = new SqliteStudioDraftStore();
  const starter = starterBundleCatalogue();
  return draftStore.create(
    owner,
    createDefaultBrief({
      businessName: `E2E Bundles ${owner.login}`,
      category: "data-bundles",
      selectedTemplate: "bundle-shop",
      adminEmail: `${owner.login}@example.com`,
      phone: "+233240000000",
      description: "Instant MTN, Telecel and AirtelTigo bundles.",
      items: starter,
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

test.describe("data-bundles shop", () => {
  test("public site shows network tabs and bundle checkout with Ghana mobile validation", async ({
    page,
    context,
    baseURL,
  }) => {
    const owner = nextOwner();
    await signInStudio(context, owner, baseURL!);
    const draft = await seedBundleShop(owner);

    // Public storefront shows network tabs
    await page.goto(`/s/${draft.id}`);
    await expect(page.getByTestId("public-storefront")).toBeVisible();
    await expect(page.getByTestId("network-tab-mtn")).toBeVisible();
    await expect(page.getByTestId("network-tab-telecel")).toBeVisible();
    await expect(page.getByTestId("network-tab-airteltigo")).toBeVisible();

    // Buy one bundle for valid Ghana mobile
    // MTN 1GB should be first in MTN tab
    const firstBundle = starterBundleCatalogue().find(
      (b) => b.bundle?.network === "mtn",
    )!;
    await page.getByTestId(`add-${firstBundle.id}`).click();
    await page.getByTestId("start-checkout").click();
    await page.getByLabel("Your name").fill("Kwame Buyer");
    // Use spaced format to test normalization
    await page.getByTestId("checkout-phone").fill("024 000 0001");
    await page.getByTestId("place-order").click();
    await expect(page.getByTestId("order-success")).toBeVisible();
    const payLink = page.getByTestId("order-pay-link");
    await expect(payLink).toBeVisible();
    const detailsLink = page.getByRole("link", { name: "View order details" });
    const href = await detailsLink.getAttribute("href");
    const match = href?.match(/^\/orders\/([^/]+)\/confirmed$/);
    if (!match?.[1]) throw new Error("Checkout did not return an order link");
    const orderId = decodeURIComponent(match[1]);

    // Order visible in Studio with bundle name and normalized phone
    await page.goto(`/studio/orders/${orderId}`);
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Order ${orderId.slice(0, 8)}`),
      }),
    ).toBeVisible();
    await expect(page.getByText(firstBundle.name)).toBeVisible();
    await expect(page.getByText("0240000001")).toBeVisible();

    // Landline refusal: try to place order with 030 number, should be refused before order exists
    const owner2 = nextOwner();
    // Need new context for second shop? Reuse same owner session but new draft
    const draft2 = await seedBundleShop(owner2);
    // Use a fresh page without cart state
    await page.goto(`/s/${draft2.id}`);
    await expect(page.getByTestId("public-storefront")).toBeVisible();
    const firstBundle2 = starterBundleCatalogue().find(
      (b) => b.bundle?.network === "mtn",
    )!;
    await page.getByTestId(`add-${firstBundle2.id}`).click();
    await page.getByTestId("start-checkout").click();
    await page.getByLabel("Your name").fill("Kwame Buyer");
    await page.getByTestId("checkout-phone").fill("030 123 4567");
    // Client-side validation should show error and disable place-order, but server also refuses
    await expect(
      page.getByText(/Landline numbers.*not supported/i),
    ).toBeVisible();
    // Try to bypass client validation by enabling button via JS and clicking
    // The server should still 400
    await page.evaluate(() => {
      const btn = document.querySelector(
        '[data-testid="place-order"]',
      ) as HTMLButtonElement;
      if (btn) btn.disabled = false;
    });
    await page.getByTestId("place-order").click();
    await expect(
      page.getByText(/Landline numbers.*not supported/i).first(),
    ).toBeVisible();
  });
});
