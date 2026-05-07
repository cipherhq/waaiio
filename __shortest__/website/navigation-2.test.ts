import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await new Promise(r => setTimeout(r, 1000));
});

shortest("Verify a hamburger menu icon or mobile menu button is visible on this page");
