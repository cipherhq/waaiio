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
import { assertStagingTarget } from '../fixtures/staging-guard';

const BASE_URL = process.env.E2E_STAGING_URL
  || process.env.PLAYWRIGHT_BASE_URL
  || 'http://localhost:3000';

test.describe('Auth boundaries — unauthenticated access', () => {
  test.beforeAll(() => {
    // Safety check: never run against production
    assertStagingTarget(BASE_URL);
  });

  test('dashboard redirects unauthenticated user to login', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');
  });

  test('dashboard/settings redirects unauthenticated user', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/settings`);
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');
  });

  test('dashboard/financials redirects unauthenticated user', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard/financials`);
    await page.waitForURL(/login/);
    expect(page.url()).toContain('/login');
  });

  test('protected API routes return 401 without auth', async ({ request }) => {
    const routes = [
      '/api/dashboard/recommendations',
      '/api/dashboard/alerts',
      '/api/businesses',
    ];

    for (const route of routes) {
      const response = await request.get(`${BASE_URL}${route}`);
      expect(
        [401, 403].includes(response.status()),
        `Expected 401/403 for ${route}, got ${response.status()}`
      ).toBe(true);
    }
  });

  test('admin API routes reject non-admin requests', async ({ request }) => {
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
