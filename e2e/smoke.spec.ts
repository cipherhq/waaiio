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

  test('check-in page shows not found for invalid business', async ({ page }) => {
    // The check-in page (app/checkin/[businessId]/page.tsx) renders a client-side
    // "Business not found" error state for invalid UUIDs. It returns HTTP 200
    // because the page shell loads, then the client query finds no business.
    await page.goto('/checkin/00000000-0000-0000-0000-000000000000');
    await expect(page.getByText(/Business not found/i)).toBeVisible({ timeout: 10000 });
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
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Filter out known benign errors (e.g. PostHog, Sentry, third-party scripts)
    const critical = errors.filter(
      e => !e.includes('posthog') && !e.includes('sentry') && !e.includes('ERR_BLOCKED_BY_CLIENT')
    );
    expect(critical).toHaveLength(0);
  });

  test('404 page renders for non-existent route', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist-12345');
    expect(response?.status()).toBe(404);
  });
});
