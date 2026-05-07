import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/features");
});

shortest("Verify a page about product features has loaded with visible content");
