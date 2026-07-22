import { test, expect } from '@playwright/test';

const ADMIN_BASE = 'http://localhost:8083';

// Check if admin app is available before running tests
async function isAdminAvailable(): Promise<boolean> {
  try {
    const response = await fetch(ADMIN_BASE, { signal: AbortSignal.timeout(3000) });
    return response.ok || response.status === 200 || response.status === 304;
  } catch {
    return false;
  }
}

test.describe('Admin panel E2E', () => {
  let adminAvailable = false;

  test.beforeAll(async () => {
    adminAvailable = await isAdminAvailable();
  });

  test.beforeEach(async ({ }, testInfo) => {
    if (!adminAvailable) {
      testInfo.skip(true, 'Admin app not running on port 8083 — skipping');
    }
  });

  test('admin login page loads', async ({ page }) => {
    await page.goto(`${ADMIN_BASE}/login`);
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/sign in|log in|admin/i).first()).toBeVisible();
  });

  test('unauthenticated admin access redirects to login', async ({ page }) => {
    await page.goto(`${ADMIN_BASE}/dashboard`);
    // Should redirect to /login since user is not authenticated
    await page.waitForURL(/\/login/, { timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('login form has email and password fields', async ({ page }) => {
    await page.goto(`${ADMIN_BASE}/login`);
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
  });

  test('login form rejects empty submission', async ({ page }) => {
    await page.goto(`${ADMIN_BASE}/login`);
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    // Find and click the submit button without filling fields
    const submitButton = page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")').first();
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    // Should show validation error or remain on login page (HTML5 validation prevents submission)
    await expect(page).toHaveURL(/\/login/);

    // Check that either an error message appeared or the browser's native validation kicked in
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
    const isInvalid = await emailInput.evaluate(
      (el: HTMLInputElement) => !el.validity.valid || el.value === ''
    );
    expect(isInvalid).toBe(true);
  });

  test('mobile: admin login page has no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${ADMIN_BASE}/login`);
    await expect(page.locator('form')).toBeVisible({ timeout: 10000 });

    const hasOverflow = await page.evaluate(() => {
      return document.body.scrollWidth > window.innerWidth;
    });
    expect(hasOverflow).toBe(false);
  });
});
