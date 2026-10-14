/**
 * Admin translations API route-level tests
 *
 * Invokes the real GET/PUT/DELETE handlers with mocked Supabase and
 * admin auth to verify authorization, validation, audit logging,
 * and cache invalidation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mock state ──

const { mockAdminAuth, mockFrom, mockServiceClient, mockInvalidateCache, mockLogAdminAudit } =
  vi.hoisted(() => {
    const mockFrom = vi.fn();
    const mockServiceClient = { from: mockFrom };
    const mockAdminAuth = vi.fn();
    const mockInvalidateCache = vi.fn();
    const mockLogAdminAudit = vi.fn();
    return { mockAdminAuth, mockFrom, mockServiceClient, mockInvalidateCache, mockLogAdminAudit };
  });

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: mockAdminAuth,
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockServiceClient,
}));

vi.mock('@/lib/bot/translations', () => ({
  invalidatePlatformOverridesCache: mockInvalidateCache,
}));

vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: mockLogAdminAudit,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Mock flow-localization exports to provide realistic key sets
vi.mock('@/lib/bot/flows/flow-localization', () => ({
  ALL_FLOW_COPY_KEYS: ['greeting', 'menu.title', 'lang.picker_body', 'lang.not_available', 'booking.confirm'],
  BUTTON_TITLE_KEYS: ['booking.confirm'],
  LIST_TITLE_KEYS: ['menu.title'],
  PLACEHOLDER_SCHEMA: new Map([
    ['lang.not_available', ['langName']],
  ]),
  KEYS_WITH_COMMANDS: [],
  getFlowCopy: vi.fn((lang: string, key: string) => {
    const copies: Record<string, string> = {
      greeting: 'Welcome!',
      'menu.title': 'Main Menu',
      'lang.picker_body': 'Please choose your preferred language:',
      'lang.not_available': '{langName} is not available for this business right now.',
      'booking.confirm': 'Confirm',
    };
    return copies[key] || key;
  }),
}));

vi.mock('@/lib/bot/languages', () => ({
  isSupportedLanguage: vi.fn((code: string) => {
    return ['en', 'pcm', 'yo', 'fr', 'es', 'ig', 'ha', 'tw'].includes(code);
  }),
}));

import { GET, PUT, DELETE } from '@/app/api/admin/translations/route';

// ── Helpers ──

const ADMIN_FULL = {
  id: 'admin-001',
  userId: 'admin-001',
  email: 'admin@waaiio.com',
  role: 'admin',
  aal: 'aal2',
  bearerToken: 'test-bearer',
};

const ADMIN_SUPPORT = {
  id: 'support-001',
  userId: 'support-001',
  email: 'support@waaiio.com',
  role: 'support',
  aal: 'aal2',
  bearerToken: 'test-bearer',
};

function makeRequest(
  method: string,
  body?: Record<string, unknown>,
): NextRequest {
  const url = 'http://localhost:3000/api/admin/translations';
  if (method === 'GET') return new NextRequest(url, { method });
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Configure mockFrom to return a chainable Supabase mock for a given table.
 */
function setupTableMock(overrides?: {
  upsertResult?: { error: { message: string } | null };
  selectResult?: { data: unknown[] | null; error: { message: string } | null };
  deleteResult?: { error: { message: string } | null; count: number | null };
}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'bot_translation_platform_overrides') {
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue(
              overrides?.selectResult ?? { data: [], error: null },
            ),
          }),
        }),
        upsert: vi.fn().mockResolvedValue(
          overrides?.upsertResult ?? { error: null },
        ),
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue(
              overrides?.deleteResult ?? { error: null, count: 1 },
            ),
          }),
        }),
      };
    }
    // Default: admin_audit_logs or other tables
    return {
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogAdminAudit.mockResolvedValue({ error: undefined });
  setupTableMock();
});

// ═══════════════════════════════════════════════════════
// 1. Non-admin -> 403
// ═══════════════════════════════════════════════════════

describe('GET /api/admin/translations — authorization', () => {
  it('returns 403 when requirePlatformAdmin returns null', async () => {
    mockAdminAuth.mockResolvedValueOnce(null);

    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('returns 200 with overrides when admin is authenticated', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_SUPPORT);

    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toHaveProperty('overrides');
    expect(json).toHaveProperty('allKeys');
    expect(Array.isArray(json.overrides)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 2. Admin with role 'support' on PUT -> 403
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — role enforcement', () => {
  it('returns 403 for support role (PUT requires admin role)', async () => {
    // requirePlatformAdmin returns null when the role doesn't match requiredRole
    mockAdminAuth.mockResolvedValueOnce(null);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'pcm', key: 'greeting', value: 'Ehen, welcome!' }],
      }),
    );
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });
});

// ═══════════════════════════════════════════════════════
// 3. Admin with role 'admin' on PUT -> 200
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — successful upsert', () => {
  it('returns 200 and upserts overrides when admin role is present', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'pcm', key: 'greeting', value: 'Ehen, welcome!' }],
      }),
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.upserted).toBe(1);

    // Verify the upsert was called on the overrides table
    expect(mockFrom).toHaveBeenCalledWith('bot_translation_platform_overrides');
  });
});

// ═══════════════════════════════════════════════════════
// 4. Successful PUT writes to admin_audit_logs
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — audit logging', () => {
  it('calls logAdminAudit after successful upsert', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'pcm', key: 'greeting', value: 'Ehen, welcome!' }],
      }),
    );

    expect(mockLogAdminAudit).toHaveBeenCalledTimes(1);
    const auditCall = mockLogAdminAudit.mock.calls[0][0];
    expect(auditCall.actorId).toBe(ADMIN_FULL.userId);
    expect(auditCall.action).toBe('upsert_platform_translation_overrides');
    expect(auditCall.entityType).toBe('platform_translations');
    expect(auditCall.details.count).toBe(1);
    expect(auditCall.details.keys).toContain('pcm.greeting');
  });
});

// ═══════════════════════════════════════════════════════
// 5. Successful PUT invalidates platform overrides cache
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — cache invalidation', () => {
  it('calls invalidatePlatformOverridesCache after successful upsert', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'pcm', key: 'greeting', value: 'Ehen, welcome!' }],
      }),
    );

    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════
// 6. Successful DELETE removes override and audit-logs
// ═══════════════════════════════════════════════════════

describe('DELETE /api/admin/translations — delete + audit', () => {
  it('deletes override and writes audit log', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);
    setupTableMock({
      deleteResult: { error: null, count: 1 },
    });

    const res = await DELETE(
      makeRequest('DELETE', { lang: 'pcm', key: 'greeting' }),
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(1);

    // Cache should be invalidated
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);

    // Audit log should be written
    expect(mockLogAdminAudit).toHaveBeenCalledTimes(1);
    const auditCall = mockLogAdminAudit.mock.calls[0][0];
    expect(auditCall.action).toBe('delete_platform_translation_overrides');
    expect(auditCall.details.targets).toContain('pcm.greeting');
    expect(auditCall.details.deleted).toBe(1);
  });

  it('returns 403 for non-admin role on DELETE', async () => {
    mockAdminAuth.mockResolvedValueOnce(null);

    const res = await DELETE(
      makeRequest('DELETE', { lang: 'pcm', key: 'greeting' }),
    );
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// 7. PUT with invalid key -> 400
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — validation: invalid key', () => {
  it('returns 400 when key does not exist in ALL_FLOW_COPY_KEYS', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [
          { lang: 'en', key: 'totally_fake_key_xyz', value: 'Some text' },
        ],
      }),
    );
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.errors).toBeDefined();
    expect(json.errors.some((e: string) => e.includes('Unknown key'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 8. PUT with empty value -> 400
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — validation: empty value', () => {
  it('returns 400 when value is empty string', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'pcm', key: 'greeting', value: '' }],
      }),
    );
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.errors).toBeDefined();
    expect(json.errors.some((e: string) => e.includes('Empty value'))).toBe(true);
  });

  it('returns 400 when value is whitespace only', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'pcm', key: 'greeting', value: '   ' }],
      }),
    );
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.errors).toBeDefined();
    expect(json.errors.some((e: string) => e.includes('Empty value'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// Additional edge-case coverage
// ═══════════════════════════════════════════════════════

describe('PUT /api/admin/translations — placeholder validation', () => {
  it('returns 400 when required placeholder is missing', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    // lang.not_available requires {langName} placeholder
    const res = await PUT(
      makeRequest('PUT', {
        overrides: [
          { lang: 'pcm', key: 'lang.not_available', value: 'E no dey available' },
        ],
      }),
    );
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.errors.some((e: string) => e.includes('missing required placeholder'))).toBe(true);
  });

  it('returns 200 when required placeholder is present', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [
          {
            lang: 'pcm',
            key: 'lang.not_available',
            value: '{langName} no dey available for this business now.',
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/admin/translations — unsupported language', () => {
  it('returns 400 when lang is not a supported language code', async () => {
    mockAdminAuth.mockResolvedValueOnce(ADMIN_FULL);

    const res = await PUT(
      makeRequest('PUT', {
        overrides: [{ lang: 'zz_FAKE', key: 'greeting', value: 'Hello' }],
      }),
    );
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.errors.some((e: string) => e.includes('Unsupported language'))).toBe(true);
  });
});
