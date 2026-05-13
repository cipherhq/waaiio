import { test, expect } from '@playwright/test';

test.describe('Marketing Pages', () => {
  test('homepage loads with key sections', async ({ page }) => {
    await page.goto('/');

    // Hero section
    await expect(page.locator('h1')).toContainText(/WhatsApp|Smarter/i);

    // Should have some CTA link to get-started
    await expect(page.locator('a[href*="get-started"]').first()).toBeAttached();

    // FAQ section
    await expect(page.getByText('Frequently Asked Questions')).toBeVisible();
  });

  test('pricing page loads', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByText(/free/i).first()).toBeVisible();
    await expect(page.getByText(/growth/i).first()).toBeVisible();
    await expect(page.getByText(/business/i).first()).toBeVisible();
  });

  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in|log in|welcome/i })).toBeVisible();
  });

  test('signup page loads', async ({ page }) => {
    await page.goto('/signup');
    // May redirect to login or show signup form
    await expect(page).toHaveURL(/signup|login|get-started/);
  });

  test('get-started page loads', async ({ page }) => {
    await page.goto('/get-started');
    await expect(page).toHaveURL(/get-started|login/);
  });

  test('OG metadata is present', async ({ page }) => {
    await page.goto('/');

    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    expect(ogTitle).toBeTruthy();

    const ogDescription = await page.locator('meta[property="og:description"]').getAttribute('content');
    expect(ogDescription).toBeTruthy();

    const twitterCard = await page.locator('meta[name="twitter:card"]').getAttribute('content');
    expect(twitterCard).toBe('summary_large_image');
  });

  test('security headers are present', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response!.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['content-security-policy']).toBeTruthy();
  });
});
