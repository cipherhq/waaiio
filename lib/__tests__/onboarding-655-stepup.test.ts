/**
 * PR #655 regression: consumeStepUp argument propagation.
 *
 * Proves:
 * 1. stepUpId from request body is passed as first positional arg
 * 2. StepUpError caught → 403 STEP_UP_REQUIRED (not unhandled throw)
 * 3. Successful step-up → allocation proceeds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  consumeStepUp: vi.fn(),
  StepUpError: class extends Error { constructor(m: string) { super(m); this.name = 'StepUpError'; } },
  serviceClient: vi.fn(),
  rateLimit: vi.fn(),
  sendEmail: vi.fn(),
  validate: vi.fn(),
  provision: vi.fn(),
  allocate: vi.fn(),
  logAudit: vi.fn(),
  authUserExists: vi.fn(),
  isReady: vi.fn(),
}));

vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: mocks.authorize }));
vi.mock('@/lib/admin-step-up', () => ({ consumeStepUp: mocks.consumeStepUp, StepUpError: mocks.StepUpError }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.serviceClient }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: mocks.rateLimit }));
vi.mock('@/lib/email/client', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/onboarding/admin-assisted', () => ({
  validateAdminOnboardingInput: mocks.validate,
  provisionAdminBusiness: mocks.provision,
}));
vi.mock('@/lib/onboarding/provision-business', () => ({
  OnboardingProvisionError: class extends Error {
    businessId?: string;
    constructor(m: string, s?: number, b?: string) { super(m); this.businessId = b; }
  },
}));
vi.mock('@/lib/onboarding/whatsapp-readiness', () => ({
  allocateSharedChannelWithFallback: mocks.allocate,
  getSharedChannelFallbackPolicy: (c: string | null) => c === 'GH' ? 'GH_TO_NG_SHARED' : 'EXACT_COUNTRY',
  isAssignedWhatsAppChannelReady: mocks.isReady,
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: mocks.logAudit }));
vi.mock('@/lib/onboarding/auth-user', () => ({ authUserExists: mocks.authUserExists }));
vi.mock('@/shared/capabilities', () => ({
  CAPABILITY_TIER_REQUIREMENTS: {},
  tierMeetsRequirement: () => true,
  CAPABILITY_IDS: [],
}));

const ADMIN = { id: 'admin-1', userId: 'admin-1', email: 'admin@test.com', role: 'admin', aal: 'aal2', bearerToken: 'bearer', sessionId: 'sess-1' };
const ONBOARDING = {
  id: 'onb-1', target_user_id: 'user-1', target_email: 'user@test.com',
  business_id: 'biz-1', status: 'customer_action_required', wa_method: 'shared',
  whatsapp_method: 'shared', whatsapp_channel_id: null, last_error: null, metadata: {},
};
const BUSINESS = {
  id: 'biz-1', owner_id: 'user-1', country_code: 'NG', wa_method: 'shared',
  status: 'pending', assigned_channel_id: null,
};
const ASSIGNED_CH = {
  id: 'ch-1', phone_number: '+2341234567890', channel_type: 'shared',
  is_active: true, connection_status: 'active', country_code: 'NG', business_id: null,
};

function chain(data: unknown, error?: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'update', 'delete', 'is', 'limit', 'not', 'gt']) {
    self[m] = vi.fn(() => self);
  }
  self.maybeSingle = vi.fn(async () => ({ data, error: error ?? null }));
  self.single = vi.fn(async () => ({ data, error: error ?? null }));
  return self;
}

function setupService() {
  let waChannelCallCount = 0;
  let bizCallCount = 0;
  const from = vi.fn((table: string) => {
    if (table === 'admin_onboarding_invites') {
      const c = chain(ONBOARDING);
      c.update = vi.fn(() => chain(null));
      return c;
    }
    if (table === 'businesses') {
      // First call: initial load (no assigned channel yet)
      // Second call: post-allocation readiness check (channel assigned)
      const callNum = bizCallCount++;
      if (callNum === 0) return chain(BUSINESS); // assigned_channel_id: null
      return chain({ ...BUSINESS, assigned_channel_id: 'ch-1' }); // after allocation
    }
    if (table === 'whatsapp_channels') {
      // First call: check for active dedicated channel (should return null)
      // Second call: post-allocation readiness check (should return channel)
      const callNum = waChannelCallCount++;
      if (callNum === 0) return chain(null); // no active dedicated
      return chain(ASSIGNED_CH); // assigned channel for readiness
    }
    if (table === 'whatsapp_channel_candidates') return chain(null);
    return chain(null);
  });
  const service = { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
  mocks.serviceClient.mockReturnValue(service);
  return service;
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost/api/admin/onboarding/onb-1'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin' },
  });
}

describe('PR #655 regression: consumeStepUp argument propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(ADMIN);
    mocks.rateLimit.mockResolvedValue(null);
    mocks.logAudit.mockResolvedValue({ error: null });
    mocks.isReady.mockReturnValue(true);
    mocks.allocate.mockResolvedValue({
      data: { allocated: true, channel_id: 'ch-1', phone_number: '+2341234567890', channel_country: 'NG', fallback_used: false },
      error: null,
    });
    setupService();
  });

  it('passes stepUpId from request body as first positional arg to consumeStepUp (5 args total)', async () => {
    mocks.consumeStepUp.mockResolvedValue(true);

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'step-up-uuid-abc' }), { params: Promise.resolve({ id: 'onb-1' }) });

    expect(mocks.consumeStepUp).toHaveBeenCalledOnce();
    const [admin, stepUpId, actionType, targetId, params] = mocks.consumeStepUp.mock.calls[0];
    expect(admin).toMatchObject({ userId: 'admin-1' });
    expect(stepUpId).toBe('step-up-uuid-abc');
    expect(actionType).toBe('messaging_config');
    expect(targetId).toBe('onb-1');
    expect(params).toMatchObject({
      operation: 'ensure_shared_channel',
      business_id: 'biz-1',
      business_country: 'NG',
    });
  });

  it('catches StepUpError and returns 403 with STEP_UP_REQUIRED code', async () => {
    mocks.consumeStepUp.mockRejectedValue(new mocks.StepUpError('Step-up authorization invalid'));

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'bad-id' }), { params: Promise.resolve({ id: 'onb-1' }) });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('STEP_UP_REQUIRED');
    expect(body.error).toContain('Step-up authorization invalid');
    expect(mocks.allocate).not.toHaveBeenCalled();
  });

  it('proceeds to allocation after successful step-up consumption', async () => {
    mocks.consumeStepUp.mockResolvedValue(true);

    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'valid-id' }), { params: Promise.resolve({ id: 'onb-1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.allocated).toBe(true);
    expect(mocks.allocate).toHaveBeenCalledOnce();
  });
});
