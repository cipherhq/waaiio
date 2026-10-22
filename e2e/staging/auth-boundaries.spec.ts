/**
 * Staging QA: Authorization boundary checks
 *
 * Verifies that unauthenticated requests to protected endpoints
 * are correctly rejected. These tests do NOT require staging
 * credentials — they test the negative case.
 *
 * NOTE: Cross-tenant isolation tests (merchant A cannot see merchant B's data)
 * require the QA Customer and QA Admin identities (Phase C).
 */

import { test, expect } from '@playwright/test';
import {
  assertStagingTarget,
  installRequestGuard,
  verifyStagingIdentity,
} from '../fixtures/staging-guard';

const BASE_URL = process.env.E2E_STAGING_URL
  || process.env.PLAYWRIGHT_BASE_URL
  || 'http://localhost:3000';

test.describe('Auth boundaries — unauthenticated access', () => {
  test.beforeAll(async () => {
    // Safety check: never run against production
    assertStagingTarget(BASE_URL);

    // Verify deployment identity for remote targets
    const { hostname } = new URL(BASE_URL);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      await verifyStagingIdentity(
        BASE_URL,
        process.env.E2E_DEPLOYMENT_SHA || undefined,
      );
    }
  });

  test('dashboard redirects unauthenticated user to login', async ({ page }) => {
    const blockedAttempts = await installRequestGuard(page, BASE_URL);

    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');

    // Verify redirect stayed on the approved staging origin
    const currentOrigin = new URL(page.url()).origin.toLowerCase();
    const expectedOrigin = new URL(BASE_URL).origin.toLowerCase();
    expect(currentOrigin).toBe(expectedOrigin);

    if (blockedAttempts.length > 0) {
      throw new Error(
        `FAIL-CLOSED: ${blockedAttempts.length} blocked request(s):\n` +
        blockedAttempts.map((a) => `  - ${a}`).join('\n')
      );
    }
  });

  test('dashboard/settings redirects unauthenticated user', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/settings`);
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');

    // Verify redirect stayed on staging
    const currentOrigin = new URL(page.url()).origin.toLowerCase();
    const expectedOrigin = new URL(BASE_URL).origin.toLowerCase();
    expect(currentOrigin).toBe(expectedOrigin);
  });

  test('dashboard/financials redirects unauthenticated user', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/financials`);
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');

    // Verify redirect stayed on staging
    const currentOrigin = new URL(page.url()).origin.toLowerCase();
    const expectedOrigin = new URL(BASE_URL).origin.toLowerCase();
    expect(currentOrigin).toBe(expectedOrigin);
  });

  test('protected API routes return 401 without auth', async ({ request }) => {
    const routes = [
      '/api/dashboard/recommendations',
      '/api/dashboard/alerts',
      '/api/dashboard/switch-business',
    ];

    for (const route of routes) {
      const response = await request.get(`${BASE_URL}${route}`);
      expect(
        [401, 403].includes(response.status()),
        `Expected 401/403 for ${route}, got ${response.status()}`
      ).toBe(true);
    }
  });

  test('admin API routes reject unauthenticated requests', async ({ request }) => {
    // NOTE: This tests the unauthenticated case only. Testing that
    // an authenticated non-admin merchant is also rejected requires
    // the QA Merchant identity and is deferred to Phase C.
    const routes = [
      { method: 'GET' as const, path: '/api/admin/customers' },
      { method: 'POST' as const, path: '/api/admin/impersonate' },
    ];

    for (const route of routes) {
      const response = route.method === 'GET'
        ? await request.get(`${BASE_URL}${route.path}`)
        : await request.post(`${BASE_URL}${route.path}`, { data: {} });
      expect(
        [401, 403].includes(response.status()),
        `Expected 401/403 for ${route.path}, got ${response.status()}`
      ).toBe(true);
    }
  });
});
