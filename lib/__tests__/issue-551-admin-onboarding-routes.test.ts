import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  service: vi.fn(),
  rateLimit: vi.fn(),
  validate: vi.fn(),
  provision: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: mocks.authorize }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: mocks.rateLimit }));
vi.mock('@/lib/email/client', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/onboarding/admin-assisted', () => ({
  validateAdminOnboardingInput: mocks.validate,
  provisionAdminBusiness: mocks.provision,
}));

import { GET, POST } from '@/app/api/admin/onboarding/route';

describe('#551 admin onboarding route authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies an unauthenticated caller before privileged storage is opened', async () => {
    mocks.authorize.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost/api/admin/onboarding'));
    expect(response.status).toBe(401);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('denies an authenticated caller without full-admin authority', async () => {
    mocks.authorize.mockResolvedValue(null);
    const response = await POST(new NextRequest('http://localhost/api/admin/onboarding', {
      method: 'POST', headers: { Authorization: 'Bearer non-admin', 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(response.status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), { requiredRole: 'admin' });
  });
});

function chain(result: { data?: unknown; error?: unknown }) {
  const value: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'update', 'delete']) value[method] = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => result);
  value.single = vi.fn(async () => result);
  value.then = (resolve: (input: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return value;
}

describe('#551 admin onboarding orchestration', () => {
  const input = {
    request_key: '9f96271c-6715-4e20-ab96-fce6409ed4cd', owner_first_name: 'Ada', owner_last_name: 'Lovelace',
    owner_email: 'ada@example.test', business_name: 'Exact Business', country: 'NG', category: 'restaurant', city: 'Lagos',
    address: '1 Test Street', business_phone: '+2348012345678', intended_plan: 'growth', capabilities: [], whatsapp_method: 'shared',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    mocks.rateLimit.mockResolvedValue(null);
    mocks.validate.mockResolvedValue(input);
    mocks.provision.mockResolvedValue({ id: 'business-1' });
    mocks.sendEmail.mockResolvedValue({ success: true });
  });

  it('provisions once, sends the mocked invite, persists exact identities, and audits create + invitation', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const service = {
      auth: { admin: {
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
        generateLink: vi.fn(async () => ({ data: { user: { id: 'user-1' }, properties: { action_link: 'https://auth.test/activate' } }, error: null })),
        deleteUser: vi.fn(),
      } },
      from: vi.fn((table: string) => {
        if (table === 'admin_audit_logs') return { insert: vi.fn((row: Record<string, unknown>) => { audits.push(row); return Promise.resolve({ error: null }); }) };
        if (table === 'admin_onboarding_invites') return {
          select: vi.fn(() => chain({ data: null, error: null })),
          insert: vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'onboarding-1', ...input, target_email: input.owner_email, status: 'provisioning' }, error: null }) }) })),
          update: vi.fn((row: Record<string, unknown>) => { updates.push(row); return chain({ data: null, error: null }); }),
        };
        if (table === 'businesses') return { delete: vi.fn(() => chain({ data: null, error: null })) };
        throw new Error(`unexpected table ${table}`);
      }),
    };
    mocks.service.mockReturnValue(service);

    const response = await POST(new NextRequest('http://localhost/api/admin/onboarding', {
      method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }));
    expect(response.status).toBe(201);
    expect(mocks.provision).toHaveBeenCalledWith(service, input, 'user-1', 'onboarding-1');
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(updates).toContainEqual(expect.objectContaining({ target_user_id: 'user-1', business_id: 'business-1', status: 'customer_action_required' }));
    expect(audits.map(row => row.action)).toEqual(['admin_onboarding_create', 'admin_onboarding_invitation_sent']);
  });
});
