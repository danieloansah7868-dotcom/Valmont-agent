import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  getSqliteChatStore,
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "../../src/lib/chat-store";
import { encryptSessionValue } from "../../src/lib/security";
import { createDefaultBrief } from "../../src/lib/studio/site-brief/defaults";
import { SqliteStudioDraftStore } from "../../src/lib/studio/draft-store";
import { starterBundleCatalogue } from "../../src/lib/studio/bundles";
import { SqliteOrdersStore } from "../../src/lib/studio/orders";
import { SqliteBundleDeliveriesStore } from "../../src/lib/studio/bundle-delivery";
import { SqliteIntegrationsStore } from "../../src/lib/studio/integrations";
import { canonicalUserId } from "../../src/lib/user-identity";
import { SqliteShopAdminStore } from "../../src/lib/shop-admin/store";

/**
 * Stage 6d — the Supplier page and the Reports page, end to end, offline.
 *
 * The 6c e2e setup makes this cheap: the server runs on the same throwaway
 * SQLite file this spec seeds, so the owner login is minted directly through
 * the store and the sign-in goes through the real form. The shop is a
 * Command Center shop whose connection row is inserted directly (an encrypted
 * key envelope the server can read, a verified status, a known balance) — no
 * probe, no fetch, no TechChief. The page itself never calls TechChief, so
 * the whole flow stays offline by construction.
 *
 * Covered:
 *  - the signed-in owner sees the Supplier and Reports nav links;
 *  - the Supplier page shows the wallet balance, the status pill, the
 *    9-character key prefix, the requests-this-hour line, the bundle count
 *    and the second-supplier (backup) card — and nothing of the key or the
 *    webhook URL;
 *  - the Reports page shows the tiles and network table computed from the
 *    seeded order + delivery rows, with zero customer identifiers;
 *  - a Starter shop owner sees neither nav link and gets a 404 on /supplier.
 */

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

async function seedOwner(
  drafts: SqliteStudioDraftStore,
  shopId: string,
  email: string,
  password: string,
) {
  const admins = new SqliteShopAdminStore();
  const invite = await admins.createOwnerInvite({
    draftId: shopId,
    email,
    name: "Kofi Mensah",
    invitedBy: canonicalUserId({
      id: "e2e-agency",
      login: "e2e",
      name: "Agency",
    }),
  });
  const owner = await admins.acceptInvite(
    invite.token,
    "Kofi Mensah",
    password,
  );
  if (!owner || owner.status !== "active")
    throw new Error("owner should have been accepted");
  return owner;
}

async function signIn(
  page: import("@playwright/test").Page,
  shopId: string,
  email: string,
  password: string,
) {
  await page.goto(`/manage/${shopId}/login`);
  await page.getByTestId("shop-login-email").fill(email);
  await page.getByTestId("shop-login-password").fill(password);
  await page.getByTestId("shop-login-submit").click();
  await expect(page).toHaveURL(new RegExp(`/manage/${shopId}$`));
}

test.describe("shop admin supplier + reports", () => {
  test("a Command Center owner sees the Supplier page and the Reports page", async ({
    page,
    context,
  }) => {
    const agency: StudioOwner = {
      id: `e2e-${uniqueSuffix("agency")}`,
      login: uniqueSuffix("agency"),
      name: "Agency User",
    };
    const password = "a very long shop password";

    const drafts = new SqliteStudioDraftStore();
    const shop = await drafts.create(
      agency,
      createDefaultBrief({
        businessName: `E2E Supplier Shop ${agency.login}`,
        category: "data-bundles",
        selectedTemplate: "bundle-shop",
        plan: "command_center",
        adminEmail: `${agency.login}@example.com`,
        phone: "+233240000000",
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

    // A verified TechChief connection, inserted directly (no probe): the
    // server can read the encrypted key envelope, the prefix is the stored
    // 9 characters, and the balance is known without any TechChief call.
    const now = new Date().toISOString();
    await new SqliteIntegrationsStore().insert({
      draftId: shop.id,
      ownerId: canonicalUserId(agency),
      provider: "techchief",
      apiKeyEnc: encryptSessionValue("TCHX-Ab12Cd34Ef56Gh78"),
      keyPrefix: "TCHX-AB12",
      webhookSecretEnc: null,
      status: "verified",
      lastCheckedAt: now,
      walletBalance: 42.5,
      lowBalance: false,
      accountStatus: "active",
      lastError: null,
      bundles: [
        {
          id: 11,
          network: "MTN",
          sizeGb: 1,
          validityDays: 7,
          price: 8.5,
          currency: "GHS",
        },
      ],
      bundlesSyncedAt: now,
      pollWindowStart: null,
      pollCount: 0,
    });

    // One live order and one delivered unit with a supplier cost — the
    // report data. The order starts pending and is paid through markPaid()
    // (the same store call the real payment webhook uses), which is what
    // sets status "paid" AND paid_at — a sale in the report needs paidAt
    // set. The delivery row is written straight into the store; no engine
    // pass runs, so no TechChief call happens.
    const bundle = starterBundleCatalogue().find(
      (item) => item.bundle?.network === "mtn",
    )!;
    const orders = new SqliteOrdersStore();
    const order = await orders.create({
      ownerId: canonicalUserId(agency),
      draftId: shop.id,
      accessCode: `e2e-${randomBytes(12).toString("hex")}`,
      status: "pending",
      currency: "GHS",
      subtotal: bundle.price ?? 10,
      deliveryFee: 0,
      total: bundle.price ?? 10,
      lines: [
        {
          itemId: bundle.id,
          name: bundle.name,
          price: bundle.price ?? 10,
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
    const paid = await orders.markPaid(order.accessCode, "e2e-ref");
    if (!paid || paid.status !== "paid" || !paid.paidAt)
      throw new Error("order should have been paid through markPaid");
    const deliveries = new SqliteBundleDeliveriesStore();
    const [row] = await deliveries.createMany([
      {
        orderId: order.id,
        ownerId: order.ownerId,
        lineIndex: 0,
        unitIndex: 0,
        itemId: bundle.id,
        itemName: bundle.name,
        network: bundle.bundle?.network ?? "mtn",
        dataMb: bundle.bundle?.dataMb ?? 1024,
        validity: bundle.bundle?.validity ?? "7 days",
        recipientPhone: "0240000001",
        provider: "techchief",
      },
    ]);
    if (!row) throw new Error("delivery row should exist");
    await deliveries.claimForDispatch(row.id, { provider: "techchief" });
    await deliveries.setProviderRef(row.id, "DEV-E2E-1", { apiPrice: 4.5 });
    const db = getSqliteChatStore().connection;
    db.prepare(
      "UPDATE studio_deliveries SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, row.id);

    const ownerEmail = `owner-${uniqueSuffix("mail")}@example.com`;
    await seedOwner(drafts, shop.id, ownerEmail, password);
    await context.clearCookies();
    await signIn(page, shop.id, ownerEmail, password);

    // The header offers both new links to a Command Center owner.
    await expect(page.getByTestId("shop-admin-supplier-link")).toBeVisible();
    await expect(page.getByTestId("shop-admin-reports-link")).toBeVisible();

    // ---- Supplier page -----------------------------------------------------
    await page.goto(`/manage/${shop.id}/supplier`);
    await expect(page.getByTestId("shop-supplier-balance")).toHaveText(
      "GHS 42.50",
    );
    await expect(page.getByTestId("shop-supplier-status")).toHaveText(
      "Connected",
    );
    await expect(page.getByTestId("shop-supplier-key-prefix")).toHaveText(
      "TCHX-AB12•••",
    );
    await expect(page.getByTestId("shop-supplier-requests")).toHaveText(
      "Requests used this hour: 0 of 60",
    );
    await expect(page.getByTestId("shop-supplier-bundles")).toHaveText(
      /1 available/,
    );
    await expect(page.getByTestId("shop-supplier-refresh")).toBeVisible();
    await expect(page.getByTestId("shop-supplier-topup-link")).toBeVisible();
    // The Command Center-only backup card exists.
    await expect(page.getByTestId("shop-supplier-second")).toBeVisible();
    await expect(page.getByTestId("shop-supplier-low-balance")).toHaveCount(0);

    // Nothing of the key beyond the prefix, and no webhook URL, on the page.
    const supplierText = await page.locator("body").innerText();
    expect(supplierText).not.toContain("Ab12Cd34Ef56Gh78");
    expect(supplierText).not.toContain("webhook");
    expect(supplierText).not.toContain("apiKey");

    // ---- Reports page ------------------------------------------------------
    await page.goto(`/manage/${shop.id}/reports`);
    await expect(
      page.getByRole("heading", { name: "Sales & margin" }),
    ).toBeVisible();
    await expect(page.getByTestId("shop-reports-orders")).toHaveText("1");
    await expect(page.getByTestId("shop-reports-revenue")).toHaveText(
      "GH₵10.00",
    );
    await expect(page.getByTestId("shop-reports-cost")).toHaveText("GH₵4.50");
    await expect(page.getByTestId("shop-reports-margin")).toContainText(
      "GH₵5.50",
    );
    await expect(page.getByTestId("shop-reports-topups")).toHaveText(
      "Delivered 1 · Failed 0 · In flight 0",
    );
    await expect(page.getByTestId("shop-reports-cost-coverage")).toContainText(
      "Cost known for 1 of 1 delivered top-ups.",
    );
    // Range tabs work; 30 days is the default active range.
    await expect(page.getByTestId("shop-reports-range")).toHaveCount(4);
    await page
      .getByTestId("shop-reports-range")
      .filter({ hasText: "This month" })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/manage/${shop.id}/reports\\?range=month`),
    );
    // Still one order in this month.
    await expect(page.getByTestId("shop-reports-orders")).toHaveText("1");

    // The report body never shows a customer identifier.
    const reportsText = await page.locator("body").innerText();
    expect(reportsText).not.toContain("Kwame Buyer");
    expect(reportsText).not.toContain("0200000002");
    expect(reportsText).not.toContain("0240000001");
  });

  test("a Starter shop owner sees neither new nav link and /supplier is a 404", async ({
    page,
    context,
  }) => {
    const agency: StudioOwner = {
      id: `e2e-${uniqueSuffix("agency")}`,
      login: uniqueSuffix("agency"),
      name: "Agency User",
    };
    const password = "a very long shop password";
    const drafts = new SqliteStudioDraftStore();
    const shop = await drafts.create(
      agency,
      createDefaultBrief({
        businessName: `E2E Starter Shop ${agency.login}`,
        category: "data-bundles",
        selectedTemplate: "bundle-shop",
        plan: "starter",
        adminEmail: `${agency.login}@example.com`,
        phone: "+233240000000",
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
    const ownerEmail = `owner-${uniqueSuffix("mail")}@example.com`;
    await seedOwner(drafts, shop.id, ownerEmail, password);
    await context.clearCookies();
    await signIn(page, shop.id, ownerEmail, password);

    // No Supplier and no Reports links for a Starter owner.
    await expect(page.getByTestId("shop-admin-supplier-link")).toHaveCount(0);
    await expect(page.getByTestId("shop-admin-reports-link")).toHaveCount(0);

    // The page itself does not exist on Starter.
    await page.goto(`/manage/${shop.id}/supplier`);
    await expect(page.getByText("This page could not be found")).toBeVisible();

    await page.goto(`/manage/${shop.id}/reports`);
    await expect(page.getByText("This page could not be found")).toBeVisible();
  });
});
