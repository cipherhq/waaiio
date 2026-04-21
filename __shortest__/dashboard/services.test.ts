import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_DASHBOARD_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_DASHBOARD_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Navigate to the Services section and verify it shows a list of services or an add service form with fields for service name, duration, and price");
