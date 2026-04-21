import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_DASHBOARD_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_DASHBOARD_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Verify the dashboard header shows the business name or user name and has a profile/account dropdown");
