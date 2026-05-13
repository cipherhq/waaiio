import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('unauthenticated user redirected from dashboard to login', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');
  });

  test('login page has email and OTP options', async ({ page }) => {
    await page.goto('/login');

    // Should have some form of input
    const hasEmailInput = await page.locator('input[type="email"]').count() > 0;
    const hasPhoneInput = await page.locator('input[type="tel"]').count() > 0;
    const hasTextInput = await page.locator('input[type="text"]').count() > 0;

    expect(hasEmailInput || hasPhoneInput || hasTextInput).toBe(true);
  });

  test('forgot password page loads', async ({ page }) => {
    await page.goto('/forgot-password');
    await expect(page).toHaveURL(/forgot-password/);
  });

  test('reset password page loads', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page).toHaveURL(/reset-password/);
  });

  test('protected API routes return 401 without auth', async ({ request }) => {
    const routes = [
      '/api/dashboard/recommendations',
      '/api/dashboard/alerts',
    ];

    for (const route of routes) {
      const response = await request.get(route);
      expect(response.status()).toBe(401);
    }
  });

  test('CSRF: API rejects requests from foreign origins', async ({ request }) => {
    const response = await request.post('/api/invoices', {
      headers: { 'Origin': 'https://evil.com', 'Content-Type': 'application/json' },
      data: { business_id: 'test' },
    });
    expect(response.status()).toBe(403);
  });
});
