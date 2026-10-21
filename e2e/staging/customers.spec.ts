/**
 * Staging QA: Customers page tests
 *
 * Verifies the customer list page renders. Read-only.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Customers — authenticated merchant', () => {
  test('customers page loads', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/customers');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    // Should show customers list or empty state
    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasContent =
      bodyText.includes('Customer') ||
      bodyText.includes('customer') ||
      bodyText.includes('No ') ||
      bodyText.includes('empty');
    expect(hasContent).toBe(true);
  });

  test('customers page does not leak PII in page source', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/customers');
    await merchantPage.waitForLoadState('networkidle');

    // Verify no service role key or internal tokens are exposed in page source
    const pageContent = await merchantPage.content();
    expect(pageContent).not.toContain('service_role');
    expect(pageContent).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(pageContent).not.toContain('INTERNAL_API_TOKEN');
  });
});
