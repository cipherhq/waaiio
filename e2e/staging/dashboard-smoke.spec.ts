/**
 * Staging QA: Dashboard smoke tests
 *
 * Verifies the merchant dashboard loads after login, displays expected
 * structural elements, and does not crash. Read-only — no mutations.
 *
 * LIMITATION: A successful render does NOT prove business functionality.
 * These tests verify that the page loads without errors and key UI
 * elements are present, not that the underlying data is correct.
 */

import { test, expect } from '../fixtures/auth';

test.describe('Dashboard smoke — authenticated merchant', () => {
  test('dashboard overview loads with structural elements', async ({ merchantPage }) => {
    // Should already be on dashboard from auth fixture
    await expect(merchantPage).toHaveURL(/\/dashboard/);

    // Dashboard layout should be present
    await expect(merchantPage.locator('nav, aside, [role="navigation"]').first()).toBeVisible();

    // Page should have a heading or business name
    const hasHeading = await merchantPage.locator('h1, h2').first().isVisible();
    expect(hasHeading).toBe(true);
  });

  test('dashboard does not show console errors on load', async ({ merchantPage }) => {
    const errors: string[] = [];

    merchantPage.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Suppress known benign errors
      if (
        text.includes('posthog') ||
        text.includes('sentry') ||
        text.includes('ERR_BLOCKED_BY_CLIENT')
      ) return;
      errors.push(text);
    });

    // Reload to capture console from fresh load
    await merchantPage.reload();
    await merchantPage.waitForLoadState('networkidle');

    if (errors.length > 0) {
      console.log(`[dashboard-smoke] Console errors captured:\n${errors.join('\n')}`);
    }
    expect(errors).toHaveLength(0);
  });

  test('dashboard page has correct title', async ({ merchantPage }) => {
    await expect(merchantPage).toHaveTitle(/Dashboard/i);
  });

  test('records staging metadata for evidence', async ({ stagingMeta }) => {
    // This test exists purely for evidence recording
    expect(stagingMeta.stagingUrl).toBeTruthy();
    expect(stagingMeta.sourceCommitSha).toBeTruthy();
    expect(stagingMeta.testRunTimestamp).toBeTruthy();

    console.log('[staging-meta] Evidence record:');
    console.log(`  Staging URL: ${stagingMeta.stagingUrl}`);
    console.log(`  Source SHA:  ${stagingMeta.sourceCommitSha}`);
    console.log(`  Deploy SHA:  ${stagingMeta.deploymentSha || 'not provided'}`);
    console.log(`  Supabase:    ${stagingMeta.supabaseRef || 'not provided'}`);
    console.log(`  Timestamp:   ${stagingMeta.testRunTimestamp}`);
  });
});
