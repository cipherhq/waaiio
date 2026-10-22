/**
 * Authenticated Playwright fixtures for staging QA.
 *
 * Provides `merchantPage` — a browser context logged in as the QA merchant.
 * Auth state is captured once per worker (not per test) to minimize
 * repeated login side effects (session-bind writes, notification emails).
 * Each test gets its own browser context with the stored auth state,
 * preserving test isolation while avoiding redundant logins.
 *
 * Request interception prevents credentials from leaking to production origins.
 * Guard violations cause test failure (fail-closed), never silent warnings.
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
  verifyStagingIdentity,
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

// ── Fixture types ──

type StagingWorkerFixtures = {
  /** Auth state captured once per worker — reused across tests */
  merchantAuth: {
    storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
  };
};

type StagingTestFixtures = {
  /** Authenticated merchant page — fresh context per test, shared auth */
  merchantPage: Page;
  /** Staging metadata for evidence reporting */
  stagingMeta: StagingMetadata;
  /** The staging base URL (validated) */
  stagingBaseUrl: string;
};

export const test = base.extend<StagingTestFixtures, StagingWorkerFixtures>({
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
   * Worker-scoped auth: login once per worker, capture storageState.
   *
   * This avoids repeated real logins that trigger session-bind side effects
   * (profile updates, login notification emails) for every test.
   * The captured storageState is reused by per-test merchantPage contexts.
   */
  merchantAuth: [async ({ browser }, use) => {
    const { email, password, baseUrl } = assertStagingCredentials();
    assertStagingTarget(baseUrl);

    // ── Verify deployment identity BEFORE any navigation or credential entry ──
    // This prevents credentials from being sent to an impersonating deployment
    // that passes the hostname allowlist but is not the real staging project.
    const { hostname } = new URL(baseUrl);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      await verifyStagingIdentity(
        baseUrl,
        process.env.E2E_DEPLOYMENT_SHA || undefined,
      );
    }

    const context: BrowserContext = await browser.newContext({
      baseURL: baseUrl,
    });
    const page = await context.newPage();

    // ── Install request guard BEFORE any navigation ──
    const blockedAttempts = await installRequestGuard(page, baseUrl);

    // ── Login flow ──
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    // ── Pre-credential redirect protection ──
    const expectedOrigin = new URL(baseUrl).origin.toLowerCase();
    const currentOrigin = new URL(page.url()).origin.toLowerCase();
    if (currentOrigin !== expectedOrigin) {
      throw new Error(
        `FAIL-CLOSED: Login page redirected to unexpected origin "${currentOrigin}". ` +
        `Expected "${expectedOrigin}". Credentials were NOT entered.`
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
        `Current: "${prePasswordOrigin}", expected: "${expectedOrigin}".`
      );
    }

    await passwordInput.fill(password);
    const submitButton = page.getByRole('button', { name: /sign in/i });
    await submitButton.click();

    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard**', { timeout: 30000 });

    // ── Post-login safety checks ──
    await assertPageSupabaseIsStaging(page);

    // ── Fail-closed: guard violations during login abort the worker ──
    if (blockedAttempts.length > 0) {
      throw new Error(
        `FAIL-CLOSED: ${blockedAttempts.length} blocked request(s) during login:\n` +
        blockedAttempts.map((a) => `  - ${a}`).join('\n')
      );
    }

    // Capture auth state in memory — no file written to disk
    const storageState = await context.storageState();
    await context.close();

    await use({ storageState });
  }, { scope: 'worker' }],

  /**
   * Authenticated merchant page — fresh context per test.
   *
   * Uses the worker-scoped storageState (no repeated login).
   * Inherits project device settings (viewport, userAgent) from config.
   * Installs request guard; violations cause test failure on teardown.
   */
  merchantPage: async ({ browser, merchantAuth, stagingBaseUrl }, use, testInfo) => {
    // Inherit project device settings (viewport, userAgent, etc.)
    const projectUse = testInfo.project.use || {};
    const context: BrowserContext = await browser.newContext({
      ...projectUse,
      baseURL: stagingBaseUrl,
      storageState: merchantAuth.storageState,
    });

    const page = await context.newPage();

    // ── Install request guard on this test's page ──
    const blockedAttempts = await installRequestGuard(page, stagingBaseUrl);

    await use(page);

    // ── Fail-closed: guard violations during test cause failure ──
    if (blockedAttempts.length > 0) {
      throw new Error(
        `FAIL-CLOSED: ${blockedAttempts.length} blocked request(s) during test:\n` +
        blockedAttempts.map((a) => `  - ${a}`).join('\n')
      );
    }

    // ── Cleanup: close context, destroying in-memory auth state ──
    await context.close();
  },
});

export { expect };
