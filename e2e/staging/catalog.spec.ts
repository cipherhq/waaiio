/**
 * Staging QA: Catalog (Products & Services) page tests
 *
 * Verifies catalog pages render. Read-only — no mutations.
 * Empty states are valid for a QA merchant without catalog data.
 *
 * Assertions are scoped to the main content area (not sidebar/nav)
 * to avoid false positives from navigation text matching generic terms.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Catalog — products page', () => {
  test('products page loads or shows empty state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/products');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    // Scope to main content area to avoid sidebar false positives
    const mainArea = merchantPage.locator('main, [role="main"]').first();
    const hasMainElement = (await mainArea.count()) > 0;
    const contentText = hasMainElement
      ? (await mainArea.textContent() || '')
      : (await merchantPage.locator('body').textContent() || '');
    const hasContent =
      contentText.includes('Product') ||
      contentText.includes('product') ||
      contentText.includes('No ') ||     // "No products yet"
      contentText.includes('empty') ||
      contentText.includes('Get started') ||
      contentText.includes('Add');        // "Add your first product"
    expect(hasContent).toBe(true);
  });
});

test.describe('Catalog — services page', () => {
  test('services page loads or shows empty state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/services');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    // Scope to main content area to avoid sidebar false positives
    const mainArea = merchantPage.locator('main, [role="main"]').first();
    const hasMainElement = (await mainArea.count()) > 0;
    const contentText = hasMainElement
      ? (await mainArea.textContent() || '')
      : (await merchantPage.locator('body').textContent() || '');
    const hasContent =
      contentText.includes('Service') ||
      contentText.includes('service') ||
      contentText.includes('No ') ||
      contentText.includes('empty') ||
      contentText.includes('Get started') ||
      contentText.includes('Add');
    expect(hasContent).toBe(true);
  });
});
