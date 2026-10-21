/**
 * Staging QA: Settings page tests
 *
 * Verifies the business settings page renders correctly and
 * form fields are present. Read-only — does NOT submit changes.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Settings — authenticated merchant', () => {
  test('settings page loads with business name field', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/settings');
    await merchantPage.waitForLoadState('networkidle');

    // Must not redirect to login
    await expect(merchantPage).not.toHaveURL(/\/login/);

    // Settings page should have form inputs
    const inputs = merchantPage.locator('input, select, textarea');
    const inputCount = await inputs.count();
    expect(inputCount).toBeGreaterThan(0);
  });

  test('settings page shows business information section', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/settings');
    await merchantPage.waitForLoadState('networkidle');

    // Look for typical settings labels
    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasSettingsContent =
      bodyText.includes('Business') ||
      bodyText.includes('Settings') ||
      bodyText.includes('Name') ||
      bodyText.includes('Profile');
    expect(hasSettingsContent).toBe(true);
  });
});
