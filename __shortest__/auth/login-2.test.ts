import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
});

shortest("Verify the login page has a 'Get Started' link for users who do not have an account");
