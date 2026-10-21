/**
 * Staging QA: Contracts & Waivers dashboard (M449 journeys)
 *
 * Verifies the contracts and waivers pages load correctly after M449
 * migration. Read-only — no contract creation or signing.
 *
 * LIMITATION: Does not verify contract data integrity or signing flows.
 * Those require end-to-end WhatsApp delivery which is out of scope.
 */

import { test, expect } from '../fixtures/auth';

test.describe('M449 — Contracts dashboard', () => {
  test('contracts page loads without error', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/contracts');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    // Page should render contract-related content or empty state
    const bodyText = await merchantPage.locator('body').textContent() || '';
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('Application error');

    const hasContent =
      bodyText.includes('Contract') ||
      bodyText.includes('contract') ||
      bodyText.includes('No ') ||
      bodyText.includes('Create') ||
      bodyText.includes('template');
    expect(hasContent).toBe(true);
  });

  test('contracts page does not crash on network idle', async ({ merchantPage }) => {
    const errors: string[] = [];
    merchantPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('posthog') && !text.includes('sentry')) {
          errors.push(text);
        }
      }
    });

    await merchantPage.goto('/dashboard/contracts');
    await merchantPage.waitForLoadState('networkidle');

    if (errors.length > 0) {
      console.log(`[contracts] Console errors:\n${errors.join('\n')}`);
    }
    expect(errors).toHaveLength(0);
  });
});

test.describe('M449 — Waivers dashboard', () => {
  test('waivers page loads without error', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/waivers');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    const bodyText = await merchantPage.locator('body').textContent() || '';
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('Application error');

    const hasContent =
      bodyText.includes('Waiver') ||
      bodyText.includes('waiver') ||
      bodyText.includes('No ') ||
      bodyText.includes('Create') ||
      bodyText.includes('template');
    expect(hasContent).toBe(true);
  });

  test('waivers page does not crash on network idle', async ({ merchantPage }) => {
    const errors: string[] = [];
    merchantPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('posthog') && !text.includes('sentry')) {
          errors.push(text);
        }
      }
    });

    await merchantPage.goto('/dashboard/waivers');
    await merchantPage.waitForLoadState('networkidle');

    if (errors.length > 0) {
      console.log(`[waivers] Console errors:\n${errors.join('\n')}`);
    }
    expect(errors).toHaveLength(0);
  });
});
