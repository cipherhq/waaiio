/**
 * Staging QA: Engage E1 — Audience/segment builder (#669)
 *
 * Verifies the new Engage audience UI renders correctly.
 * Read-only — no segment creation or broadcast triggering.
 *
 * LIMITATION: A successful render does not prove segment logic
 * or audience counting works correctly.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Engage E1 — Audiences page', () => {
  test('audiences page loads without error', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/audiences');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    const bodyText = await merchantPage.locator('body').textContent() || '';
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('Application error');
  });

  test('audiences page shows segment builder or empty state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/audiences');
    await merchantPage.waitForLoadState('networkidle');

    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasAudienceContent =
      bodyText.includes('Audience') ||
      bodyText.includes('audience') ||
      bodyText.includes('Segment') ||
      bodyText.includes('segment') ||
      bodyText.includes('Create') ||
      bodyText.includes('No ') ||
      bodyText.includes('Build');
    expect(hasAudienceContent).toBe(true);
  });

  test('audiences page does not crash with console errors', async ({ merchantPage }) => {
    const errors: string[] = [];
    merchantPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('posthog') && !text.includes('sentry')) {
          errors.push(text);
        }
      }
    });

    await merchantPage.goto('/dashboard/audiences');
    await merchantPage.waitForLoadState('networkidle');

    if (errors.length > 0) {
      console.log(`[engage] Console errors:\n${errors.join('\n')}`);
    }
    expect(errors).toHaveLength(0);
  });
});
