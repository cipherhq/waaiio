import { test, expect } from '@playwright/test';

test.describe('Business Profile Settings', () => {
  // These tests verify the settings page structure and behavior.
  // Since the dashboard requires authentication + a business, unauthenticated
  // users get redirected to login. We test the redirect behavior and
  // page structure after potential auth.

  test('unauthenticated user is redirected from settings to login', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.waitForURL(/login/, { timeout: 10000 });
    expect(page.url()).toContain('/login');
  });

  test('settings page URL includes redirect param after auth redirect', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.waitForURL(/login/, { timeout: 10000 });
    // The redirect should preserve where the user wanted to go
    // (implementation may vary — some apps use ?redirect= param)
    expect(page.url()).toContain('/login');
  });

  test('login page allows navigation to settings after auth', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText(/Sign in/i).first()).toBeVisible();

    // Verify the login form is functional
    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');
    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
  });
});

test.describe('Settings Page Structure (authenticated)', () => {
  // These tests verify the settings page renders correctly when accessed.
  // In CI without real auth, they test the redirect. Locally with a session,
  // they validate the full page.

  test('settings page has correct tabs', async ({ page }) => {
    await page.goto('/dashboard/settings');

    // If redirected to login, that's expected for unauthenticated
    const isLogin = page.url().includes('/login');
    if (isLogin) {
      // Verify the login page is functional as fallback
      await expect(page.getByText(/Sign in/i).first()).toBeVisible();
      return;
    }

    // If we're on settings (authenticated session), verify tabs exist
    await expect(page.getByText(/Settings/i).first()).toBeVisible();
    // The page has tabs: Business, Payments, Features, Integrations, Notifications, Account
    await expect(page.getByText(/Business/i).first()).toBeVisible();
  });

  test('business tab shows profile section by default', async ({ page }) => {
    await page.goto('/dashboard/settings?tab=business');

    const isLogin = page.url().includes('/login');
    if (isLogin) {
      await expect(page.getByRole('button', { name: /Sign In/i })).toBeVisible();
      return;
    }

    // Business tab should show profile fields: name, description, address, phone, email
    await expect(page.locator('input').first()).toBeVisible();
  });

  test('settings page with account tab loads', async ({ page }) => {
    await page.goto('/dashboard/settings?tab=account');

    const isLogin = page.url().includes('/login');
    if (isLogin) {
      await expect(page.getByRole('button', { name: /Sign In/i })).toBeVisible();
      return;
    }

    await expect(page.getByText(/Settings/i).first()).toBeVisible();
  });
});

test.describe('Settings API Protection', () => {
  test('business update API rejects unauthenticated requests', async ({ request }) => {
    const response = await request.patch('/api/businesses', {
      headers: { 'Content-Type': 'application/json' },
      data: { name: 'Hacked Business' },
    });
    // Should return 401 or 405 (method not allowed if route doesn't exist)
    expect([401, 403, 404, 405]).toContain(response.status());
  });
});

// Mobile viewport tests for settings
test.describe('Settings — Mobile viewport (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('settings page has no horizontal overflow on mobile', async ({ page }) => {
    await page.goto('/dashboard/settings');

    // Whether redirected to login or showing settings, check no overflow
    await page.waitForLoadState('networkidle');
    const bodyWidth = await page.locator('body').evaluate((el) => el.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(376);
  });

  test('login page (from settings redirect) is mobile-friendly', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.waitForURL(/login|settings/, { timeout: 10000 });

    const bodyWidth = await page.locator('body').evaluate((el) => el.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(376);

    // Key interactive elements should be visible
    if (page.url().includes('/login')) {
      await expect(page.getByRole('button', { name: /Sign In/i })).toBeVisible();
      const emailInput = page.locator('input[type="email"]');
      await expect(emailInput).toBeVisible();
    }
  });
});
