import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';

// ── Shared mocks for provisionPendingBusiness tests ──

vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/payments/gateway-resolver', () => ({
  resolveCountryGateway: vi.fn().mockResolvedValue({ gateway: 'paystack' }),
}));
vi.mock('@/lib/constants', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    generateBotCode: () => 'TESTBOT',
    generateSlug: () => 'test-biz',
  };
});

// ── Route-level mocks ──

const mockAdminUser = { userId: 'admin-1' };
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue(mockAdminUser),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/lib/onboarding/auth-user', () => ({
  authUserExists: vi.fn().mockResolvedValue(false),
}));

// Mock service client — replaced per-test via mockServiceClient
let _mockService: any;
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => _mockService),
}));

// Mock provisionAdminBusiness + validateAdminOnboardingInput
const mockProvisionAdminBusiness = vi.fn();
const mockValidateAdminOnboardingInput = vi.fn();
vi.mock('@/lib/onboarding/admin-assisted', () => ({
  provisionAdminBusiness: (...args: any[]) => mockProvisionAdminBusiness(...args),
  validateAdminOnboardingInput: (...args: any[]) => mockValidateAdminOnboardingInput(...args),
}));

import { provisionPendingBusiness, OnboardingProvisionError, type ProvisionBusinessInput } from '@/lib/onboarding/provision-business';
import { initCapabilities } from '@/lib/capabilities/service';
import { finalizeOnboarding } from '@/lib/onboarding/finalize';

const FAKE_BUSINESS = { id: 'biz-123', bot_code: 'TESTBOT', slug: 'test-biz' };

const BASE_INPUT: ProvisionBusinessInput = {
  ownerId: 'user-1',
  name: 'Test Biz',
  city: 'Lagos',
  address: '1 Test St',
  phone: '+2348000000000',
  category: 'restaurant',
  countryCode: 'NG' as any,
};

function mockProvisionService(overrides?: { whatsappInsertError?: string }) {
  const chainable = (result: { data?: unknown; error?: unknown }) => {
    const chain: Record<string, any> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => result;
    chain.single = async () => result;
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  };

  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
      insert: () => {
        if (table === 'businesses') return chainable({ data: { ...FAKE_BUSINESS }, error: null });
        if (table === 'whatsapp_config' && overrides?.whatsappInsertError) {
          return chainable({ data: null, error: { message: overrides.whatsappInsertError } });
        }
        return chainable({ data: {}, error: null });
      },
    }),
    rpc: () => Promise.resolve({ data: { allocated: true, channel_id: 'test-channel', idempotent: false }, error: null }),
  } as any;
}

beforeEach(() => {
  vi.mocked(initCapabilities).mockReset().mockResolvedValue(undefined);
  vi.mocked(finalizeOnboarding).mockReset().mockResolvedValue(undefined);
  mockProvisionAdminBusiness.mockReset();
  mockValidateAdminOnboardingInput.mockReset();
});

// ── provisionPendingBusiness: error carries businessId ──

describe('#551 rollback safety — provisionPendingBusiness carries businessId on failure', () => {
  it('happy path: returns business', async () => {
    const service = mockProvisionService();
    const result = await provisionPendingBusiness(service, BASE_INPUT);
    expect(result.id).toBe('biz-123');
  });

  it('WhatsApp config failure → OnboardingProvisionError WITH businessId', async () => {
    const service = mockProvisionService({ whatsappInsertError: 'duplicate key' });
    const err = await provisionPendingBusiness(service, BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });

  it('capability init failure → OnboardingProvisionError WITH businessId', async () => {
    vi.mocked(initCapabilities).mockRejectedValueOnce(new Error('cap boom'));
    const service = mockProvisionService();
    const err = await provisionPendingBusiness(service, BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });

  it('finalization failure → OnboardingProvisionError WITH businessId', async () => {
    vi.mocked(finalizeOnboarding).mockRejectedValueOnce(new Error('finalize boom'));
    const service = mockProvisionService();
    const err = await provisionPendingBusiness(service, BASE_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });
});

// ── provisionAdminBusiness: profile failure carries businessId ──

describe('#551 rollback safety — provisionAdminBusiness profile failure carries businessId', () => {
  it('profile update failure → throws OnboardingProvisionError with businessId', async () => {
    // Use vi.importActual to bypass the module mock and call the real provisionAdminBusiness
    const { provisionAdminBusiness: realProvision } = await vi.importActual<typeof import('@/lib/onboarding/admin-assisted')>('@/lib/onboarding/admin-assisted');

    // Service where provisionPendingBusiness succeeds but profile update fails
    const service = {
      from: (table: string) => {
        if (table === 'businesses') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({ data: { ...FAKE_BUSINESS }, error: null }),
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            update: () => ({
              eq: async () => ({ error: { message: 'profile write denied' } }),
            }),
          };
        }
        if (table === 'category_templates') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          };
        }
        // whatsapp_config and others — handled by vi.mock'd initCapabilities/finalizeOnboarding
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          insert: () => ({
            select: () => ({ single: async () => ({ data: {}, error: null }) }),
            then: (r: (v: unknown) => void) => r({ data: {}, error: null }),
          }),
        };
      },
    } as any;

    const err = await realProvision(
      service,
      {
        request_key: 'rk-1', owner_first_name: 'Jane', owner_last_name: 'Doe',
        owner_email: 'jane@example.com', owner_phone: '+2348000000001',
        business_name: 'Test Biz', country: 'NG', category: 'restaurant',
        city: 'Lagos', address: '1 Test St', business_phone: '+2348000000000',
        intended_plan: 'free' as any, capabilities: [], whatsapp_method: 'shared',
      },
      'user-1', 'onb-1',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OnboardingProvisionError);
    expect((err as OnboardingProvisionError).message).toContain('profile');
    expect((err as OnboardingProvisionError).businessId).toBe('biz-123');
  });
});

// ── Source-string contract tests ──

describe('#551 rollback safety — source-level contract verification', () => {
  it('create route: extracts businessId + preserves IDs for undeleted resources', () => {
    const src = readFileSync('app/api/admin/onboarding/route.ts', 'utf8');
    expect(src).toContain('error instanceof OnboardingProvisionError');
    expect(src).toContain('error.businessId');
    expect(src).toContain('cleanupFailures');
    expect(src).not.toContain('failed safely');
    expect(src).toContain('bizCleaned ? null : businessId');
    expect(src).toContain('userCleaned ? null : userId');
  });

  it('retry route: extracts businessId + preserves IDs for undeleted resources', () => {
    const src = readFileSync('app/api/admin/onboarding/[id]/route.ts', 'utf8');
    expect(src).toContain('retryError instanceof OnboardingProvisionError');
    expect(src).toContain('retryError.businessId');
    expect(src).toContain('cleanupFailures');
    expect(src).not.toContain('failed safely');
    expect(src).toContain('bizCleaned ? null : businessId');
    expect(src).toContain('userCleaned ? null : userId');
  });

  it('cancel route: partial cancellation persists durable state + audit before returning', () => {
    const src = readFileSync('app/api/admin/onboarding/[id]/route.ts', 'utf8');
    expect(src).toContain('partiallyApplied');
    expect(src).toContain('No resources were modified');
    expect(src).toContain('admin_onboarding_cancel_partial');
    expect(src).toContain('orphaned_user_id');
    expect(src).toContain("bizCleaned ? null : onboarding.business_id");
  });
});

// ── Route-level executable tests: call real POST handler ──

function makeRequest(body: object): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/onboarding/onb-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
}

/**
 * Build a mock service that tracks all updates and inserts to admin tables,
 * and allows controlling delete/auth outcomes.
 */
function buildRouteService(opts: {
  onboarding: Record<string, unknown>;
  businessDeleteError?: string;
  userDeleteError?: string;
  generateLinkResult?: { data: any; error: any };
}) {
  const updates: Array<{ table: string; data: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; data: Record<string, unknown> }> = [];

  const chainable = (result: { data?: unknown; error?: unknown }) => {
    const chain: Record<string, any> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => result;
    chain.single = async () => result;
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  };

  const service = {
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            if (table === 'admin_onboarding_invites') {
              return { data: { ...opts.onboarding }, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
      update: (data: Record<string, unknown>) => {
        const record = () => { updates.push({ table, data: { ...data } }); };
        const result = { error: null };
        // Support both `.eq().eq()` (retry) and single `.eq()` (cancel) patterns
        // Each .eq() is thenable (resolves to { error: null }) AND has a chained .eq()
        const makeEq = (): any => {
          const eqFn: any = async () => { record(); return result; };
          eqFn.eq = () => { record(); return { then: (r: (v: unknown) => void) => r(result) }; };
          eqFn.then = (resolve: (v: unknown) => void) => { record(); resolve(result); };
          return eqFn;
        };
        return { eq: () => makeEq() };
      },
      insert: (data: Record<string, unknown>) => {
        inserts.push({ table, data: { ...data } });
        return chainable({ data: {}, error: null });
      },
      delete: () => ({
        eq: (col: string, val: string) => ({
          eq: async () => {
            if (table === 'businesses' && opts.businessDeleteError) {
              return { error: { message: opts.businessDeleteError } };
            }
            return { error: null };
          },
        }),
      }),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { email_confirmed_at: null } },
          error: null,
        }),
        generateLink: async () => opts.generateLinkResult ?? ({
          data: {
            user: { id: 'user-new' },
            properties: { action_link: 'https://example.com/activate' },
          },
          error: null,
        }),
        deleteUser: async () => {
          if (opts.userDeleteError) return { error: { message: opts.userDeleteError } };
          return { error: null };
        },
      },
    },
    rpc: () => Promise.resolve({ data: { allocated: true, channel_id: 'test-channel', idempotent: false }, error: null }),
  } as any;

  return { service, updates, inserts };
}

describe('#551 durable recovery — real route: retry cleanup failure preserves orphan IDs', () => {
  it('business cleanup fails → business_id preserved, user_id nulled in onboarding record', async () => {
    const { service, updates } = buildRouteService({
      onboarding: {
        id: 'onb-1', status: 'failed', target_email: 'test@example.com',
        metadata: { input: { request_key: 'rk', owner_first_name: 'J', owner_last_name: 'D', owner_email: 'test@example.com', business_name: 'Biz', country: 'NG', category: 'restaurant', city: 'Lagos', address: '1 St', business_phone: '+234800', intended_plan: 'free', capabilities: [], whatsapp_method: 'shared' } },
        target_user_id: null, business_id: null,
      },
      businessDeleteError: 'FK constraint',
    });
    _mockService = service;
    mockValidateAdminOnboardingInput.mockResolvedValue({
      request_key: 'rk', owner_first_name: 'J', owner_last_name: 'D',
      owner_email: 'test@example.com', business_name: 'Biz', country: 'NG',
      category: 'restaurant', city: 'Lagos', address: '1 St',
      business_phone: '+234800', intended_plan: 'free', capabilities: [],
      whatsapp_method: 'shared',
    });
    mockProvisionAdminBusiness.mockResolvedValue({ id: 'biz-orphan', bot_code: 'BIZ' });
    // Email fails after provisioning → triggers catch block with both userId and businessId set
    const { sendEmail } = await import('@/lib/email/client');
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: false } as any);

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'retry' }), { params: { id: 'onb-1' } } as any);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('Cleanup incomplete');

    // Find the final onboarding update (status='failed')
    const failedUpdate = updates.find(u =>
      u.table === 'admin_onboarding_invites' && u.data.status === 'failed'
    );
    expect(failedUpdate).toBeDefined();
    // business_id preserved because cleanup failed
    expect(failedUpdate!.data.business_id).toBe('biz-orphan');
    // user_id nulled because user cleanup succeeded
    expect(failedUpdate!.data.target_user_id).toBeNull();
    // last_error records the cleanup failure
    expect(failedUpdate!.data.last_error).toContain('cleanup incomplete');
    expect(failedUpdate!.data.last_error).toContain('business biz-orphan');
  });
});

describe('#551 durable recovery — real route: successful retry cleanup clears both IDs', () => {
  it('both cleanups succeed → both IDs nulled in onboarding record', async () => {
    const { service, updates } = buildRouteService({
      onboarding: {
        id: 'onb-1', status: 'failed', target_email: 'test@example.com',
        metadata: { input: { request_key: 'rk', owner_first_name: 'J', owner_last_name: 'D', owner_email: 'test@example.com', business_name: 'Biz', country: 'NG', category: 'restaurant', city: 'Lagos', address: '1 St', business_phone: '+234800', intended_plan: 'free', capabilities: [], whatsapp_method: 'shared' } },
        target_user_id: null, business_id: null,
      },
      // no delete errors — both cleanups succeed
    });
    _mockService = service;
    mockValidateAdminOnboardingInput.mockResolvedValue({
      request_key: 'rk', owner_first_name: 'J', owner_last_name: 'D',
      owner_email: 'test@example.com', business_name: 'Biz', country: 'NG',
      category: 'restaurant', city: 'Lagos', address: '1 St',
      business_phone: '+234800', intended_plan: 'free', capabilities: [],
      whatsapp_method: 'shared',
    });
    // Provisioning succeeds but email fails → triggers catch block with cleanup
    mockProvisionAdminBusiness.mockResolvedValue({ id: 'biz-will-clean', bot_code: 'BIZ' });
    const { sendEmail } = await import('@/lib/email/client');
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: false } as any);

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'retry' }), { params: { id: 'onb-1' } } as any);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('Resources cleaned up successfully');

    const failedUpdate = updates.find(u =>
      u.table === 'admin_onboarding_invites' && u.data.status === 'failed'
    );
    expect(failedUpdate).toBeDefined();
    // Both IDs nulled — resources cleaned up
    expect(failedUpdate!.data.business_id).toBeNull();
    expect(failedUpdate!.data.target_user_id).toBeNull();
  });
});

describe('#551 durable recovery — real route: partial cancel persists state + audit', () => {
  it('business deleted, user deletion fails → durable state + audit written', async () => {
    const { service, updates, inserts } = buildRouteService({
      onboarding: {
        id: 'onb-1', status: 'customer_action_required',
        target_email: 'cust@example.com',
        target_user_id: 'user-orphan',
        business_id: 'biz-gone',
        metadata: {},
      },
      userDeleteError: 'auth service down',
    });
    _mockService = service;

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'cancel' }), { params: { id: 'onb-1' } } as any);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.partiallyApplied).toBe(true);
    expect(body.error).toContain('could not be removed');

    // Durable state persisted: invite record updated to cancelled with last_error
    const cancelUpdate = updates.find(u =>
      u.table === 'admin_onboarding_invites' && u.data.status === 'cancelled'
    );
    expect(cancelUpdate).toBeDefined();
    expect(cancelUpdate!.data.business_id).toBeNull(); // business was deleted
    expect(cancelUpdate!.data.last_error).toContain('could not be removed');

    // Audit entry written with partial cancellation details
    const auditInsert = inserts.find(i =>
      i.table === 'admin_audit_logs' && i.data.action === 'admin_onboarding_cancel_partial'
    );
    expect(auditInsert).toBeDefined();
    const details = auditInsert!.data.details as Record<string, unknown>;
    expect(details.business_deleted).toBe(true);
    expect(details.user_deleted).toBe(false);
    expect(details.orphaned_user_id).toBe('user-orphan');
  });
});

describe('#551 durable recovery — real route: normal cancel clears IDs + writes audit', () => {
  it('both deletions succeed → IDs nulled, normal cancel audit written', async () => {
    const { service, updates, inserts } = buildRouteService({
      onboarding: {
        id: 'onb-1', status: 'customer_action_required',
        target_email: 'cust@example.com',
        target_user_id: 'user-clean',
        business_id: 'biz-clean',
        metadata: {},
      },
      // no delete errors
    });
    _mockService = service;

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'cancel' }), { params: { id: 'onb-1' } } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // Both IDs nulled
    const cancelUpdate = updates.find(u =>
      u.table === 'admin_onboarding_invites' && u.data.status === 'cancelled'
    );
    expect(cancelUpdate).toBeDefined();
    expect(cancelUpdate!.data.target_user_id).toBeNull();
    expect(cancelUpdate!.data.business_id).toBeNull();

    // Normal cancel audit written (not partial)
    const auditInsert = inserts.find(i =>
      i.table === 'admin_audit_logs' && i.data.action === 'admin_onboarding_cancel'
    );
    expect(auditInsert).toBeDefined();
    // No partial cancel audit
    const partialAudit = inserts.find(i =>
      i.table === 'admin_audit_logs' && i.data.action === 'admin_onboarding_cancel_partial'
    );
    expect(partialAudit).toBeUndefined();
  });
});
