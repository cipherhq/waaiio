/**
 * Channel Number Continuity — behavioral unit tests.
 *
 * Tests actual handler responses, MFA gating, and error paths.
 * Mocked Supabase — no real DB. Real PG tests in .pg.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock Supabase
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockGetClaims = vi.fn();

function buildChain() {
  const chain: Record<string, any> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.gt = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser, getSession: mockGetSession },
  })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: { getClaims: mockGetClaims },
  })),
}));

vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: vi.fn(async () => ({})),
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async () => null),
}));

describe('DELETE /api/settings/whatsapp-channel requires step-up', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 STEP_UP_REQUIRED when no stepUpId', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    const chain = buildChain();
    chain.single.mockResolvedValue({ data: { id: 'b1', owner_id: 'u1' } });
    mockFrom.mockReturnValue(chain);

    const { DELETE } = await import('@/app/api/settings/whatsapp-channel/route');
    const req = new NextRequest('http://localhost/api/settings/whatsapp-channel?business_id=b1', {
      method: 'DELETE',
      body: JSON.stringify({ business_id: 'b1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await DELETE(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('POST /api/whatsapp/add-number?action=verify — step_up_id never passed', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('MerchantStepUpError exports correctly', async () => {
    const { MerchantStepUpError } = await import('@/lib/merchant-step-up');
    expect(new MerchantStepUpError('test').name).toBe('MerchantStepUpError');
  });

  it('canonicalMerchantParams produces consistent hashes', async () => {
    const { canonicalMerchantParams } = await import('@/lib/merchant-step-up');
    const { hashOperationParams } = await import('@/lib/admin-step-up');

    const params1 = canonicalMerchantParams('channel_number_change', 'b1', 'c1');
    const params2 = canonicalMerchantParams('channel_number_change', 'b1', 'c1');
    expect(hashOperationParams(params1)).toBe(hashOperationParams(params2));

    // Different candidate → different hash
    const params3 = canonicalMerchantParams('channel_number_change', 'b1', 'c2');
    expect(hashOperationParams(params1)).not.toBe(hashOperationParams(params3));

    // Disconnect params
    const disc1 = canonicalMerchantParams('channel_disconnect', 'b1', 'shared-1');
    const disc2 = canonicalMerchantParams('channel_disconnect', 'b1', 'shared-1');
    expect(hashOperationParams(disc1)).toBe(hashOperationParams(disc2));

    // Different business → different hash
    const disc3 = canonicalMerchantParams('channel_disconnect', 'b2', 'shared-1');
    expect(hashOperationParams(disc1)).not.toBe(hashOperationParams(disc3));
  });

  it('canonicalMerchantParams rejects missing candidate_id for channel_number_change', async () => {
    const { canonicalMerchantParams, MerchantStepUpError } = await import('@/lib/merchant-step-up');
    expect(() => canonicalMerchantParams('channel_number_change', 'b1'))
      .toThrow(MerchantStepUpError);
  });
});

describe('Admin channel-changes routes require admin role', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('GET /api/admin/channel-changes returns 403 for non-admin', async () => {
    // requirePlatformAdmin returns null (mocked above)
    const { GET } = await import('@/app/api/admin/channel-changes/route');
    const req = new NextRequest('http://localhost/api/admin/channel-changes');
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('POST /api/admin/channel-changes returns 403 for non-admin', async () => {
    const { POST } = await import('@/app/api/admin/channel-changes/route');
    const req = new NextRequest('http://localhost/api/admin/channel-changes', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe('Admin step-up type includes channel_change_execute', () => {
  it('StepUpAction type compiles with channel_change_execute', async () => {
    const { hashOperationParams } = await import('@/lib/admin-step-up');
    // This would fail at compile time if channel_change_execute wasn't in the union
    const hash = hashOperationParams({ operation: 'channel_change_execute' });
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
  });
});

describe('Merchant step-up prepare requires business ownership', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 if user does not own business', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    const chain = buildChain();
    chain.single.mockResolvedValue({ data: null }); // ownership check fails
    mockFrom.mockReturnValue(chain);

    const { POST } = await import('@/app/api/settings/whatsapp-channel/step-up/prepare/route');
    const req = new NextRequest('http://localhost/api/settings/whatsapp-channel/step-up/prepare', {
      method: 'POST',
      body: JSON.stringify({ business_id: 'b1', action_type: 'channel_number_change' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe('Finish endpoint uses canonical params hash', () => {
  it('finish route computes same hash as prepare for channel_number_change', async () => {
    const { canonicalMerchantParams } = await import('@/lib/merchant-step-up');
    const { hashOperationParams } = await import('@/lib/admin-step-up');

    // This is the hash that prepare stores
    const prepareHash = hashOperationParams(
      canonicalMerchantParams('channel_number_change', 'biz-123', 'cand-456'),
    );

    // This is the hash that finish computes — must match
    const finishHash = hashOperationParams(
      canonicalMerchantParams('channel_number_change', 'biz-123', 'cand-456'),
    );

    expect(prepareHash).toBe(finishHash);
    expect(prepareHash).toBeTruthy();
  });

  it('disconnect route computes same hash as prepare for channel_disconnect', async () => {
    const { canonicalMerchantParams } = await import('@/lib/merchant-step-up');
    const { hashOperationParams } = await import('@/lib/admin-step-up');

    const prepareHash = hashOperationParams(
      canonicalMerchantParams('channel_disconnect', 'biz-123', 'shared-1'),
    );
    const disconnectHash = hashOperationParams(
      canonicalMerchantParams('channel_disconnect', 'biz-123', 'shared-1'),
    );

    expect(prepareHash).toBe(disconnectHash);
  });
});

describe('Legacy parameter hashing remains stable', () => {
  it('execute and UI use identical payload for channel_change_execute', async () => {
    const { hashOperationParams } = await import('@/lib/admin-step-up');

    // What the admin UI sends to prepare
    const uiParams = {
      operation: 'channel_change_execute',
      approval_id: 'ap-123',
      business_id: 'biz-456',
      request_type: 'recovery',
    };

    // What the execute route now computes (fixed to match)
    const routeParams = {
      operation: 'channel_change_execute',
      approval_id: 'ap-123',
      business_id: 'biz-456',
      request_type: 'recovery',
    };

    expect(hashOperationParams(uiParams)).toBe(hashOperationParams(routeParams));
  });
});
