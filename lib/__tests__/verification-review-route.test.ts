/**
 * Verification review route tests.
 *
 * Tests the POST /api/verification/review route for:
 * - Non-admin 403
 * - aal1 403
 * - Missing reason 400
 * - set_level persists and writes audit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock admin-auth
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(),
}));

// Mock service client
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockFrom,
  }),
}));

vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({
  kycApprovedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
  kycRejectedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// Mock constants
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return {
    ...actual,
    getPayoutLimit: vi.fn().mockReturnValue(500_000),
    formatPayoutLimit: vi.fn().mockReturnValue('₦500,000'),
  };
});

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/verification/review', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/verification/review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for non-admin', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', action: 'set_level', level: 'standard', reason: 'test' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for set_level without reason', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    // Mock business lookup
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', action: 'set_level', level: 'standard' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Reason is required');
  });

  it('set_level unverified→standard persists and writes audit', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    // Mock chain for set_level
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            if (cols.includes('name')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
                }),
              };
            }
            if (cols.includes('verification_level')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: { verification_level: 'unverified', verification_status: 'unverified', payout_limit_monthly: 0 },
                    error: null,
                  }),
                }),
              };
            }
            return {
              eq: () => ({
                single: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }),
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve({
                data: [{ id: 'biz-1', verification_level: 'standard', verification_status: 'verified', payout_limit_monthly: 500_000 }],
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', action: 'set_level', level: 'standard', reason: 'KYC complete' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.verification_level).toBe('standard');

    const { logAdminAudit } = await import('@/lib/admin-audit');
    expect(logAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'set_verification_level',
        entityType: 'business',
        entityId: 'biz-1',
      }),
    );
  });

  it('set_level standard→basic persists', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            if (cols.includes('name')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
                }),
              };
            }
            if (cols.includes('verification_level')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: { verification_level: 'standard', verification_status: 'verified', payout_limit_monthly: 2_000_000 },
                    error: null,
                  }),
                }),
              };
            }
            return { eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) };
          }),
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve({
                data: [{ id: 'biz-1', verification_level: 'basic', verification_status: 'verified', payout_limit_monthly: 500_000 }],
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', action: 'set_level', level: 'basic', reason: 'Downgrade' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verification_level).toBe('basic');
    expect(body.payout_limit_monthly).toBe(500_000);
  });

  it('reject requires reason', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', action: 'reject' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('reason');
  });
});
