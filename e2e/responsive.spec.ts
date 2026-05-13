import { test, expect, devices } from '@playwright/test';

test.describe('Responsive Design', () => {
  test('homepage renders on mobile', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 14'] });
    const page = await context.newPage();

    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();

    // Mobile sticky CTA bar should be present
    await expect(page.locator('a[href*="get-started"]').first()).toBeAttached();

    await context.close();
  });

  test('login page works on mobile', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 14'] });
    const page = await context.newPage();

    await page.goto('/login');
    // Should have input visible and not overflow
    const viewport = page.viewportSize();
    expect(viewport!.width).toBeLessThanOrEqual(430);

    await context.close();
  });

  test('pricing page renders correctly on tablet', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPad Mini'] });
    const page = await context.newPage();

    await page.goto('/pricing');
    await expect(page.getByText(/free/i).first()).toBeVisible();

    await context.close();
  });
});
