import { test, expect } from '@playwright/test';

// Mobile viewport tests
const MOBILE_WIDTHS = [375, 430];

for (const width of MOBILE_WIDTHS) {
  test.describe(`Mobile ${width}px`, () => {
    test.use({ viewport: { width, height: 812 } });

    test('homepage has no horizontal overflow', async ({ page }) => {
      await page.goto('/');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1); // +1 for rounding
    });

    test('login page fits viewport', async ({ page }) => {
      await page.goto('/login');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });

    test('pricing page fits viewport', async ({ page }) => {
      await page.goto('/pricing');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });

    test('onboarding page fits viewport', async ({ page }) => {
      await page.goto('/get-started');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });

    test('about page fits viewport', async ({ page }) => {
      await page.goto('/about');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });

    test('features page fits viewport', async ({ page }) => {
      await page.goto('/features');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });

    test('contact page fits viewport', async ({ page }) => {
      await page.goto('/contact');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });

    test('check-in page fits viewport', async ({ page }) => {
      await page.goto('/checkin/00000000-0000-0000-0000-000000000000');
      const body = page.locator('body');
      const bodyWidth = await body.evaluate(el => el.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(width + 1);
    });
  });
}

// Screenshot regression at key widths
test.describe('Screenshot regression', () => {
  for (const width of [375, 430, 1440]) {
    test(`homepage at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`homepage-${width}.png`, { maxDiffPixelRatio: 0.05 });
    });

    test(`pricing at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/pricing');
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`pricing-${width}.png`, { maxDiffPixelRatio: 0.05 });
    });
  }
});
