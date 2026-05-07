import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_DASHBOARD_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_DASHBOARD_PASSWORD!);
  await page.click('button:has-text("Sign In")');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Verify the dashboard page has loaded successfully after login");
