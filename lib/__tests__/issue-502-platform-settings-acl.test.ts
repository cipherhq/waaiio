/**
 * Issue #502: platform_settings service_role UPDATE ACL
 *
 * A. DB ACL tests (require TEST_DATABASE_URL — real PostgreSQL)
 *    - service_role has SELECT on platform_settings
 *    - service_role has UPDATE on platform_settings
 *    - anon has NO UPDATE on platform_settings
 *    - authenticated has NO UPDATE on platform_settings
 *    - RLS remains enabled
 *
 * B. Route-level tests (mock-based, no DB needed)
 *    - Authorized admin PUT -> succeeds
 *    - Non-admin PUT -> denied (403)
 *
 * Run:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/issue-502-platform-settings-acl.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

// ══════════════════════════════════════════════════════════════════════
// A. DB ACL tests — require TEST_DATABASE_URL
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M420: platform_settings ACL (DB)', () => {
  it('service_role has SELECT on platform_settings', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.platform_settings', 'SELECT')`,
    );
    expect(result).toBe('t');
  });

  it('service_role has UPDATE on platform_settings', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.platform_settings', 'UPDATE')`,
    );
    expect(result).toBe('t');
  });

  it('anon has NO UPDATE on platform_settings', () => {
    const result = psql(
      `SELECT has_table_privilege('anon', 'public.platform_settings', 'UPDATE')`,
    );
    expect(result).toBe('f');
  });

  it('authenticated has NO UPDATE on platform_settings', () => {
    const result = psql(
      `SELECT has_table_privilege('authenticated', 'public.platform_settings', 'UPDATE')`,
    );
    expect(result).toBe('f');
  });

  it('RLS remains enabled on platform_settings', () => {
    const result = psql(
      `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_settings'`,
    );
    expect(result).toBe('t');
  });
});

// ══════════════════════════════════════════════════════════════════════
// A2. DB UPDATE/readback proof — require TEST_DATABASE_URL
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M420: platform_settings real UPDATE proof (DB)', () => {
  it('service_role can UPDATE platform_settings and read back the change', () => {
    const readback = psql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE platform_settings SET value = '"uat-502-proof"'::jsonb WHERE key = 'site_announcement';
      SELECT value::text FROM platform_settings WHERE key = 'site_announcement';
      ROLLBACK;
    `);
    expect(readback).toContain('uat-502-proof');
  });

  it('anon cannot UPDATE platform_settings', () => {
    const r = psqlMayFail(`SET ROLE anon; UPDATE platform_settings SET value = '"hacked"'::jsonb WHERE key = 'site_announcement'; RESET ROLE;`);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });

  it('authenticated cannot UPDATE platform_settings', () => {
    const r = psqlMayFail(`SET ROLE authenticated; UPDATE platform_settings SET value = '"hacked"'::jsonb WHERE key = 'site_announcement'; RESET ROLE;`);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B. Route-level tests — mock-based (no DB needed)
// ══════════════════════════════════════════════════════════════════════

// Mock requirePlatformAdmin
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(),
}));

// Mock createServiceClient
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

describe('PUT /api/admin/site-announcement (route-level)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 403 when caller is not a platform admin', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { PUT } = await import(
      '@/app/api/admin/site-announcement/route'
    );

    const request = new Request('http://localhost/api/admin/site-announcement', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, headline: '', message: '' }),
    });

    const response = await PUT(request as any);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns success when authorized admin PUT updates announcement', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-uuid',
      userId: 'admin-uuid',
      email: 'admin@test.com',
      role: 'admin',
    });

    const savedConfig = {
      enabled: true,
      type: 'general',
      headline: 'Test headline',
      message: 'Test message',
      target_date: null,
      cta_text: null,
      cta_link: null,
      style: 'brand',
    };
    const savedUpdatedAt = '2026-10-02T12:00:00.000Z';

    const { createServiceClient } = await import('@/lib/supabase/service');
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { value: savedConfig, updated_at: savedUpdatedAt },
      error: null,
    });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqUpdatedAt = vi.fn().mockReturnValue({ select });
    const eqKey = vi.fn().mockReturnValue({ eq: eqUpdatedAt });
    const mockUpdate = vi.fn().mockReturnValue({ eq: eqKey });
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({ update: mockUpdate }),
    } as any);

    const { PUT } = await import(
      '@/app/api/admin/site-announcement/route'
    );

    const request = new Request('http://localhost/api/admin/site-announcement', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        type: 'general',
        headline: 'Test headline',
        message: 'Test message',
        style: 'brand',
        expected_updated_at: '2026-10-02T10:00:00.000Z',
      }),
    });

    const response = await PUT(request as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.config.enabled).toBe(true);
    expect(body.config.headline).toBe('Test headline');
    expect(body.updated_at).toBe(savedUpdatedAt);
  });
});
