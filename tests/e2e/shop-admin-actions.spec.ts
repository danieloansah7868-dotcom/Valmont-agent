import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  SqliteChatStore,
  setSqliteChatStoreForTests,
} from "../../src/lib/chat-store";
import { createDefaultBrief } from "../../src/lib/studio/site-brief/defaults";
import { SqliteStudioDraftStore } from "../../src/lib/studio/draft-store";
import { starterBundleCatalogue } from "../../src/lib/studio/bundles";
import { SqliteOrdersStore } from "../../src/lib/studio/orders";
import { canonicalUserId } from "../../src/lib/user-identity";
import {
  dispatchBundleDeliveriesForOrder,
  SqliteBundleDeliveriesStore,
} from "../../src/lib/studio/bundle-delivery";
import { SqliteShopAdminStore } from "../../src/lib/shop-admin/store";

/**
 * Stage 6c — the shop's write actions, end to end.
 *
 * The 6b setup makes this cheap: the e2e server runs on the same throwaway
 * SQLite file this spec seeds, so the owner login is minted directly through
 * the store (the invite→accept flow is covered by `shop-admin.spec.ts`) and
 * the sign-in itself still goes through the real login form. The shop is a
 * Starter Shop, the engine therefore creates pending MANUAL rows for the paid
 * order with zero network calls, and the owner marks one delivered from the
 * order page.
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

test.describe("shop admin actions", () => {
  test("the owner signs in, marks a manual top-up delivered, sees Delivered", async ({
    page,
    context,
  }) => {
    const agency: StudioOwner = {
      id: `e2e-${uniqueSuffix("agency")}`,
      login: uniqueSuffix("agency"),
      name: "Agency User",
    };
    const password = "a very long shop password";

    // Seed a Starter bundle shop, a paid order, its manual rows (the real
    // engine pass — the plan makes every row manual and no fetch happens),
    // and an active owner login with a known password.
    const drafts = new SqliteStudioDraftStore();
    const shop = await drafts.create(
      agency,
      createDefaultBrief({
        businessName: `E2E Manual Shop ${agency.login}`,
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
    const bundle = starterBundleCatalogue().find(
      (item) => item.bundle?.network === "mtn",
    )!;
    const order = await new SqliteOrdersStore().create({
      ownerId: canonicalUserId(agency),
      draftId: shop.id,
      accessCode: `e2e-${randomBytes(12).toString("hex")}`,
      status: "paid",
      currency: "GHS",
      subtotal: bundle.price ?? 10,
      deliveryFee: 0,
      total: bundle.price ?? 10,
      lines: [
        {
          itemId: bundle.id,
          name: bundle.name,
          price: bundle.price ?? 10,
          quantity: 2,
          bundle: bundle.bundle,
        },
      ],
      customerName: "Kwame Buyer",
      customerPhone: "0200000002",
      recipientPhone: "0240000001",
      paymentMethod: "valmont_pay",
      paymentMode: "live",
    });
    const rows = await dispatchBundleDeliveriesForOrder(order.id, {
      deliveries: new SqliteBundleDeliveriesStore(),
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.provider === "manual")).toBe(true);

    const ownerEmail = `owner-${uniqueSuffix("mail")}@example.com`;
    const admins = new SqliteShopAdminStore();
    const invite = await admins.createOwnerInvite({
      draftId: shop.id,
      email: ownerEmail,
      name: "Kofi Mensah",
      invitedBy: canonicalUserId(agency),
    });
    const owner = await admins.acceptInvite(
      invite.token,
      "Kofi Mensah",
      password,
    );
    expect(owner?.status).toBe("active");

    // Sign in through the real form (no agency cookies in this browser).
    await context.clearCookies();
    await page.goto(`/manage/${shop.id}/login`);
    await page.getByTestId("shop-login-email").fill(ownerEmail);
    await page.getByTestId("shop-login-password").fill(password);
    await page.getByTestId("shop-login-submit").click();
    await expect(page).toHaveURL(new RegExp(`/manage/${shop.id}$`));

    // Open the order: the manual rows wait "To send by hand".
    await page.goto(`/manage/${shop.id}/orders/${order.id}`);
    await expect(page.getByTestId("shop-order-recipient")).toHaveText(
      "0240000001",
    );
    await expect(page.getByText("To send by hand")).toHaveCount(2);
    // Starter: no Retry button, ever.
    await expect(page.getByTestId("shop-retry-deliveries")).toHaveCount(0);

    // Mark the first pending row delivered.
    await page
      .getByTestId("shop-delivery-pending")
      .first()
      .getByTestId("shop-mark-delivered")
      .click();

    // The row settles to Delivered and one manual row remains.
    await expect(page.getByTestId("shop-delivery-delivered")).toHaveCount(1);
    await expect(page.getByTestId("shop-delivery-pending")).toHaveCount(1);
    await expect(page.getByText("To send by hand")).toHaveCount(1);
    // The delivered row offers no buttons at all (delivered is terminal).
    await expect(
      page
        .getByTestId("shop-delivery-delivered")
        .getByTestId("shop-mark-delivered"),
    ).toHaveCount(0);
  });
});
