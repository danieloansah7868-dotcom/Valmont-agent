import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { encryptSessionValue } from "../../src/lib/security";

/**
 * The Brand kit card has an AI half (four questions, then suggestions) and an
 * offline half ("Design the logo yourself": icon, font, three layouts, upload,
 * brand sheet). The offline half must survive a degraded model provider — the
 * 429s and slow timeouts that make "Suggest a brand" useless — because none of
 * it touches the model. This spec runs with no MODEL_API_KEY configured at
 * all, which is the same shape of failure: a suggest that answers 503 and a
 * card that must still let the agency produce a logo.
 *
 * Authentication is the real thing: an encrypted `valmont_session` cookie
 * produced with the server's own SESSION_SECRET, exactly as studio-smoke does.
 */
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("SESSION_SECRET (32+ characters) must be set for e2e tests.");
}

type StudioOwner = { id: string; login: string; name: string };

let sequence = 0;

function nextOwner(): StudioOwner {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}-${randomBytes(4).toString("hex")}`;
  return {
    id: `e2e-brand-kit-${suffix}`,
    login: `brand-kit-owner-${suffix}`,
    name: `Brand Kit Owner ${suffix}`,
  };
}

async function signIn(
  context: BrowserContext,
  user: StudioOwner,
  baseURL: string,
): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: "valmont_session",
      value: encryptSessionValue(
        JSON.stringify({
          accessToken: "e2e-access-token",
          id: user.id,
          login: user.login,
          name: user.name,
          avatarUrl: "",
          expiresAt: Date.now() + 3_600_000,
        }),
        SECRET!,
      ),
      domain: url.hostname,
      path: "/",
    },
    {
      name: "valmont_csrf",
      value: randomBytes(16).toString("hex"),
      domain: url.hostname,
      path: "/",
    },
  ]);
}

async function createDraft(page: Page, businessName: string): Promise<void> {
  await page.goto("/studio");
  await page.getByTestId("start-new-website").click();
  await page.getByLabel(/Business name/i).fill(businessName);
  await page.getByTestId("create-draft").click();
  await page.waitForURL(/\/studio\/drafts\/[0-9a-f-]{36}$/);
}

test.describe("Brand kit — the DIY logo tools", () => {
  test("stay reachable and can produce a logo while the model provider is down", async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, nextOwner(), baseURL!);
    await createDraft(page, "Adom Fashion House");

    await page.getByTestId("brand-kit-open").click();
    // Scoped to the card: Next's route announcer is also role="alert".
    const card = page.getByRole("region", { name: "Brand Kit" });
    await expect(card).toBeVisible();

    // The AI half fails — with no key configured, exactly as it does when the
    // provider is degraded — and the failure copy carries the one sentence
    // that tells the agency the logo tools are still usable.
    await card
      .getByLabel(/What does the business sell or do/i)
      .fill("Fresh kenkey and fish");
    await card.getByLabel(/Which town is it based in/i).fill("Koforidua");
    await card.getByTestId("brand-kit-suggest").click();
    await expect(card.getByRole("status")).toContainText(
      /logo tools below still work without the AI/i,
    );
    await expect(card.getByText("Name ideas")).toHaveCount(0);
    // The questions step aside; nothing else does.
    await expect(card.getByTestId("brand-kit-suggest")).toHaveCount(0);

    // Everything offline is still there, and says so.
    const diy = page.getByTestId("brand-kit-diy");
    await expect(diy).toBeVisible();
    await expect(diy).toContainText("Design the logo yourself");
    await expect(page.getByTestId("brand-logo-icon")).toBeVisible();
    await expect(page.getByTestId("brand-logo-font")).toBeVisible();
    await expect(page.getByTestId("upload-custom-logo")).toBeVisible();

    // The three previews render, from the brief's own name and theme colours.
    const wordmark = page.getByTestId("brand-logo-preview-wordmark");
    await expect(wordmark).toHaveAttribute("src", /layout=wordmark/);
    await expect(wordmark).toHaveAttribute("src", /name=Adom\+Fashion\+House/);
    await expect(page.getByTestId("brand-logo-preview-badge")).toBeVisible();
    await expect(page.getByTestId("brand-logo-preview-stacked")).toBeVisible();
    const src = await wordmark.getAttribute("src");
    const svg = await page.request.get(new URL(src!, baseURL!).toString());
    expect(svg.ok()).toBe(true);
    expect(await svg.text()).toContain("<svg");

    // Choosing an icon and a font redraws every preview without any AI.
    await page.getByTestId("brand-logo-icon").selectOption("fish");
    await page.getByTestId("brand-logo-font").selectOption("classic");
    await expect(wordmark).toHaveAttribute("src", /icon=fish/);
    await expect(wordmark).toHaveAttribute("src", /font=classic/);
    await expect(
      page.getByTestId("brand-logo-preview-stacked"),
    ).toHaveAttribute("src", /icon=fish/);

    // Saving one layout stores a logo in the draft — still no model call.
    await page.getByTestId("brand-logo-badge").click();
    await expect(page.getByTestId("custom-logo-preview")).toBeVisible();
    await expect(page.getByTestId("upload-custom-logo")).toContainText(
      "Replace logo",
    );
    await expect(page.getByTestId("remove-custom-logo")).toBeVisible();

    // Reopening the draft renders that saved logo straight from stored state,
    // with the DIY tools still in place.
    await page.reload();
    await page.getByTestId("brand-kit-open").click();
    await expect(page.getByTestId("custom-logo-preview")).toBeVisible();
    await expect(page.getByTestId("remove-custom-logo")).toBeVisible();
    await expect(page.getByTestId("brand-kit-diy")).toBeVisible();
    await expect(page.getByTestId("brand-logo-preview-wordmark")).toBeVisible();

    // Removing it leaves the tools exactly where they were.
    await page.getByTestId("remove-custom-logo").click();
    await expect(page.getByTestId("custom-logo-preview")).toHaveCount(0);
    await expect(page.getByTestId("brand-kit-diy")).toBeVisible();
  });
});
