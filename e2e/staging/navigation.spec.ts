/**
 * Staging QA: Dashboard navigation tests
 *
 * Verifies that sidebar navigation links lead to functioning pages
 * (not 500s, not blank screens, not login redirects). Read-only.
 *
 * Each navigation target gets a basic "page loads" assertion.
 * Capability-gated pages may show empty states — that is valid.
 */

import { test, expect } from '../fixtures/auth';

/** Core dashboard pages that every merchant should be able to reach */
const CORE_PAGES = [
  { path: '/dashboard', label: 'Overview' },
  { path: '/dashboard/customers', label: 'Customers' },
  { path: '/dashboard/settings', label: 'Settings' },
] as const;

/**
 * Pages that require specific capabilities or data.
 * Empty states are acceptable — crashes and redirects to login are not.
 */
const CAPABILITY_PAGES = [
  { path: '/dashboard/services', label: 'Services' },
  { path: '/dashboard/products', label: 'Products' },
  { path: '/dashboard/orders', label: 'Orders' },
  { path: '/dashboard/invoices', label: 'Invoices' },
  { path: '/dashboard/contracts', label: 'Contracts' },
  { path: '/dashboard/waivers', label: 'Waivers' },
  { path: '/dashboard/whatsapp', label: 'WhatsApp' },
  { path: '/dashboard/audiences', label: 'Audiences' },
  { path: '/dashboard/financials', label: 'Financials' },
  { path: '/dashboard/chat', label: 'Chat' },
  { path: '/dashboard/analytics', label: 'Analytics' },
] as const;

test.describe('Dashboard navigation — core pages', () => {
  for (const { path, label } of CORE_PAGES) {
    test(`${label} (${path}) loads without error`, async ({ merchantPage }) => {
      const response = await merchantPage.goto(path);

      // Server-side errors must fail the test
      if (response) {
        expect(
          response.status(),
          `${path} returned HTTP ${response.status()}`
        ).toBeLessThan(400);
      }

      // Must NOT redirect to login (session loss)
      await expect(merchantPage).not.toHaveURL(/\/login/);

      // Must not be a 500 error page
      const bodyText = await merchantPage.locator('body').textContent();
      expect(bodyText).not.toContain('Internal Server Error');

      // Should have some visible content
      const hasContent = await merchantPage.locator('h1, h2, h3, [role="main"], main').first().isVisible();
      expect(hasContent).toBe(true);
    });
  }
});

test.describe('Dashboard navigation — capability pages', () => {
  for (const { path, label } of CAPABILITY_PAGES) {
    test(`${label} (${path}) loads or shows empty state`, async ({ merchantPage }) => {
      const response = await merchantPage.goto(path);

      // Server-side errors must fail the test
      if (response) {
        expect(
          response.status(),
          `${path} returned HTTP ${response.status()}`
        ).toBeLessThan(400);
      }

      // Must NOT redirect to login
      await expect(merchantPage).not.toHaveURL(/\/login/);

      // Must not show unhandled server error
      const bodyText = await merchantPage.locator('body').textContent();
      expect(bodyText).not.toContain('Internal Server Error');
      expect(bodyText).not.toContain('Application error');

      // Page should render — either content or a proper empty state
      await merchantPage.waitForLoadState('domcontentloaded');
      const pageNotBlank = await merchantPage.evaluate(
        () => document.body.innerText.trim().length > 0
      );
      expect(pageNotBlank).toBe(true);
    });
  }
});
