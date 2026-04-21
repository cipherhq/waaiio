import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_ADMIN_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_ADMIN_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Click on the first business in the list and verify a detail view opens showing business information, subscription status, and management options");
