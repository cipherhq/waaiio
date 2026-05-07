import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/pricing");
});

shortest("Verify each pricing plan card has a call-to-action button like 'Get Started' or 'Start Free Trial'");
