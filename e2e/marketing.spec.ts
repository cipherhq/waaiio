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

// ── Launch banner integration (#446) ──

test.describe('Launch banner — mocked API integration', () => {
  const MOCK_ANNOUNCEMENT = {
    enabled: true,
    type: 'launch_countdown',
    headline: 'Waaiio launches October 11!',
    message: 'Be the first to know.',
    target_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    cta_text: null,
    cta_link: null,
    style: 'brand',
  };

  const MOCK_REGIONS = {
    regions: [
      { phone: '2348001234567', code: 'NG', name: 'Nigeria', flag: '\u{1F1F3}\u{1F1EC}' },
      { phone: '12025551234', code: 'US', name: 'United States', flag: '\u{1F1FA}\u{1F1F8}' },
    ],
  };

  async function setupMocks(page: import('@playwright/test').Page) {
    // Mock both APIs before navigating
    await page.route('**/api/site-announcement', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_ANNOUNCEMENT) })
    );
    await page.route('**/api/launch/regions', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_REGIONS) })
    );
  }

  test('enabled launch_countdown renders rich banner with country selector', async ({ page }) => {
    await setupMocks(page);
    // Override timezone detection — use a timezone with no supported country match
    await page.addInitScript(() => {
      const original = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        const opts = original.call(this);
        opts.timeZone = 'Asia/Tokyo';
        return opts;
      };
    });

    await page.goto('/');
    // Rich launch banner should be visible
    const banner = page.locator('[data-testid="launch-banner"]');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Country selector should be visible
    const selector = page.locator('[data-testid="country-selector"]');
    await expect(selector).toBeVisible();

    // With no matching timezone, CTA should be disabled (no whatsapp-button visible)
    const ctaButton = page.locator('[data-testid="whatsapp-button"]');
    await expect(ctaButton).not.toBeVisible();

    // QR should be disabled
    const qrCard = page.locator('[data-testid="qr-card"]');
    await expect(qrCard).not.toBeVisible();

    // Disabled state text should be visible
    const disabledText = page.locator('[data-testid="cta-disabled"]');
    await expect(disabledText).toBeVisible();
  });

  test('selecting country A enables button targeting country A with (button)', async ({ page }) => {
    await setupMocks(page);
    await page.addInitScript(() => {
      const original = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        const opts = original.call(this);
        opts.timeZone = 'Asia/Tokyo';
        return opts;
      };
    });

    await page.goto('/');
    const banner = page.locator('[data-testid="launch-banner"]');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Select Nigeria
    const selector = page.locator('[data-testid="country-selector"]');
    await selector.selectOption('NG');

    // Button should now be visible and target Nigeria
    const ctaButton = page.locator('[data-testid="whatsapp-button"]');
    await expect(ctaButton).toBeVisible();
    const href = await ctaButton.getAttribute('href');
    expect(href).toContain('wa.me/2348001234567');
    expect(href).toContain(encodeURIComponent('(button)'));

    // QR card should render for selected country
    const qrCard = page.locator('[data-testid="qr-card"]');
    await expect(qrCard).toBeVisible();
  });

  test('switching to country B changes button destination', async ({ page }) => {
    await setupMocks(page);
    await page.addInitScript(() => {
      const original = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        const opts = original.call(this);
        opts.timeZone = 'Asia/Tokyo';
        return opts;
      };
    });

    await page.goto('/');
    const banner = page.locator('[data-testid="launch-banner"]');
    await expect(banner).toBeVisible({ timeout: 10000 });

    const selector = page.locator('[data-testid="country-selector"]');
    const ctaButton = page.locator('[data-testid="whatsapp-button"]');

    // Select Nigeria first
    await selector.selectOption('NG');
    await expect(ctaButton).toBeVisible();
    const hrefNG = await ctaButton.getAttribute('href');
    expect(hrefNG).toContain('wa.me/2348001234567');

    // Switch to US
    await selector.selectOption('US');
    await expect(ctaButton).toBeVisible();
    const hrefUS = await ctaButton.getAttribute('href');
    expect(hrefUS).toContain('wa.me/12025551234');
    expect(hrefUS).not.toContain('2348001234567');
  });

  test('mobile viewport has no horizontal overflow', async ({ page }) => {
    await setupMocks(page);
    // Use a narrow mobile viewport
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('/');
    const banner = page.locator('[data-testid="launch-banner"]');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Select a country to fully render the banner with CTA + QR
    const selector = page.locator('[data-testid="country-selector"]');
    await selector.selectOption('NG');
    await expect(page.locator('[data-testid="whatsapp-button"]')).toBeVisible();

    // Check no horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);
  });
});
