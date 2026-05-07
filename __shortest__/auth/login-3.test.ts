import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', "fake@example.com");
  await page.fill('input[type="password"]', "wrongpass123");
  await page.click('button[type="submit"]', { force: true });
  await page.waitForTimeout(3000);
});

shortest("Check if any error message, toast notification, or alert is visible after attempting to log in with wrong credentials. Report what you see on the page");
