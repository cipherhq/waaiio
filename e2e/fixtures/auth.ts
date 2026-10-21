/**
 * Authenticated Playwright fixtures for staging QA.
 *
 * Provides `merchantPage` — a browser context logged in as the QA merchant.
 * Auth state is held in-memory only — no storageState file is written to disk.
 * Request interception prevents credentials from leaking to production origins.
 *
 * Fail-closed: missing credentials throw BLOCKED, never silently skip.
 *
 * Identity design (accounts created through approved secure workflow, not here):
 *   - QA Merchant: dedicated staging-only merchant for dashboard journeys
 *   - QA Customer: (Phase C) dedicated customer for public-facing flows
 *   - QA Admin:    (Phase C) dedicated admin with minimum privileges
 */

import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  assertStagingCredentials,
  assertStagingTarget,
  assertPageSupabaseIsStaging,
  installRequestGuard,
  collectStagingMetadata,
  type StagingMetadata,
} from './staging-guard';

// ── Credential sanitization ──

/** Env var names whose values must be redacted from any output */
const REDACT_VARS = [
  'E2E_STAGING_PASSWORD',
  'E2E_STAGING_EMAIL',
  'E2E_ADMIN_PASSWORD',
  'E2E_ADMIN_EMAIL',
  'E2E_CUSTOMER_PASSWORD',
  'E2E_CUSTOMER_EMAIL',
] as const;

/**
 * Redacts known credential values from a string.
 * Used to sanitize any text that might appear in logs or reports.
 */
export function redactCredentials(input: string): string {
  let result = input;
  for (const varName of REDACT_VARS) {
    const value = process.env[varName];
    if (value && value.length > 0) {
      result = result.split(value).join(`[REDACTED:${varName}]`);
    }
  }
  return result;
}

// ── Fixtures ──

type StagingFixtures = {
  /** Authenticated merchant page — logged in, on dashboard */
  merchantPage: Page;
  /** Staging metadata for evidence reporting */
  stagingMeta: StagingMetadata;
  /** The staging base URL (validated) */
  stagingBaseUrl: string;
};

export const test = base.extend<StagingFixtures>({
  /**
   * Validated staging base URL. Fails if pointing at production.
   */
  stagingBaseUrl: async ({}, use) => {
    const { baseUrl } = assertStagingCredentials();
    assertStagingTarget(baseUrl);
    await use(baseUrl);
  },

  /**
   * Test-run metadata for evidence reporting.
   */
  stagingMeta: async ({ stagingBaseUrl }, use) => {
    const meta = collectStagingMetadata(stagingBaseUrl);
    await use(meta);
  },

  /**
   * Authenticated merchant page.
   *
   * 1. Creates a fresh browser context (no storageState on disk).
   * 2. Installs request interception to block production origins
   *    BEFORE any navigation or credential entry.
   * 3. Logs in via the real login page.
   * 4. Verifies Supabase config is staging, not production.
   * 5. Closes context on teardown, destroying in-memory auth state.
   */
  merchantPage: async ({ browser, stagingBaseUrl }, use) => {
    const { email, password } = assertStagingCredentials();

    // Create a fresh context — no storageState file path
    const context: BrowserContext = await browser.newContext({
      baseURL: stagingBaseUrl,
    });

    const page = await context.newPage();

    // ── Install request guard BEFORE any navigation ──
    // This prevents credentials from being sent to production if
    // the staging deployment is misconfigured with production URLs.
    const blockedAttempts = await installRequestGuard(page, stagingBaseUrl);

    // ── Login flow ──
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    // ── Pre-credential redirect protection ──
    // Verify the page is still on the expected staging origin BEFORE
    // entering any credentials. A redirect to an unexpected origin
    // would mean credentials could be sent to an attacker.
    const expectedOrigin = new URL(stagingBaseUrl).origin.toLowerCase();
    const currentOrigin = new URL(page.url()).origin.toLowerCase();
    if (currentOrigin !== expectedOrigin) {
      throw new Error(
        `FAIL-CLOSED: Login page redirected to unexpected origin "${currentOrigin}". ` +
        `Expected "${expectedOrigin}". Credentials were NOT entered. ` +
        `This may indicate a misconfigured staging deployment.`
      );
    }

    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');

    await expect(emailInput).toBeVisible({ timeout: 10000 });
    await emailInput.fill(email);

    // Password field may be hidden behind auth mode toggle
    if (!(await passwordInput.isVisible())) {
      const emailTab = page.getByText(/email/i).first();
      if (await emailTab.isVisible()) {
        await emailTab.click();
        await expect(passwordInput).toBeVisible({ timeout: 5000 });
      }
    }

    // ── Second redirect check before password entry ──
    const prePasswordOrigin = new URL(page.url()).origin.toLowerCase();
    if (prePasswordOrigin !== expectedOrigin) {
      throw new Error(
        `FAIL-CLOSED: Page navigated away from staging origin before password entry. ` +
        `Current: "${prePasswordOrigin}", expected: "${expectedOrigin}". ` +
        `Credentials were NOT fully entered.`
      );
    }

    await passwordInput.fill(password);

    const submitButton = page.getByRole('button', { name: /sign in/i });
    await submitButton.click();

    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard**', { timeout: 30000 });

    // ── Post-login safety checks ──
    await assertPageSupabaseIsStaging(page);

    // Report any blocked requests (test will continue but evidence is logged)
    if (blockedAttempts.length > 0) {
      console.warn(
        `[auth-guard] Blocked ${blockedAttempts.length} production-bound request(s):\n` +
        blockedAttempts.map((a) => `  - ${a}`).join('\n')
      );
    }

    await use(page);

    // ── Cleanup: close context, destroying in-memory auth state ──
    await context.close();
  },
});

export { expect };
