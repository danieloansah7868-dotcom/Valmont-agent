import { test, expect } from "@playwright/test";
test("studio smoke", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByText("Website Studio")).toBeVisible();
});
