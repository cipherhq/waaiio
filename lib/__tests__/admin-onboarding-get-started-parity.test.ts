/**
 * Admin "Onboard Customer" follows the same rules as self-serve Get Started.
 *
 * - Admission: create (and retry) need the broad channel switch OR the narrow
 *   M507 first shared-number switch, exactly like provisionPendingBusiness.
 *   The broad switch is NOT required. Shared-channel repair stays broad-only.
 * - Capabilities: every selected capability is saved on the Free business,
 *   as Get Started does; higher-plan ones run under the 14-day trial.
 *
 * Runs the real create route, admin-assisted validation, provisionPendingBusiness
 * and initCapabilities against an in-memory service client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  admin: vi.fn(), service: vi.fn(), sendEmail: vi.fn(), allocate: vi.fn(), audit: vi.fn(),
}));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: m.admin }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: m.service }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'fixture' }));
vi.mock('@/lib/email/client', () => ({ sendEmail: m.sendEmail }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: m.audit }));
vi.mock('@/lib/onboarding/auth-user', () => ({ authUserExists: async () => false }));
vi.mock('@/lib/onboarding/validation', () => ({ validateBusinessAuthorityInputs: async () => ({ countryCode: 'NG' }) }));
vi.mock('@/lib/onboarding/finalize', () => ({ finalizeOnboarding: vi.fn(async () => undefined) }));
vi.mock('@/lib/payments/gateway-resolver', () => ({ resolveCountryGateway: async () => ({ gateway: 'paystack' }) }));
vi.mock('@/lib/onboarding/whatsapp-readiness', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/onboarding/whatsapp-readiness')>()),
  allocateSharedChannelForNewBusiness: m.allocate,
}));

import { POST as createOnboarding } from '@/app/api/admin/onboarding/route';
import { POST as onboardingAction } from '@/app/api/admin/onboarding/[id]/route';
import { CAPABILITY_TIER_REQUIREMENTS } from '@/shared/capabilities';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';

const input = {
  request_key: '9f96271c-6715-4e20-ab96-fce6409ed4cd', owner_first_name: 'Ada', owner_last_name: 'Lovelace',
  owner_email: 'ada@example.test', business_name: 'Parity Business', country: 'NG', category: 'restaurant', city: 'Lagos',
  address: '1 Test Street', business_phone: '+2348012345678', bot_code: 'PARITY', intended_plan: 'free',
  // Free, Pro (growth) and Premium (business) capabilities on a Free-intent business.
  capabilities: ['ordering', 'broadcast', 'reports'], whatsapp_method: 'shared',
};

function chain(result: { data?: unknown; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'not', 'order', 'update', 'delete']) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => result);
  q.single = vi.fn(async () => result);
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

function fakeService() {
  const capabilityUpserts: Array<Array<Record<string, unknown>>> = [];
  const businessInserts: Array<Record<string, unknown>> = [];
  const service = {
    auth: { admin: {
      generateLink: vi.fn(async () => ({ data: { user: { id: 'owner-1' }, properties: { action_link: 'https://auth.test/activate' } }, error: null })),
      deleteUser: vi.fn(async () => ({ error: null })),
    } },
    rpc: vi.fn(),
    from: vi.fn((table: string) => {
      if (table === 'admin_onboarding_invites') return {
        select: vi.fn(() => chain({ data: null, error: null })),
        insert: vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'onboarding-1', status: 'provisioning' }, error: null }) }) })),
        update: vi.fn(() => chain({ data: null, error: null })),
      };
      if (table === 'businesses') return {
        select: vi.fn(() => chain({ data: null, error: null })),
        insert: vi.fn((row: Record<string, unknown>) => { businessInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'business-1', bot_code: 'PARITY', slug: 'parity-business' }, error: null }) }) }; }),
        delete: vi.fn(() => chain({ data: null, error: null })),
      };
      if (table === 'countries') return { select: vi.fn(() => chain({ data: { dialing_code: '+234', phone_digits: 10 }, error: null })) };
      if (table === 'category_templates') return { select: vi.fn(() => chain({ data: null, error: null })) };
      if (table === 'whatsapp_config') return { insert: vi.fn(async () => ({ error: null })) };
      if (table === 'business_capabilities') return {
        upsert: vi.fn(async (rows: Array<Record<string, unknown>>) => { capabilityUpserts.push(rows); return { error: null }; }),
        update: vi.fn(() => chain({ data: null, error: null })),
      };
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return { service, capabilityUpserts, businessInserts };
}

const createRequest = (body: unknown = input) => new NextRequest('http://localhost/api/admin/onboarding', {
  method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const actionRequest = (action: string) => new NextRequest('http://localhost/api/admin/onboarding/invite', {
  method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'false');
  vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'true');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test');
  m.admin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
  m.sendEmail.mockResolvedValue({ success: true });
  m.audit.mockResolvedValue({ error: null });
  m.allocate.mockResolvedValue({ data: { allocated: true, channel_id: 'shared-ng' }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('admin onboarding admission matches Get Started', () => {
  it('creates and sends the invite with the broad switch off and only M507 first assignment on', async () => {
    const { service, businessInserts } = fakeService();
    m.service.mockReturnValue(service);
    const response = await createOnboarding(createRequest());
    expect(response.status).toBe(201);
    expect((await response.json()).onboarding).toMatchObject({ status: 'customer_action_required', business_id: 'business-1', target_user_id: 'owner-1' });
    // Same shared Free business Get Started creates, given its first shared number.
    expect(businessInserts[0]).toMatchObject({ owner_id: 'owner-1', wa_method: 'shared', subscription_tier: 'free', status: 'pending' });
    expect(m.allocate).toHaveBeenCalledWith(service, 'business-1', 'NG');
    expect(m.sendEmail).toHaveBeenCalledOnce();
    expect(service.auth.admin.generateLink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'invite', options: expect.objectContaining({ redirectTo: 'https://app.test/auth/callback?next=/activate' }),
    }));
  });

  it('with both switches off, returns the unavailable 503 before any service work, like Get Started', async () => {
    vi.stubEnv('ENABLE_FIRST_SHARED_ASSIGNMENT', 'false');
    const response = await createOnboarding(createRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('CHANNEL_OPERATIONS_UNAVAILABLE');
    expect(m.service).not.toHaveBeenCalled();
  });

  it('retry passes the same narrow admission; shared-channel repair still needs the broad switch', async () => {
    const lookup = { from: vi.fn(() => chain({ data: null, error: null })) };
    m.service.mockReturnValue(lookup);
    // Past the admission gate: the (missing) onboarding record is looked up.
    expect((await onboardingAction(actionRequest('retry'), { params: Promise.resolve({ id: 'invite' }) })).status).toBe(404);
    expect(lookup.from).toHaveBeenCalledWith('admin_onboarding_invites');
    lookup.from.mockClear();
    expect((await onboardingAction(actionRequest('ensure_shared_channel'), { params: Promise.resolve({ id: 'invite' }) })).status).toBe(503);
    expect(lookup.from).not.toHaveBeenCalled();
  });
});

describe('admin onboarding saves every selected capability, like Get Started', () => {
  it('persists Free, Pro and Premium capabilities on a Free-intent business', async () => {
    expect(CAPABILITY_TIER_REQUIREMENTS.broadcast).toBe('growth');
    expect(CAPABILITY_TIER_REQUIREMENTS.reports).toBe('business');
    const { service, capabilityUpserts, businessInserts } = fakeService();
    m.service.mockReturnValue(service);
    const response = await createOnboarding(createRequest());
    expect(response.status).toBe(201);
    expect(capabilityUpserts).toHaveLength(1);
    expect(capabilityUpserts[0]).toEqual(['ordering', 'broadcast', 'reports'].map(capability => ({
      business_id: 'business-1', capability, is_enabled: true,
    })));
    // Entitlement stays Free: the trial clock is set by the M525 insert trigger, never by the route.
    expect(businessInserts[0].subscription_tier).toBe('free');
    expect(businessInserts[0]).not.toHaveProperty('feature_trial_ends_at');
    expect(businessInserts[0].metadata).toMatchObject({ intended_plan: 'free', requested_capabilities: ['ordering', 'broadcast', 'reports'] });
  });

  it('saves a repeated capability id once', async () => {
    const { service, capabilityUpserts } = fakeService();
    m.service.mockReturnValue(service);
    const response = await createOnboarding(createRequest({ ...input, capabilities: ['ordering', 'broadcast', 'ordering'] }));
    expect(response.status).toBe(201);
    expect(capabilityUpserts[0].map(row => row.capability)).toEqual(['ordering', 'broadcast']);
  });

  it('still rejects an unknown capability id', async () => {
    const { service } = fakeService();
    m.service.mockReturnValue(service);
    const response = await createOnboarding(createRequest({ ...input, capabilities: ['ordering', 'not_a_capability'] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('A capability is invalid');
  });

  it('changing the queued plan keeps higher-plan capabilities instead of rejecting', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const record = { id: 'onboarding-1', status: 'customer_action_required', intended_plan: 'free', target_user_id: 'owner-1', business_id: 'business-1', metadata: { input } };
    m.service.mockReturnValue({ from: vi.fn(() => ({
      select: vi.fn(() => chain({ data: record, error: null })),
      update: vi.fn((row: Record<string, unknown>) => { updates.push(row); return chain({ data: null, error: null }); }),
    })) });
    const request = new NextRequest('http://localhost/api/admin/onboarding/onboarding-1', {
      method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'change_plan', intended_plan: 'growth' }),
    });
    const response = await onboardingAction(request, { params: Promise.resolve({ id: 'onboarding-1' }) });
    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({ intended_plan: 'growth', metadata: { input: { capabilities: ['ordering', 'broadcast', 'reports'], intended_plan: 'growth' } } });
  });
});

describe('saved higher-plan capabilities follow the trial gate', () => {
  const configuredCapabilities = ['ordering', 'broadcast', 'reports'].map(capability => ({ capability, is_enabled: true }));
  it('work on Free during the 14-day trial', () => {
    const trialEndsAt = new Date(Date.now() + 13 * 86_400_000);
    expect(getEffectiveCapabilities({ configuredCapabilities, overrides: [], tier: 'free', trialEndsAt }).effective)
      .toEqual(['ordering', 'broadcast', 'reports']);
  });
  it('are blocked on Free after the trial until the merchant upgrades', () => {
    const trialEndsAt = new Date(Date.now() - 60_000);
    const result = getEffectiveCapabilities({ configuredCapabilities, overrides: [], tier: 'free', trialEndsAt });
    expect(result.effective).toEqual(['ordering']);
    expect(result.blocked).toEqual([
      { capability: 'broadcast', reason: 'trial_expired' },
      { capability: 'reports', reason: 'trial_expired' },
    ]);
    expect(getEffectiveCapabilities({ configuredCapabilities, overrides: [], tier: 'growth', trialEndsAt }).effective)
      .toEqual(['ordering', 'broadcast']);
  });
});
