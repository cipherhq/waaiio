import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_DASHBOARD_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_DASHBOARD_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Find and click the sign out or logout button, verify the user is redirected to the login page or homepage, then try navigating to /dashboard and verify the session is destroyed (redirected to login)");
