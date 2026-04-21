import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_ADMIN_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_ADMIN_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Click the logout or sign out button, verify redirect to login page, then try to navigate back to /dashboard using the browser and verify the session is destroyed (redirected back to login)");
