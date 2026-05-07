import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/");
});

shortest("Verify the waaiio.com homepage has loaded and contains the word 'Waaiio' or 'waaiio' somewhere on the page");
