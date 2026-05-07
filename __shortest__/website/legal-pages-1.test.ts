import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/privacy");
  await new Promise(r => setTimeout(r, 2000));
});

shortest("Verify this privacy policy page has loaded with text content and headings");
