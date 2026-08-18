import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { encryptSessionValue } from "../../src/lib/security";

/**
 * These tests sign in the way the real app does: an encrypted `valmont_session`
 * cookie produced with the server's own `SESSION_SECRET`. There is no test-only
 * bypass in application code.
 */
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error("SESSION_SECRET must be set for the e2e tests.");

const ownerA = { id: "e2e-9001", login: "owner-a", name: "Owner A" };
const ownerB = { id: "e2e-9002", login: "owner-b", name: "Owner B" };

function sessionCookieValue(user: typeof ownerA): string {
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

// Every API rate-limit bucket is keyed by x-forwarded-for, falling back to one
// shared "local" bucket. Without a distinct key per test, a whole e2e run would
// exhaust the in-memory mutation budget in a single window. Each test therefore
// carries its own synthetic client address; the limiter itself is still
// exercised on every single request. This is test-side only — no production
// code path is weakened.
let rateLimitKeyCounter = 0;

async function signIn(
  context: BrowserContext,
  user: typeof ownerA,
  baseURL: string,
): Promise<string> {
  // A freshly generated CSRF token per run, never a fixed string.
  const csrf = randomBytes(16).toString("hex");
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: "valmont_session",
      value: sessionCookieValue(user),
      domain: url.hostname,
      path: "/",
    },
    { name: "valmont_csrf", value: csrf, domain: url.hostname, path: "/" },
  ]);
  rateLimitKeyCounter += 1;
  const clientKey = `127.0.0.${(rateLimitKeyCounter % 253) + 2}`;
  await context.route("**/api/**", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "x-forwarded-for": clientKey,
      },
    });
  });
  return csrf;
}

async function createDraft(page: Page, businessName: string): Promise<string> {
  await page.goto("/studio");
  await page.getByTestId("start-new-website").click();
  await page.getByLabel(/Business name/i).fill(businessName);
  await page.getByTestId("create-draft").click();
  await page.waitForURL(/\/studio\/drafts\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}

test.describe("Website Studio", () => {
  test("create a draft, complete every step, and autosave business details", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);

    await page.goto("/studio");
    await expect(
      page.getByRole("heading", { name: /Website Studio/i }),
    ).toBeVisible();

    const draftId = await createDraft(page, "Adom Fashion House");

    // Step 1 — website type, including the shop sub-type.
    await page.getByRole("button", { name: /1\. Website type/i }).click();
    await page.getByLabel(/Website type/i).selectOption("online-shop");
    await expect(page.getByLabel(/What does the shop sell/i)).toBeVisible();
    await page.getByLabel(/What does the shop sell/i).selectOption("fashion");
    await page.getByLabel(/Website type/i).selectOption("business-profile");

    // Step 2 — package.
    await page.getByRole("button", { name: /2\. Package/i }).click();
    await page
      .getByRole("radio", { name: /Business/i })
      .first()
      .check();

    // Step 3 — theme and layout.
    await page.getByRole("button", { name: /3\. Look and layout/i }).click();
    await page.getByRole("radio", { name: /Luxury/i }).check();
    await expect(page.getByRole("radio", { name: /Luxury/i })).toBeChecked();

    // Step 4 — business information, then wait for the autosave to land.
    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await page.getByLabel(/Admin email/i).fill("owner@adom.example");
    await page.getByLabel(/Phone number/i).fill("0201234567");
    await page.getByLabel(/^Tagline$/i).fill("Style that fits");

    // The country, currency and timezone controls are exposed and default to
    // Ghana, GHS and Africa/Accra, with supported alternatives selectable.
    await expect(page.getByLabel(/^Country$/i)).toHaveValue("Ghana");
    await expect(page.getByLabel(/^Currency$/i)).toHaveValue("GHS");
    await expect(page.getByLabel(/^Timezone$/i)).toHaveValue("Africa/Accra");
    await page.getByLabel(/^Currency$/i).selectOption("NGN");
    await page.getByLabel(/^Timezone$/i).selectOption("Africa/Lagos");
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      { timeout: 15_000 },
    );
    await expect(page.getByLabel(/^Currency$/i)).toHaveValue("NGN");
    await page.getByLabel(/^Currency$/i).selectOption("GHS");
    await page.getByLabel(/^Timezone$/i).selectOption("Africa/Accra");

    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      { timeout: 15_000 },
    );

    // Ghana defaults are applied to the phone number.
    await expect(page.getByLabel(/Phone number/i)).toHaveValue("+233201234567");

    // Reopen the draft in a brand-new page: the details must still be there.
    const reopened = await context.newPage();
    await reopened.goto(`/studio/drafts/${draftId}`);
    await reopened
      .getByRole("button", { name: /4\. Business details/i })
      .click();
    await expect(reopened.getByLabel(/Business name/i)).toHaveValue(
      "Adom Fashion House",
    );
    await expect(reopened.getByLabel(/Admin email/i)).toHaveValue(
      "owner@adom.example",
    );
    await expect(reopened.getByLabel(/^Tagline$/i)).toHaveValue(
      "Style that fits",
    );
    await reopened.close();
  });

  test("changing the theme keeps every business detail", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    const draftId = await createDraft(page, "Kofi Motors");

    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await page.getByLabel(/Admin email/i).fill("kofi@motors.example");
    await page.getByLabel(/Address/i).fill("12 Oxford Street, Osu");
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      {
        timeout: 15_000,
      },
    );

    // Switch the theme, then the package, then the website type.
    await page.getByRole("button", { name: /3\. Look and layout/i }).click();
    await page.getByRole("radio", { name: /Luxury/i }).check();
    await page.getByRole("button", { name: /2\. Package/i }).click();
    await page.getByRole("radio", { name: /Empire/i }).check();
    await page.getByRole("button", { name: /1\. Website type/i }).click();
    await page.getByLabel(/Website type/i).selectOption("online-shop");

    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      {
        timeout: 15_000,
      },
    );

    // Reload from the server and confirm nothing was lost.
    await page.goto(`/studio/drafts/${draftId}`);
    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await expect(page.getByLabel(/Business name/i)).toHaveValue("Kofi Motors");
    await expect(page.getByLabel(/Admin email/i)).toHaveValue(
      "kofi@motors.example",
    );
    await expect(page.getByLabel(/Address/i)).toHaveValue(
      "12 Oxford Street, Osu",
    );
  });

  test("shows brief completeness and a preview of the real details", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    await createDraft(page, "Adom Fashion House");

    await expect(page.getByTestId("completeness-score")).toBeVisible();
    await expect(page.getByTestId("completeness-score")).toHaveText(/\d+%/);
    await expect(page.getByRole("progressbar")).toBeVisible();

    // Missing required information is named before anything is complete.
    await expect(page.getByTestId("missing-required")).toBeVisible();

    const preview = page.getByTestId("business-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Adom Fashion House");

    // Filling a required field raises the score.
    const before = await page.getByTestId("completeness-score").textContent();
    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await page.getByLabel(/Admin email/i).fill("owner@adom.example");
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      {
        timeout: 15_000,
      },
    );
    await expect(page.getByTestId("completeness-score")).not.toHaveText(
      before ?? "",
    );
  });

  test("the preview shows text as typed, without running it", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    await createDraft(page, "Safe Preview Test");

    let dialogAppeared = false;
    page.on("dialog", async (dialog) => {
      dialogAppeared = true;
      await dialog.dismiss();
    });

    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await page
      .getByLabel(/What does the business do/i)
      .fill('<img src=x onerror="alert(1)">');
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      {
        timeout: 15_000,
      },
    );

    const preview = page.getByTestId("business-preview");
    await expect(preview).toContainText("<img src=x");
    await expect(preview.locator("img")).toHaveCount(0);
    expect(dialogAppeared).toBe(false);
  });

  test("can be used with the keyboard and has labelled controls", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    await createDraft(page, "Keyboard Test");

    await page.getByRole("button", { name: /4\. Business details/i }).click();

    const nameField = page.getByLabel(/Business name/i);
    await nameField.focus();
    await expect(nameField).toBeFocused();

    // Tab moves to the next control and it is a real, reachable element.
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();

    // Typing with the keyboard alone edits and saves the draft.
    await nameField.focus();
    await nameField.press("Control+a");
    await page.keyboard.type("Typed With Keyboard");
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      {
        timeout: 15_000,
      },
    );

    // Every form control on this step has an accessible name.
    const controls = await page
      .locator("main input, main select, main textarea")
      .all();
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const [id, ariaLabel, ariaLabelledBy] = await Promise.all([
        control.getAttribute("id"),
        control.getAttribute("aria-label"),
        control.getAttribute("aria-labelledby"),
      ]);
      const hasLabelElement = id
        ? (await page.locator(`label[for="${id}"]`).count()) > 0
        : false;
      const wrappedInLabel =
        (await control.locator("xpath=ancestor::label").count()) > 0;
      expect(
        hasLabelElement || wrappedInLabel || !!ariaLabel || !!ariaLabelledBy,
      ).toBe(true);
    }

    // The live save state is announced to screen readers.
    await expect(page.getByTestId("save-state")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  test("no page scrolls sideways on any scheduled browser project", async ({
    page,
    context,
    baseURL,
  }) => {
    // Runs in every project (desktop-chromium and the iPhone viewport project):
    // a page that scrolls sideways on a 390px iPhone screen would be a real
    // layout failure, and on a desktop viewport it would be an obvious one too,
    // so the assertion is meaningful in both. There is no intentional skip.
    await signIn(context, ownerA, baseURL!);
    const draftId = await createDraft(page, "No Overflow Test");

    for (const path of ["/studio", `/studio/drafts/${draftId}`]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${path} scrolls sideways at ${overflow.innerWidth}px`,
      ).toBeLessThanOrEqual(overflow.innerWidth + 1);
    }
  });

  test("owner B gets the same not-found for owner A's draft as for a random id", async ({
    page,
    context,
    browser,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    const draftId = await createDraft(page, "Private To Owner A");

    // A completely separate browser context signed in as owner B.
    const contextB = await browser.newContext({ baseURL });
    const csrfB = await signIn(contextB, ownerB, baseURL!);
    const pageB = await contextB.newPage();

    const foreign = await pageB.request.get(`/api/studio/drafts/${draftId}`, {
      headers: { "x-valmont-csrf": csrfB },
    });
    const random = await pageB.request.get(
      "/api/studio/drafts/00000000-0000-4000-a000-000000000000",
      { headers: { "x-valmont-csrf": csrfB } },
    );

    expect(foreign.status()).toBe(404);
    expect(random.status()).toBe(404);
    expect(await foreign.json()).toEqual(await random.json());

    // The page owner B sees is the same generic panel in both cases.
    await pageB.goto(`/studio/drafts/${draftId}`);
    await expect(pageB.getByText(/Draft not found/i)).toBeVisible();
    await pageB.goto("/studio/drafts/00000000-0000-4000-a000-000000000000");
    await expect(pageB.getByText(/Draft not found/i)).toBeVisible();

    // Owner B's own studio does not list it.
    await pageB.goto("/studio");
    await expect(pageB.getByText("Private To Owner A")).toHaveCount(0);

    // Owner A's draft is untouched.
    await page.goto(`/studio/drafts/${draftId}`);
    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await expect(page.getByLabel(/Business name/i)).toHaveValue(
      "Private To Owner A",
    );

    await contextB.close();
  });

  test("a draft can be deleted and then no longer opens", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    const draftId = await createDraft(page, "Temporary Draft");

    // Deletion must ask first. Assert the confirmation really appears rather
    // than listening for a browser dialog that the UI never opens.
    await page.getByTestId("delete-draft").click();
    await expect(page.getByTestId("delete-confirm")).toBeVisible();

    // Backing out must leave the draft completely untouched.
    await page.getByTestId("delete-draft-cancel").click();
    await expect(page.getByTestId("delete-confirm")).toHaveCount(0);
    await page.goto(`/studio/drafts/${draftId}`);
    await expect(page.getByTestId("delete-draft")).toBeVisible();

    // Confirming deletes it for real.
    await page.getByTestId("delete-draft").click();
    await page.getByTestId("delete-draft-confirm").click();
    await page.waitForURL(/\/studio$/);
    await expect(page.getByText("Temporary Draft")).toHaveCount(0);

    await page.goto(`/studio/drafts/${draftId}`);
    await expect(page.getByText(/Draft not found/i)).toBeVisible();
  });

  test('two tabs: a real 409 keeps the latest typing when "Keep what is on this screen" is chosen', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    const draftId = await createDraft(page, "Conflict Draft");

    // Page B opens the same draft while it is still at revision 1.
    const pageB = await context.newPage();
    await pageB.goto(`/studio/drafts/${draftId}`);
    await pageB.getByRole("button", { name: /4\. Business details/i }).click();
    await expect(pageB.getByLabel(/Business name/i)).toHaveValue(
      "Conflict Draft",
    );

    // Page A edits the business name and its autosave commits first.
    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await page.getByLabel(/Business name/i).fill("Aroko Fresh Foods");
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      { timeout: 15_000 },
    );

    // Page B edits the SAME field. Its save carries the now-stale revision,
    // so the server returns a real 409 and the conflict choice appears.
    await pageB.getByLabel(/Business name/i).fill("Kofi Fresh Foods");
    await expect(pageB.getByTestId("conflict-banner")).toBeVisible({
      timeout: 15_000,
    });

    // The user keeps typing after the warning. Autosave must stay frozen:
    // the banner stays up, nothing is written, and the new text is preserved.
    await pageB.getByLabel(/^Tagline$/i).fill("Fresh from the farm daily");
    await pageB.waitForTimeout(1500);
    await expect(pageB.getByTestId("conflict-banner")).toBeVisible();
    await expect(pageB.getByTestId("save-state")).toHaveText(
      /Someone else edited/i,
    );

    // “Keep what is on this screen” must save the LATEST on-screen state —
    // including the text typed after the warning appeared.
    await pageB
      .getByRole("button", { name: /Keep what is on this screen/i })
      .click();
    await expect(pageB.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      { timeout: 15_000 },
    );

    // Reopening from the server proves the latest text persisted.
    const reopened = await context.newPage();
    await reopened.goto(`/studio/drafts/${draftId}`);
    await reopened
      .getByRole("button", { name: /4\. Business details/i })
      .click();
    await expect(reopened.getByLabel(/Business name/i)).toHaveValue(
      "Kofi Fresh Foods",
    );
    await expect(reopened.getByLabel(/^Tagline$/i)).toHaveValue(
      "Fresh from the farm daily",
    );
    await reopened.close();
    await pageB.close();
  });

  test("two tabs: accepting the server version after a 409 keeps the other tab's text", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, ownerA, baseURL!);
    const draftId = await createDraft(page, "Server Wins Draft");

    const pageB = await context.newPage();
    await pageB.goto(`/studio/drafts/${draftId}`);
    await pageB.getByRole("button", { name: /4\. Business details/i }).click();

    // Page A saves first; page B then edits the same field and gets a real 409.
    await page.getByRole("button", { name: /4\. Business details/i }).click();
    await page.getByLabel(/Business name/i).fill("Server Side Name");
    await expect(page.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
      { timeout: 15_000 },
    );

    await pageB.getByLabel(/Business name/i).fill("Local Side Name");
    await expect(pageB.getByTestId("conflict-banner")).toBeVisible({
      timeout: 15_000,
    });

    // Choosing the other version replaces the screen with the server's copy.
    await pageB
      .getByRole("button", { name: /Use the other version instead/i })
      .click();
    await expect(pageB.getByLabel(/Business name/i)).toHaveValue(
      "Server Side Name",
    );
    await expect(pageB.getByTestId("save-state")).toHaveText(
      /All changes saved/i,
    );

    // Reopening proves the server version won and the local edit was dropped.
    const reopened = await context.newPage();
    await reopened.goto(`/studio/drafts/${draftId}`);
    await reopened
      .getByRole("button", { name: /4\. Business details/i })
      .click();
    await expect(reopened.getByLabel(/Business name/i)).toHaveValue(
      "Server Side Name",
    );
    await reopened.close();
    await pageB.close();
  });
});
