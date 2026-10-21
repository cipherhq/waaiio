/**
 * Staging QA: Catalog (Products & Services) page tests
 *
 * Verifies catalog pages render. Read-only — no mutations.
 * Empty states are valid for a QA merchant without catalog data.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Catalog — products page', () => {
  test('products page loads or shows empty state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/products');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    // Either product list or empty state should be visible
    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasContent =
      bodyText.includes('Product') ||
      bodyText.includes('product') ||
      bodyText.includes('No ') ||     // "No products yet"
      bodyText.includes('empty') ||
      bodyText.includes('Get started') ||
      bodyText.includes('Add');        // "Add your first product"
    expect(hasContent).toBe(true);
  });
});

test.describe('Catalog — services page', () => {
  test('services page loads or shows empty state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/services');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasContent =
      bodyText.includes('Service') ||
      bodyText.includes('service') ||
      bodyText.includes('No ') ||
      bodyText.includes('empty') ||
      bodyText.includes('Get started') ||
      bodyText.includes('Add');
    expect(hasContent).toBe(true);
  });
});
