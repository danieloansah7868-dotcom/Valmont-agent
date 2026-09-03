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

async function seedRestaurantWithDelivery(owner: StudioOwner) {
  const draftStore = new SqliteStudioDraftStore();
  return draftStore.create(
    owner,
    createDefaultBrief({
      businessName: `E2E Restaurant ${owner.login}`,
      category: "restaurant",
      adminEmail: `${owner.login}@example.com`,
      phone: "+233240000000",
      description: "Tasty meals",
      items: [
        { id: "jollof-rice", name: "Jollof Rice", price: 30 },
        { id: "fried-rice", name: "Fried Rice", price: 35 },
      ],
      payments: {
        enabled: true,
        methods: ["cod"],
        valmontPay: { provisioned: false },
        delivery: { enabled: true, fee: 5, minimumOrder: 0 },
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
    request,
  }) => {
    const owner = nextOwner();
    await signInStudio(context, owner, baseURL!);
    const draft = await seedBundleShop(owner);

    await page.goto(`/s/${draft.id}`);
    await expect(page.getByTestId("public-storefront")).toBeVisible();
    await expect(page.getByTestId("network-tab-mtn")).toBeVisible();
    await expect(page.getByTestId("network-tab-telecel")).toBeVisible();
    await expect(page.getByTestId("network-tab-airteltigo")).toBeVisible();

    const firstBundle = starterBundleCatalogue().find(
      (b) => b.bundle?.network === "mtn",
    )!;
    await page.getByTestId(`add-${firstBundle.id}`).click();
    await expect(page.getByTestId("cart-bar")).toBeVisible();
    await page.getByTestId("start-checkout").click();
    await page.getByLabel("Your name").fill("Kwame Buyer");
    // Stage 3: recipient required, buyer optional
    await page.getByTestId("checkout-phone").fill("024 000 0001");
    await page.getByTestId("checkout-phone").blur();
    await expect(page.getByText(/Ghana mobiles only/)).toBeVisible();
    // Fill buyer number as different
    await page.getByTestId("checkout-buyer-phone").fill("020 000 0002");
    await page.getByTestId("checkout-buyer-phone").blur();
    await page.getByTestId("place-order").click();
    await expect(page.getByTestId("order-success")).toBeVisible();
    const payLink = page.getByTestId("order-pay-link");
    await expect(payLink).toBeVisible();
    // Read the simulator pay link now — after any page.goto the checkout
    // success screen is gone and this locator would never resolve again.
    const payHref = await payLink.getAttribute("href");
    const accessCode = payHref?.match(/^\/pay\/([0-9a-f]+)$/)?.[1];
    if (!accessCode) throw new Error("Checkout did not return a pay link");
    const detailsLink = page.getByRole("link", {
      name: "View order details",
    });
    const href = await detailsLink.getAttribute("href");
    const match = href?.match(/^\/orders\/([^/]+)\/confirmed$/);
    if (!match?.[1]) throw new Error("Checkout did not return an order link");
    const orderId = decodeURIComponent(match[1]);

    // The guest confirmation page needs no login, so it must never print a
    // full number: the recipient is masked and the buyer's contact is absent.
    await page.goto(`/orders/${orderId}/confirmed`);
    await expect(page.getByText(/Send to/)).toBeVisible();
    await expect(page.getByText("024 ••• 0001")).toBeVisible();
    await expect(page.getByText("0240000001")).toHaveCount(0);
    await expect(page.getByText("0200000002")).toHaveCount(0);
    await expect(page.getByText(/Contact:/)).toHaveCount(0);
    // Stage 4: unpaid order — no top-up line yet.
    await expect(page.getByTestId("bundle-delivery-line")).toHaveCount(0);

    // Complete the test-mode payment: the simulator's webhook call confirms
    // the order and fires the bundle delivery engine fire-and-forget.
    const payResponse = await request.post(
      `/api/payments/webhook?access_code=${accessCode}`,
      { data: { status: "success" } },
    );
    expect(payResponse.status()).toBe(200);

    // The guest page reconciles deliveries on load and shows one masked
    // aggregate line — still never a full number.
    await page.goto(`/orders/${orderId}/confirmed`);
    const topUpLine = page.getByTestId("bundle-delivery-line");
    await expect(topUpLine).toContainText("top-up");
    await expect(topUpLine).toContainText("024 ••• 0001");
    await expect(page.getByText("0240000001")).toHaveCount(0);
    await expect(page.getByText("0200000002")).toHaveCount(0);

    await page.goto(`/studio/orders/${orderId}`);
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Order ${orderId.slice(0, 8)}`),
      }),
    ).toBeVisible();
    await expect(page.getByText(firstBundle.name)).toBeVisible();
    // The owner's own page keeps the full numbers: recipient in the tel link
    // of the Customer section, buyer as Phone.
    await expect(page.getByRole("link", { name: "0240000001" })).toBeVisible();
    await expect(page.getByText(/Send to/)).toBeVisible();
    await expect(page.getByText("0200000002")).toBeVisible();
    // Stage 4: the paid bundle order shows the delivery panel; after one
    // reload the top-up is Delivered (recheck settles it on page load).
    const bundlePanel = page.getByTestId("bundle-delivery-panel");
    await expect(bundlePanel).toBeVisible();
    await page.reload();
    await expect(bundlePanel.getByText("Delivered")).toBeVisible();

    // Landline refusal — client shows error
    const owner2 = nextOwner();
    await signInStudio(context, owner2, baseURL!);
    const draft2 = await seedBundleShop(owner2);
    await page.goto(`/s/${draft2.id}`);
    await expect(page.getByTestId("public-storefront")).toBeVisible();
    const firstBundle2 = starterBundleCatalogue().find(
      (b) => b.bundle?.network === "mtn",
    )!;
    await page.getByTestId(`add-${firstBundle2.id}`).click();
    await expect(page.getByTestId("cart-bar")).toBeVisible();
    await page.getByTestId("start-checkout").click();
    await page.getByLabel("Your name").fill("Kwame Buyer");
    await page.getByTestId("checkout-phone").fill("030 123 4567");
    await page.getByTestId("checkout-phone").blur();
    await expect(
      page.getByText(/Landline numbers.*not supported/i),
    ).toBeVisible();

    // Server also refuses — direct POST bypassing client validation (recipientPhone required)
    const serverResp = await request.post(
      `/api/studio/drafts/${draft2.id}/checkout`,
      {
        data: {
          lines: [{ itemId: firstBundle2.id, quantity: 1 }],
          customerName: "Kwame Buyer",
          recipientPhone: "030 123 4567",
          customerPhone: "0200000002",
          paymentMethod: "valmont_pay",
        },
      },
    );
    expect(serverResp.status()).toBe(400);
    const body = await serverResp.json();
    expect(body.error).toMatch(/Landline numbers/i);
  });

  test("restaurant with delivery ON requires address and accepts 030 landline", async ({
    page,
    context,
    baseURL,
  }) => {
    const owner = nextOwner();
    await signInStudio(context, owner, baseURL!);
    const draft = await seedRestaurantWithDelivery(owner);

    await page.goto(`/s/${draft.id}`);
    await expect(page.getByTestId("public-storefront")).toBeVisible();
    await page.getByTestId("add-jollof-rice").click();
    await expect(page.getByTestId("cart-bar")).toBeVisible();
    await page.getByTestId("start-checkout").click();
    await page.getByLabel("Your name").fill("Ama Customer");
    await page.getByLabel("Phone number").fill("0301234567");
    // Address should be required and visible for restaurant with delivery
    await expect(page.getByLabel("Delivery address")).toBeVisible();
    // Try without address first — should show error
    await page.getByTestId("place-order").click();
    await expect(page.getByText(/delivery address/i)).toBeVisible();
    await page
      .getByLabel("Delivery address")
      .fill("12 Independence Ave, Accra");
    await page.getByTestId("place-order").click();
    await expect(page.getByTestId("order-success")).toBeVisible();

    const detailsLink = page.getByRole("link", {
      name: "View order details",
    });
    const href = await detailsLink.getAttribute("href");
    const match = href?.match(/^\/orders\/([^/]+)\/confirmed$/);
    if (!match?.[1]) throw new Error("Checkout did not return an order link");
    const orderId = decodeURIComponent(match[1]);

    await page.goto(`/studio/orders/${orderId}`);
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Order ${orderId.slice(0, 8)}`),
      }),
    ).toBeVisible();
    // Address shown on order page
    await expect(page.getByText("12 Independence Ave, Accra")).toBeVisible();
    // 030 landline accepted for non-bundle shop
    await expect(page.getByText("0301234567")).toBeVisible();
    // Stage 4 regression: non-bundle orders get no delivery panel…
    await expect(page.getByTestId("bundle-delivery-panel")).toHaveCount(0);
    // …and no top-up line on the guest page.
    await page.goto(`/orders/${orderId}/confirmed`);
    await expect(page.getByTestId("bundle-delivery-line")).toHaveCount(0);
  });
});
