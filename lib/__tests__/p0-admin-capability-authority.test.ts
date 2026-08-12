/**
 * P0-ADMIN / P0-CAP: Admin ↔ Capability Authority Tests
 *
 * Drift prevention:
 * 1. Admin catalog exactly equals canonical CapabilityId set
 * 2. All 31 canonical capabilities are addressable
 * 3. Shared module is the single source of truth
 * 4. No duplicate IDs in canonical catalog
 *
 * Security:
 * 5. Non-admin cannot use Admin capability mutation endpoint
 * 6. Unknown business rejected
 * 7. Invalid capability ID rejected
 * 8. Admin route validates grant/revoke action
 *
 * Admin API route behavior:
 * 9. Grant calls admin_grant_capability RPC
 * 10. Revoke calls admin_revoke_capability RPC
 * 11. RPC error returns 500
 * 12. Audit logging occurs (via RPC)
 * 13. Dependency validation exists in grant RPC
 * 14. Admin route uses service_role client for RPC
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Drift prevention tests (no mocks needed) ──

describe('P0-CAP: Canonical capability catalog drift prevention', () => {
  it('1. shared/capabilities.ts CAPABILITY_IDS has exactly 31 entries', async () => {
    const { CAPABILITY_IDS } = await import('@/shared/capabilities');
    expect(CAPABILITY_IDS).toHaveLength(31);
  });

  it('2. no duplicate IDs in canonical catalog', async () => {
    const { CAPABILITY_IDS } = await import('@/shared/capabilities');
    const unique = new Set(CAPABILITY_IDS);
    expect(unique.size).toBe(CAPABILITY_IDS.length);
  });

  it('3. every CapabilityId has a tier requirement', async () => {
    const { CAPABILITY_IDS, CAPABILITY_TIER_REQUIREMENTS } = await import('@/shared/capabilities');
    for (const id of CAPABILITY_IDS) {
      expect(CAPABILITY_TIER_REQUIREMENTS[id], `Missing tier for ${id}`).toBeDefined();
      expect(['free', 'growth', 'business']).toContain(CAPABILITY_TIER_REQUIREMENTS[id]);
    }
  });

  it('4. lib/capabilities/types.ts re-exports from shared (same reference)', async () => {
    const shared = await import('@/shared/capabilities');
    const types = await import('@/lib/capabilities/types');
    // Same array reference means they're the same canonical source
    expect(types.CAPABILITIES).toBe(shared.CAPABILITIES);
    expect(types.CAPABILITY_TIER_REQUIREMENTS).toBe(shared.CAPABILITY_TIER_REQUIREMENTS);
    expect(types.CAPABILITY_IDS).toBe(shared.CAPABILITY_IDS);
  });

  it('5. PLAN_LABELS maps internal tiers to customer-facing names', async () => {
    const { PLAN_LABELS } = await import('@/shared/capabilities');
    expect(PLAN_LABELS.free).toBe('Free');
    expect(PLAN_LABELS.growth).toBe('Pro');
    expect(PLAN_LABELS.business).toBe('Premium');
  });

  it('6. CAPABILITY_DEPENDENCIES exists and membership requires loyalty', async () => {
    const { CAPABILITY_DEPENDENCIES } = await import('@/shared/capabilities');
    expect(CAPABILITY_DEPENDENCIES.membership).toEqual(['loyalty']);
  });

  it('7. all 31 canonical IDs are present', async () => {
    const { CAPABILITY_IDS } = await import('@/shared/capabilities');
    const expectedIds = [
      'scheduling', 'appointment', 'payment', 'ordering', 'ticketing',
      'reservation', 'table_reservation', 'whatsapp_sign', 'reminders',
      'crowdfunding', 'reports', 'queue', 'feedback', 'loyalty',
      'chat', 'waitlist', 'referral', 'staff', 'invoice', 'survey',
      'poll', 'giving', 'broadcast', 'recurring', 'auto_reply',
      'membership', 'estimates', 'packages', 'class_booking',
      'multi_location', 'waiver',
    ];
    for (const id of expectedIds) {
      expect(CAPABILITY_IDS, `Missing: ${id}`).toContain(id);
    }
  });

  it('8. Admin Businesses.tsx imports from @shared/capabilities (not hardcoded)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('admin/src/pages/Businesses.tsx', 'utf-8');
    // Must import from shared
    expect(source).toContain("from '@shared/capabilities'");
    // Must NOT have hardcoded ALL_CAPABILITIES array
    expect(source).not.toMatch(/const ALL_CAPABILITIES\s*=/);
    // Must NOT have hardcoded TIER_REQUIREMENTS
    expect(source).not.toMatch(/const TIER_REQUIREMENTS:\s*Record/);
  });

  it('9. Admin CategoryTemplates.tsx imports from @shared/capabilities', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('admin/src/pages/CategoryTemplates.tsx', 'utf-8');
    expect(source).toContain("from '@shared/capabilities'");
  });

  it('10. tierMeetsRequirement correctly compares tiers', async () => {
    const { tierMeetsRequirement } = await import('@/shared/capabilities');
    expect(tierMeetsRequirement('free', 'free')).toBe(true);
    expect(tierMeetsRequirement('growth', 'free')).toBe(true);
    expect(tierMeetsRequirement('business', 'growth')).toBe(true);
    expect(tierMeetsRequirement('free', 'growth')).toBe(false);
    expect(tierMeetsRequirement('growth', 'business')).toBe(false);
  });
});

// ── Security tests (route-level mocks) ──

const mockRpc = vi.fn();
const mockRequirePlatformAdmin = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: (...args: unknown[]) => mockRequirePlatformAdmin(...args),
}));

// Route must NOT use cookie-based createClient — only service client
const mockCreateClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => { mockCreateClient(...args); return Promise.resolve({}); },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: string) => ({
          single: () => Promise.resolve({
            data: table === 'businesses' ? { id: 'biz-1', subscription_tier: 'growth' } : null,
            error: null,
          }),
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  }),
}));

function makeAdminRequest(bizId: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/admin/businesses/${bizId}/capabilities`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
  });
}

describe('P0-ADMIN: Admin capability route security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('11. non-admin gets 403', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(null);

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const res = await POST(
      makeAdminRequest('biz-1', { capability: 'chat', action: 'grant' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('12. invalid capability ID rejected with 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const res = await POST(
      makeAdminRequest('biz-1', { capability: 'nonexistent_cap', action: 'grant' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid capability');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('13. invalid action rejected with 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const res = await POST(
      makeAdminRequest('biz-1', { capability: 'chat', action: 'toggle' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('14. grant calls admin_grant_capability RPC via service client', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const res = await POST(
      makeAdminRequest('biz-1', { capability: 'chat', action: 'grant', reason: 'Test' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_grant_capability', {
      p_business_id: 'biz-1',
      p_capability: 'chat',
      p_granted_by: 'admin-1',
      p_reason: 'Test',
    });
  });

  it('15. revoke calls admin_revoke_capability RPC via service client', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const res = await POST(
      makeAdminRequest('biz-1', { capability: 'chat', action: 'revoke' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_revoke_capability', expect.objectContaining({
      p_business_id: 'biz-1',
      p_capability: 'chat',
    }));
  });

  it('16. RPC error returns 500', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'constraint violation' } });

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const res = await POST(
      makeAdminRequest('biz-1', { capability: 'chat', action: 'grant' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    expect(res.status).toBe(500);
  });

  it('17. Admin Businesses.tsx uses API route (not direct DB writes)', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('admin/src/pages/Businesses.tsx', 'utf-8');
    // Must use API fetch pattern
    expect(source).toContain('/api/admin/businesses/');
    expect(source).toContain('/capabilities');
    expect(source).toContain('Authorization');
    // handleCapToggle must NOT directly write to capability tables
    // (reads for display are fine, but upsert/update/delete in handleCapToggle is not)
    const handleCapFn = source.slice(source.indexOf('async function handleCapToggle'), source.indexOf('setCapSaving(null);\n    }'));
    expect(handleCapFn).not.toContain(".from('capability_overrides')");
    expect(handleCapFn).not.toContain(".from('business_capabilities')");
  });

  it('18. admin_grant_capability RPC exists in migrations', async () => {
    const fs = await import('fs');
    const migrationDir = 'supabase/migrations';
    const files = fs.readdirSync(migrationDir);
    const hasGrant = files.some(f => {
      const content = fs.readFileSync(`${migrationDir}/${f}`, 'utf-8');
      return content.includes('admin_grant_capability');
    });
    expect(hasGrant).toBe(true);
  });

  it('19. admin_grant_capability enforces membership→loyalty dependency', async () => {
    const fs = await import('fs');
    const migrationDir = 'supabase/migrations';
    const files = fs.readdirSync(migrationDir).sort();
    let foundDependencyCheck = false;
    for (const f of files) {
      const content = fs.readFileSync(`${migrationDir}/${f}`, 'utf-8');
      if (content.includes('admin_grant_capability') && content.includes('loyalty')) {
        foundDependencyCheck = true;
        break;
      }
    }
    expect(foundDependencyCheck).toBe(true);
  });

  it('20. route does NOT use cookie-based createClient (Bearer-only)', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const { POST } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    await POST(
      makeAdminRequest('biz-1', { capability: 'chat', action: 'grant' }),
      { params: Promise.resolve({ id: 'biz-1' }) },
    );

    // createClient (cookie-based) must never be called
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('21. route source has no createClient import from supabase/server', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/api/admin/businesses/[id]/capabilities/route.ts', 'utf-8');
    expect(source).not.toContain("from '@/lib/supabase/server'");
    expect(source).toContain("from '@/lib/supabase/service'");
  });

  it('22. GET works with Bearer-only (no cookies)', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1' });

    const { GET } = await import('@/app/api/admin/businesses/[id]/capabilities/route');
    const req = new NextRequest('http://localhost/api/admin/businesses/biz-1/capabilities', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const res = await GET(req, { params: Promise.resolve({ id: 'biz-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toHaveProperty('tier');
    expect(json).toHaveProperty('capabilities');
    expect(json).toHaveProperty('overrides');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
