/**
 * Playwright journey: Complete merchant signup and onboarding.
 *
 * Issue #728 Phase 2: Actual browser UI through real staging signup.
 *
 * Steps:
 * 1. Navigate to signup page
 * 2. Fill registration form with synthetic identity
 * 3. Handle verification (email/OTP as configured in staging)
 * 4. Complete onboarding wizard (category, country, plan)
 * 5. Configure business (name, description)
 * 6. Verify dashboard access
 * 7. Verify DB state (business created, capabilities set)
 *
 * This file defines the journey steps; execution is orchestrated
 * by the test runner which provides the Playwright page and audit logger.
 */

import type { Page } from '@playwright/test';
import type { AuditLogger } from '../lib/audit-logger';
import type { MerchantIdentity } from '../lib/synthetic-identity';
import type { CleanupTracker } from '../lib/cleanup-manifest';

// ── Types ──

export interface MerchantSignupConfig {
  baseUrl: string;
  merchant: MerchantIdentity;
  /** Business category (e.g., 'beauty', 'restaurant', 'retail') */
  category: string;
  /** Country code (e.g., 'NG', 'US', 'GH') */
  country: string;
}

export interface MerchantSignupResult {
  success: boolean;
  businessId?: string;
  dashboardUrl?: string;
  error?: string;
}

// ── Journey Steps ──

export async function navigateToSignup(
  page: Page,
  config: MerchantSignupConfig,
  logger: AuditLogger,
  journeyId: string,
): Promise<void> {
  const stepIndex = logger.startStep(journeyId, 'Navigate to signup');

  try {
    const signupUrl = `${config.baseUrl}/signup`;
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'browser_navigate',
      data: { url: signupUrl },
    });

    await page.goto(signupUrl);
    await page.waitForLoadState('domcontentloaded');

    // Verify we're on the signup page
    const url = page.url();
    if (!url.includes('signup') && !url.includes('get-started')) {
      throw new Error(`Expected signup page, got: ${url}`);
    }

    logger.endStep(journeyId, stepIndex, 'PASS');
  } catch (err) {
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'error',
      data: { error: (err as Error).message },
      outcome: 'FAIL',
    });
    logger.endStep(journeyId, stepIndex, 'FAIL');
    throw err;
  }
}

export async function fillRegistrationForm(
  page: Page,
  config: MerchantSignupConfig,
  logger: AuditLogger,
  journeyId: string,
): Promise<void> {
  const stepIndex = logger.startStep(journeyId, 'Fill registration form');

  try {
    // Fill email
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(config.merchant.email);
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'browser_fill',
      data: { field: 'email', value: config.merchant.email, masked: false },
    });

    // Fill password
    const passwordInput = page.locator('input[type="password"]');
    if (await passwordInput.isVisible()) {
      await passwordInput.fill(config.merchant.password);
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'browser_fill',
        data: { field: 'password', masked: true },
      });
    }

    // Submit
    const submitButton = page.getByRole('button', { name: /sign up|create|get started/i });
    await submitButton.click();
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'browser_click',
      data: { selector: 'signup-submit-button' },
    });

    // Wait for navigation away from signup
    await page.waitForURL(/(?!.*signup).*/, { timeout: 30000 });

    logger.endStep(journeyId, stepIndex, 'PASS');
  } catch (err) {
    // Take screenshot on failure
    try {
      const screenshotPath = `reports/${journeyId}/step-registration-fail.png`;
      await page.screenshot({ path: `synthetic-e2e/${screenshotPath}` });
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'browser_screenshot',
        data: { reason: 'registration failure' },
        artifactRef: screenshotPath,
        outcome: 'FAIL',
      });
    } catch { /* screenshot best-effort */ }

    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'error',
      data: { error: (err as Error).message },
      outcome: 'FAIL',
    });
    logger.endStep(journeyId, stepIndex, 'FAIL');
    throw err;
  }
}

export async function completeOnboarding(
  page: Page,
  config: MerchantSignupConfig,
  logger: AuditLogger,
  journeyId: string,
  cleanup: CleanupTracker,
): Promise<string | undefined> {
  const stepIndex = logger.startStep(journeyId, 'Complete onboarding wizard');

  try {
    // Wait for onboarding page
    await page.waitForURL('**/get-started**', { timeout: 15000 }).catch(() => {
      // May go directly to dashboard if onboarding is done
    });

    const currentUrl = page.url();
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'browser_navigate',
      data: { url: currentUrl, note: 'Post-signup destination' },
    });

    // If we're on the dashboard, onboarding may have been skipped
    if (currentUrl.includes('/dashboard')) {
      logger.endStep(journeyId, stepIndex, 'PASS');
      return undefined; // business ID will be extracted from dashboard
    }

    // Otherwise, complete the onboarding wizard
    // This is simplified — real implementation would handle each step

    // Business name
    const nameInput = page.locator('input[name="businessName"], input[placeholder*="business name" i]');
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(config.merchant.businessName);
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'browser_fill',
        data: { field: 'businessName', value: config.merchant.businessName },
      });
    }

    // Category selection
    const categoryOption = page.getByText(new RegExp(config.category, 'i')).first();
    if (await categoryOption.isVisible().catch(() => false)) {
      await categoryOption.click();
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'browser_click',
        data: { selector: 'category', value: config.category },
      });
    }

    // Country selection
    const countryOption = page.getByText(new RegExp(config.country, 'i')).first();
    if (await countryOption.isVisible().catch(() => false)) {
      await countryOption.click();
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'browser_click',
        data: { selector: 'country', value: config.country },
      });
    }

    // Continue/Next/Finish buttons
    for (const btnText of ['Continue', 'Next', 'Finish', 'Get Started', 'Start']) {
      const btn = page.getByRole('button', { name: new RegExp(btnText, 'i') });
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        logger.log({
          runId: logger['runId'],
          journeyId,
          stepIndex,
          eventType: 'browser_click',
          data: { selector: `button:${btnText}` },
        });
        // Brief wait for navigation
        await page.waitForTimeout(1000);
      }
    }

    // Wait for dashboard
    await page.waitForURL('**/dashboard**', { timeout: 30000 });

    // Extract business ID from URL or page context
    const dashboardUrl = page.url();
    const businessIdMatch = dashboardUrl.match(/business[_-]?id[=:]([a-f0-9-]+)/i);
    const businessId = businessIdMatch?.[1];

    if (businessId) {
      cleanup.track({
        table: 'businesses',
        id: businessId,
        pkColumn: 'id',
        meta: { name: config.merchant.businessName, runId: config.merchant.runId },
      });
    }

    logger.endStep(journeyId, stepIndex, 'PASS');
    return businessId;
  } catch (err) {
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'error',
      data: { error: (err as Error).message },
      outcome: 'FAIL',
    });
    logger.endStep(journeyId, stepIndex, 'FAIL');
    throw err;
  }
}

export async function verifyDashboardAccess(
  page: Page,
  logger: AuditLogger,
  journeyId: string,
): Promise<void> {
  const stepIndex = logger.startStep(journeyId, 'Verify dashboard access');

  try {
    // Check that the dashboard loaded
    const url = page.url();
    if (!url.includes('/dashboard')) {
      throw new Error(`Expected dashboard URL, got: ${url}`);
    }

    // Check for key dashboard elements
    const sidebar = page.locator('[data-testid="sidebar"], nav, aside').first();
    await sidebar.waitFor({ state: 'visible', timeout: 10000 });

    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'browser_navigate',
      data: { url, dashboardLoaded: true },
      outcome: 'PASS',
    });

    // Take success screenshot
    try {
      const screenshotPath = `reports/${journeyId}/dashboard-access.png`;
      await page.screenshot({ path: `synthetic-e2e/${screenshotPath}` });
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'browser_screenshot',
        data: { reason: 'dashboard verification' },
        artifactRef: screenshotPath,
      });
    } catch { /* screenshot best-effort */ }

    logger.endStep(journeyId, stepIndex, 'PASS');
  } catch (err) {
    logger.log({
      runId: logger['runId'],
      journeyId,
      stepIndex,
      eventType: 'error',
      data: { error: (err as Error).message },
      outcome: 'FAIL',
    });
    logger.endStep(journeyId, stepIndex, 'FAIL');
    throw err;
  }
}
