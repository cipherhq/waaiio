/**
 * Admin "Onboard Customer" asks for the same required fields as Get Started
 * (Owner request 2026-11-18): WhatsApp Name, at least one feature and the full
 * business phone number. Runs the real create route and admin-assisted
 * validation against an in-memory service client; each rejection must happen
 * before any invite record or auth user is created.
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
import { validateAdminOnboardingInput } from '@/lib/onboarding/admin-assisted';

const input = {
  request_key: '5b3a1c7e-2f4d-4e8a-9c1b-6d7e8f9a0b1c', owner_first_name: 'Ada', owner_last_name: 'Lovelace',
  owner_email: 'ada@example.test', business_name: 'Required Fields', country: 'NG', category: 'restaurant', city: 'Lagos',
  address: '1 Test Street', business_phone: '+2348012345678', bot_code: 'REQUIRED-FIELDS', intended_plan: 'free',
  capabilities: ['ordering'], whatsapp_method: 'shared',
};

function chain(result: { data?: unknown; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'not', 'order', 'update', 'delete']) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => result);
  q.single = vi.fn(async () => result);
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

function fakeService({ takenBotCode = null as string | null } = {}) {
  const inviteInserts: Array<Record<string, unknown>> = [];
  const businessInserts: Array<Record<string, unknown>> = [];
  const service = {
    auth: { admin: {
      generateLink: vi.fn(async () => ({ data: { user: { id: 'owner-1' }, properties: { action_link: 'https://auth.test/activate' } }, error: null })),
      deleteUser: vi.fn(async () => ({ error: null })),
    } },
    rpc: vi.fn(),
    from: vi.fn((table: string) => {
      if (table === 'countries') return { select: vi.fn(() => chain({ data: { dialing_code: '+234', phone_digits: 10 }, error: null })) };
      if (table === 'admin_onboarding_invites') return {
        select: vi.fn(() => chain({ data: null, error: null })),
        insert: vi.fn((row: Record<string, unknown>) => { inviteInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'onboarding-1', status: 'provisioning' }, error: null }) }) }; }),
        update: vi.fn(() => chain({ data: null, error: null })),
      };
      if (table === 'businesses') return {
        select: vi.fn(() => {
          const q = chain({ data: null, error: null });
          q.eq = vi.fn((column: string, value: string) => {
            if (column === 'bot_code' && value === takenBotCode) return chain({ data: { id: 'other-business' }, error: null });
            return q;
          });
          return q;
        }),
        insert: vi.fn((row: Record<string, unknown>) => { businessInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'business-1', bot_code: row.bot_code, slug: 'required-fields' }, error: null }) }) }; }),
        delete: vi.fn(() => chain({ data: null, error: null })),
      };
      if (table === 'category_templates') return { select: vi.fn(() => chain({ data: null, error: null })) };
      if (table === 'whatsapp_config') return { insert: vi.fn(async () => ({ error: null })) };
      if (table === 'business_capabilities') return {
        upsert: vi.fn(async () => ({ error: null })),
        update: vi.fn(() => chain({ data: null, error: null })),
      };
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return { service, inviteInserts, businessInserts };
}

const createRequest = (body: unknown) => new NextRequest('http://localhost/api/admin/onboarding', {
  method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'true');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test');
  m.admin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
  m.sendEmail.mockResolvedValue({ success: true });
  m.audit.mockResolvedValue({ error: null });
  m.allocate.mockResolvedValue({ data: { allocated: true, channel_id: 'shared-ng' }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

async function expectRejected(body: Record<string, unknown>, error: string, options?: { takenBotCode?: string }) {
  const { service, inviteInserts } = fakeService(options);
  m.service.mockReturnValue(service);
  const response = await createOnboarding(createRequest(body));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe(error);
  expect(inviteInserts).toHaveLength(0);
  expect(service.auth.admin.generateLink).not.toHaveBeenCalled();
}

describe('admin onboarding create rejects what Get Started requires', () => {
  it('rejects a missing WhatsApp Name', async () => {
    await expectRejected({ ...input, bot_code: '' }, 'WhatsApp Name is required');
    const { bot_code: _omitted, ...withoutBotCode } = input;
    await expectRejected(withoutBotCode, 'WhatsApp Name is required');
  });

  it('rejects a WhatsApp Name shorter than 2 letters or numbers after clean-up', async () => {
    await expectRejected({ ...input, bot_code: 'A' }, 'WhatsApp Name must be at least 2 letters or numbers');
    await expectRejected({ ...input, bot_code: '!!' }, 'WhatsApp Name must be at least 2 letters or numbers');
  });

  it('rejects no selected feature', async () => {
    await expectRejected({ ...input, capabilities: [] }, 'Please select at least one feature to continue');
    const { capabilities: _omitted, ...withoutCapabilities } = input;
    await expectRejected(withoutCapabilities, 'Please select at least one feature to continue');
  });

  it('rejects a business phone that is not the full number for the country', async () => {
    const message = 'Business phone must be the full number: +234 followed by 10 digits';
    await expectRejected({ ...input, business_phone: '08012345678' }, message);
    await expectRejected({ ...input, business_phone: '+234801234567' }, message);
    await expectRejected({ ...input, business_phone: '+23480123456789' }, message);
    await expectRejected({ ...input, business_phone: '+234801234567a' }, message);
  });

  it('rejects a taken WhatsApp Name before creating the invite', async () => {
    await expectRejected({ ...input, bot_code: 'taken name' }, 'Bot code is already taken. Please choose a different one.', { takenBotCode: 'TAKEN-NAME' });
  });

  it('still rejects the fields that were already required', async () => {
    await expectRejected({ ...input, business_name: ' ' }, 'Business name is required');
    await expectRejected({ ...input, business_phone: '' }, 'Business phone is required');
    await expectRejected({ ...input, city: '' }, 'City is required');
    await expectRejected({ ...input, address: '' }, 'Address is required');
  });

  it('accepts the complete request and saves the cleaned WhatsApp Name and phone', async () => {
    const { service, inviteInserts, businessInserts } = fakeService();
    m.service.mockReturnValue(service);
    const response = await createOnboarding(createRequest({ ...input, bot_code: ' my shop ', business_phone: '+234 801 234 5678' }));
    expect(response.status).toBe(201);
    expect(inviteInserts[0].metadata).toMatchObject({ input: { bot_code: 'MY-SHOP', business_phone: '+2348012345678' } });
    expect(businessInserts[0]).toMatchObject({ bot_code: 'MY-SHOP' });
  });
});

describe('retry keeps the original checks for requests stored before these rules', () => {
  it('validates a stored input without WhatsApp Name or features', async () => {
    const { service } = fakeService();
    const { bot_code: _b, capabilities: _c, ...legacy } = input;
    const validated = await validateAdminOnboardingInput(service as never, { ...legacy, business_phone: '08012345678' } as never);
    expect(validated).toMatchObject({ bot_code: undefined, capabilities: [], business_phone: '08012345678' });
    expect(service.from).not.toHaveBeenCalledWith('countries');
  });
});
