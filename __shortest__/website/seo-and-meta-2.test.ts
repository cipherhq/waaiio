import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/pricing");
  await new Promise(r => setTimeout(r, 1000));
});

shortest("Verify this pricing page has a visible heading related to pricing or plans");
