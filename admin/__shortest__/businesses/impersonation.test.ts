import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_ADMIN_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_ADMIN_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Navigate to a business detail page and look for an impersonation or 'login as' button. Verify the feature exists and check if there is an audit trail or log for impersonation actions. Do NOT actually impersonate - just verify the UI elements are present");
