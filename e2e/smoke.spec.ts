import { test, expect } from '@playwright/test';

test.describe('Smoke tests — public pages', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Waaiio/i);
    await expect(page.locator('header').first()).toBeVisible();
    await expect(page.locator('h1')).toBeVisible();
  });

  test('pricing page loads', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByText(/Starter/i).first()).toBeVisible();
    await expect(page.getByText(/Pro/i).first()).toBeVisible();
    await expect(page.getByText(/Premium/i).first()).toBeVisible();
  });

  test('features page loads', async ({ page }) => {
    await page.goto('/features');
    await expect(page).toHaveTitle(/Features/i);
    await expect(page.getByText(/Platform Features/i).first()).toBeVisible();
  });

  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText(/Sign in/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign In/i })).toBeVisible();
  });

  test('onboarding page loads', async ({ page }) => {
    await page.goto('/get-started');
    // May redirect to login if unauthenticated, or show the onboarding wizard
    await expect(page).toHaveURL(/get-started|login/);
  });

  test('check-in page handles invalid business gracefully', async ({ page }) => {
    await page.goto('/checkin/00000000-0000-0000-0000-000000000000');
    // In CI (no Supabase): shows "Temporarily unavailable" because the query fails.
    // In production: shows "Business not found" because the query succeeds with no result.
    // Both are acceptable — the page must not show an infinite spinner.
    await expect(
      page.getByText(/Business not found|Temporarily unavailable/i).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('terms page loads', async ({ page }) => {
    await page.goto('/terms');
    await expect(page).toHaveTitle(/Terms/i);
  });

  test('privacy page loads', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page).toHaveTitle(/Privacy/i);
  });

  test('contact page loads', async ({ page }) => {
    await page.goto('/contact');
    await expect(page.getByText(/Get in Touch/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Send Message/i })).toBeVisible();
  });

  test('about page loads', async ({ page }) => {
    await page.goto('/about');
    await expect(page).toHaveTitle(/About/i);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('help page loads', async ({ page }) => {
    await page.goto('/help');
    await expect(page).toHaveURL(/help/);
  });

  test('no console errors on homepage', async ({ page }) => {
    const errors: string[] = [];
    const suppressed: string[] = [];

    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();

      // Only suppress errors from known CI placeholder services or their consequences.
      // Hostname-scoped where the browser includes URLs; pattern-scoped for generic
      // network errors that can only originate from CI placeholder hosts.
      const isCiPlaceholderError =
        // CI Supabase placeholder — hostname visible in CSP/fetch errors
        text.includes('ci-placeholder.supabase.co') ||
        text.includes('example.supabase.co') ||
        // PostHog analytics (dummy key, may try to reach us.i.posthog.com)
        text.includes('posthog') ||
        // Sentry error reporting (dummy DSN)
        text.includes('sentry') ||
        // Browser extension interference
        text.includes('ERR_BLOCKED_BY_CLIENT') ||
        // DNS failures from CI placeholder hosts — the browser omits the hostname
        // in "Failed to load resource: net::ERR_NAME_NOT_RESOLVED" messages.
        // In CI, the only non-resolvable host is ci-placeholder.supabase.co.
        // In production, all hosts resolve, so this pattern would never fire.
        text.includes('ERR_NAME_NOT_RESOLVED');

      if (isCiPlaceholderError) {
        suppressed.push(text);
      } else {
        errors.push(text);
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Log suppressed errors for visibility — they are not silent
    if (suppressed.length > 0) {
      console.log(`[smoke] Suppressed ${suppressed.length} CI-expected console error(s):`);
      suppressed.forEach(e => console.log(`  - ${e.slice(0, 120)}`));
    }

    expect(errors).toHaveLength(0);
  });

  test('404 page renders for non-existent route', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist-12345');
    expect(response?.status()).toBe(404);
  });
});
