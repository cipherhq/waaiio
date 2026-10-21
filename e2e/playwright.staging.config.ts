/**
 * Playwright config for staging QA tests.
 *
 * Inherits from the root config but overrides artifact settings
 * to prevent credential leakage:
 *   - trace: 'off' (no HAR or network recording)
 *   - screenshot: 'off' (no screenshots that might capture credentials)
 *   - video: 'off' (no video recording)
 *
 * Used in CI via: --config=e2e/playwright.staging.config.ts
 * Local runs use the root config (traces/screenshots for debugging).
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './staging',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : 'html',
  timeout: 30000,

  use: {
    baseURL: process.env.E2E_STAGING_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    // ── Artifact safety: all disabled in staging CI ──
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] },
    },
  ],

  // No webServer — staging tests target a deployed URL, not localhost dev
});
