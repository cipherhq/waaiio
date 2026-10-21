/**
 * Staging QA: Finance UI (#670)
 *
 * Verifies the financials page renders with correct schema after #670.
 * Read-only — no payment or payout mutations.
 *
 * LIMITATION: A successful render does not prove financial calculations
 * are correct. Revenue, fee, and payout amounts require separate
 * data-level verification.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Finance UI — financials page', () => {
  test('financials page loads without error', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/financials');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    const bodyText = await merchantPage.locator('body').textContent() || '';
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('Application error');
  });

  test('financials page shows financial content or empty state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/financials');
    await merchantPage.waitForLoadState('networkidle');

    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasFinancialContent =
      bodyText.includes('Financial') ||
      bodyText.includes('Revenue') ||
      bodyText.includes('revenue') ||
      bodyText.includes('Payment') ||
      bodyText.includes('payment') ||
      bodyText.includes('Payout') ||
      bodyText.includes('Transaction') ||
      bodyText.includes('No ') ||
      bodyText.includes('$') ||
      bodyText.includes('NGN') ||
      bodyText.includes('USD') ||
      bodyText.includes('GHS');
    expect(hasFinancialContent).toBe(true);
  });

  test('financials page does not crash with console errors', async ({ merchantPage }) => {
    const errors: string[] = [];
    merchantPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('posthog') && !text.includes('sentry')) {
          errors.push(text);
        }
      }
    });

    await merchantPage.goto('/dashboard/financials');
    await merchantPage.waitForLoadState('networkidle');

    if (errors.length > 0) {
      console.log(`[financials] Console errors:\n${errors.join('\n')}`);
    }
    expect(errors).toHaveLength(0);
  });

  test('financials page does not expose payment secrets in source', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/financials');
    await merchantPage.waitForLoadState('networkidle');

    const pageContent = await merchantPage.content();
    expect(pageContent).not.toContain('STRIPE_SECRET_KEY');
    expect(pageContent).not.toContain('PAYSTACK_SECRET_KEY');
    // Check for Stripe key prefixes without embedding the literal patterns
    // (which would trigger the repo's secret scanner as false positives)
    const stripeKeyPattern = /sk_(live|test)_[A-Za-z0-9]{10,}/;
    expect(pageContent).not.toMatch(stripeKeyPattern);
  });
});
