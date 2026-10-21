/**
 * Staging QA: WhatsApp channel display (M449 journey)
 *
 * Verifies the WhatsApp settings page renders channel information
 * correctly. Read-only — no channel provisioning or message sending.
 *
 * NOTE: Admin channel visibility tests require the QA Admin identity
 * (Phase C). This file covers merchant-side channel display only.
 */

import { test, expect } from '../fixtures/auth';

test.describe('M449 — WhatsApp channel display (merchant)', () => {
  test('WhatsApp page loads without error', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/whatsapp');
    await merchantPage.waitForLoadState('networkidle');

    await expect(merchantPage).not.toHaveURL(/\/login/);

    const bodyText = await merchantPage.locator('body').textContent() || '';
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('Application error');
  });

  test('WhatsApp page shows channel or connection state', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/whatsapp');
    await merchantPage.waitForLoadState('networkidle');

    // Page should show either:
    // - Connected channel information (number, status)
    // - "Connect WhatsApp" prompt for merchants without a channel
    // - Shared channel information
    const bodyText = await merchantPage.locator('body').textContent() || '';
    const hasChannelContent =
      bodyText.includes('WhatsApp') ||
      bodyText.includes('Channel') ||
      bodyText.includes('channel') ||
      bodyText.includes('Connect') ||
      bodyText.includes('Number') ||
      bodyText.includes('Phone');
    expect(hasChannelContent).toBe(true);
  });

  test('WhatsApp page does not expose API tokens in page content', async ({ merchantPage }) => {
    await merchantPage.goto('/dashboard/whatsapp');
    await merchantPage.waitForLoadState('networkidle');

    const pageContent = await merchantPage.content();
    expect(pageContent).not.toContain('META_CLOUD_ACCESS_TOKEN');
    expect(pageContent).not.toContain('META_APP_SECRET');
    // Meta access tokens start with EAA
    const tokenPattern = /EAA[A-Za-z0-9]{50,}/;
    expect(pageContent).not.toMatch(tokenPattern);
  });
});
