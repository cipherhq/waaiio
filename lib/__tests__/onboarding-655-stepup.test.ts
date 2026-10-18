/**
 * PR #655 regression: consumeStepUp argument propagation + CTO R2 fixes.
 *
 * Proves:
 * 1. stepUpId from request body is passed as first positional arg (5 args total)
 * 2. StepUpError caught → 403 STEP_UP_REQUIRED (not unhandled throw)
 * 3. Successful step-up → allocation proceeds
 * 4. P1-1: Uses actual M391 candidate states (pending/validating/ready)
 * 5. P1-2: Fails closed on dedicated-channel query errors
 * 6. P1-2: Fails closed on candidate query errors
 * 7. P1-3: Detects concurrent dedicated channel after step-up (race protection)
 * 8. P1-3: Detects concurrent candidate after step-up (race protection)
 * 9. P1-4: Readiness failure is audited (not silent)
 * 10. P2-2: whatsapp_method='dedicated' blocks shared allocation
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
  business_id: 'biz-1', status: 'customer_action_required',
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

/**
 * Build a mock service where whatsapp_channels and whatsapp_channel_candidates
 * can be configured per-call to simulate race conditions and error scenarios.
 */
function setupService(overrides?: {
  dedicatedResult?: { data: unknown; error?: unknown };
  candidateResult?: { data: unknown; error?: unknown };
  // Post-step-up re-verification results
  raceDedicatedResult?: { data: unknown; error?: unknown };
  raceCandidateResult?: { data: unknown; error?: unknown };
  // Post-allocation results
  postDedicatedResult?: { data: unknown; error?: unknown };
  postBizResult?: { data: unknown; error?: unknown };
  postChannelResult?: { data: unknown; error?: unknown };
}) {
  let waChannelCallIdx = 0;
  let candidateCallIdx = 0;
  let bizCallIdx = 0;

  const from = vi.fn((table: string) => {
    if (table === 'admin_onboarding_invites') {
      const c = chain(ONBOARDING);
      c.update = vi.fn(() => chain(null));
      return c;
    }
    if (table === 'businesses') {
      const callNum = bizCallIdx++;
      if (callNum === 0) return chain(BUSINESS);
      // Post-allocation: business with assigned channel
      const postBiz = overrides?.postBizResult ?? { data: { ...BUSINESS, assigned_channel_id: 'ch-1' } };
      return chain(postBiz.data, postBiz.error);
    }
    if (table === 'whatsapp_channels') {
      const callNum = waChannelCallIdx++;
      if (callNum === 0) {
        // Initial dedicated check
        const r = overrides?.dedicatedResult ?? { data: null };
        return chain(r.data, r.error);
      }
      if (callNum === 1) {
        // Post-step-up race dedicated check
        const r = overrides?.raceDedicatedResult ?? { data: null };
        return chain(r.data, r.error);
      }
      if (callNum === 2) {
        // Post-allocation readiness channel check
        const r = overrides?.postChannelResult ?? { data: ASSIGNED_CH };
        return chain(r.data, r.error);
      }
      if (callNum === 3) {
        // Post-allocation dedicated conflict check
        const r = overrides?.postDedicatedResult ?? { data: null };
        return chain(r.data, r.error);
      }
      return chain(null);
    }
    if (table === 'whatsapp_channel_candidates') {
      const callNum = candidateCallIdx++;
      if (callNum === 0) {
        const r = overrides?.candidateResult ?? { data: null };
        return chain(r.data, r.error);
      }
      if (callNum === 1) {
        // Post-step-up race candidate check
        const r = overrides?.raceCandidateResult ?? { data: null };
        return chain(r.data, r.error);
      }
      return chain(null);
    }
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

describe('PR #655 CTO R2: ensure_shared_channel hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(ADMIN);
    mocks.rateLimit.mockResolvedValue(null);
    mocks.logAudit.mockResolvedValue({ error: null });
    mocks.isReady.mockReturnValue(true);
    mocks.consumeStepUp.mockResolvedValue(true);
    mocks.allocate.mockResolvedValue({
      data: { allocated: true, channel_id: 'ch-1', phone_number: '+2341234567890', channel_country: 'NG', fallback_used: false },
      error: null,
    });
  });

  it('passes stepUpId as first positional arg to consumeStepUp (5 args)', async () => {
    setupService();
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'step-up-uuid' }), { params: Promise.resolve({ id: 'onb-1' }) });

    expect(mocks.consumeStepUp).toHaveBeenCalledOnce();
    const [admin, stepUpId, actionType, targetId, params] = mocks.consumeStepUp.mock.calls[0];
    expect(admin).toMatchObject({ userId: 'admin-1' });
    expect(stepUpId).toBe('step-up-uuid');
    expect(actionType).toBe('messaging_config');
    expect(targetId).toBe('onb-1');
    expect(params).toMatchObject({ operation: 'ensure_shared_channel', business_id: 'biz-1' });
  });

  it('catches StepUpError → 403 STEP_UP_REQUIRED', async () => {
    setupService();
    mocks.consumeStepUp.mockRejectedValue(new mocks.StepUpError('Invalid'));
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'bad' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(403);
    expect(mocks.allocate).not.toHaveBeenCalled();
  });

  it('proceeds to allocation after successful step-up', async () => {
    setupService();
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'valid' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mocks.allocate).toHaveBeenCalledOnce();
  });

  // P1-2: Fail closed on dedicated-channel query errors
  it('returns 500 when dedicated-channel query errors (fail closed)', async () => {
    setupService({ dedicatedResult: { data: null, error: { message: 'connection_refused' } } });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'x' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('dedicated channel state');
    expect(mocks.consumeStepUp).not.toHaveBeenCalled();
  });

  // P1-2: Fail closed on candidate query errors
  it('returns 500 when candidate query errors (fail closed)', async () => {
    setupService({ candidateResult: { data: null, error: { message: 'connection_refused' } } });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'x' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('WABA candidate state');
    expect(mocks.consumeStepUp).not.toHaveBeenCalled();
  });

  // P1-1: Uses actual candidate states
  it('blocks when an open candidate exists with actual M391 states', async () => {
    setupService({ candidateResult: { data: { id: 'cand-1', status: 'validating' } } });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'x' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(409);
    expect(mocks.consumeStepUp).not.toHaveBeenCalled();
  });

  // P1-3: Race protection — concurrent dedicated channel after step-up
  it('aborts when dedicated channel appears after step-up (race protection)', async () => {
    setupService({ raceDedicatedResult: { data: { id: 'ded-1' } } });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'valid' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('dedicated channel appeared');
    expect(mocks.allocate).not.toHaveBeenCalled();
  });

  // P1-3: Race protection — concurrent candidate after step-up
  it('aborts when WABA candidate appears after step-up (race protection)', async () => {
    setupService({ raceCandidateResult: { data: { id: 'cand-1' } } });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'valid' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('owner WABA setup started');
    expect(mocks.allocate).not.toHaveBeenCalled();
  });

  // P1-4: Readiness failure is audited
  it('audits readiness failure and returns 422 (not silent)', async () => {
    mocks.isReady.mockReturnValue(false);
    setupService();
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'valid' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(422);
    // Verify audit was called with readiness_failed action
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin_onboarding_shared_channel_readiness_failed',
    }));
  });

  // P2-2: whatsapp_method='dedicated' blocks shared allocation
  it('blocks shared allocation when onboarding whatsapp_method is dedicated', async () => {
    // Override the onboarding to use dedicated method
    const dedicatedOnboarding = { ...ONBOARDING, whatsapp_method: 'dedicated' };
    mocks.serviceClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'admin_onboarding_invites') return chain(dedicatedOnboarding);
        return chain(null);
      }),
    });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'x' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('owner-managed dedicated');
    expect(mocks.allocate).not.toHaveBeenCalled();
  });

  // P1-3: Post-allocation concurrent dedicated conflict
  it('detects concurrent dedicated channel after allocation', async () => {
    setupService({ postDedicatedResult: { data: { id: 'ded-concurrent' } } });
    const { POST } = await import('@/app/api/admin/onboarding/[id]/route');
    const res = await POST(makeRequest({ action: 'ensure_shared_channel', stepUpId: 'valid' }), { params: Promise.resolve({ id: 'onb-1' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('concurrent');
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin_onboarding_shared_channel_concurrent_dedicated_conflict',
    }));
  });
});
