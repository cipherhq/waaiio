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
    // In CI (no Supabase), page shows "Pricing temporarily unavailable" fallback.
    // In production, it shows all three tier cards (Starter/Pro/Premium).
    // Wait for the page to settle into one of the two valid states.
    const fallback = page.getByRole('heading', { name: /Pricing temporarily unavailable/i });
    const starterHeading = page.getByRole('heading', { name: 'Starter' });

    // Wait for either state to render (client-side fetch + fallback takes a moment)
    await expect(fallback.or(starterHeading)).toBeVisible();

    const isFallback = await fallback.isVisible();
    if (!isFallback) {
      // Real pricing rendered — verify all three canonical tier headings
      await expect(starterHeading).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Pro' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Premium' })).toBeVisible();
    }
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
