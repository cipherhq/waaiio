import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), service: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.service }));

import { POST } from '@/app/api/onboarding/activate-admin-invite/route';

function query(result: { data?: unknown; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const name of ['select', 'eq']) q[name] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => result);
  return q;
}

function serviceFor(options: { consent?: boolean; owner?: string } = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const service = {
    from: vi.fn((table: string) => {
      if (table === 'admin_onboarding_invites') return query({ data: { id: 'onboarding-1', target_user_id: 'user-1', target_email: 'owner@test.dev', business_id: 'business-1', intended_plan: 'growth', whatsapp_method: 'shared' }, error: null });
      if (table === 'profiles') return query({ data: { metadata: options.consent ? { consent_preferences: { consented_at: 'now', terms_accepted_at: 'now' } } : {} }, error: null });
      if (table === 'businesses') return query({ data: { id: 'business-1', owner_id: options.owner || 'user-1', status: 'pending', subscription_tier: 'free' }, error: null });
      if (table === 'admin_audit_logs') return { insert: vi.fn(async (row: Record<string, unknown>) => { audits.push(row); return { error: null }; }) };
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return { service, audits };
}

describe('#551 customer-owned activation gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies an unverified email before any privileged query', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email_confirmed_at: null } } });
    const response = await POST(new NextRequest('http://localhost/api/onboarding/activate-admin-invite', { method: 'POST' }));
    expect(response.status).toBe(409);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('cannot activate without customer-recorded terms and privacy consent', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email_confirmed_at: 'now' } } });
    const { service } = serviceFor(); mocks.service.mockReturnValue(service);
    const response = await POST(new NextRequest('http://localhost/api/onboarding/activate-admin-invite', { method: 'POST' }));
    expect(response.status).toBe(409);
  });

  it('returns paid checkout requirement without granting paid entitlement or activating the business', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email_confirmed_at: 'now' } } });
    const { service, audits } = serviceFor({ consent: true }); mocks.service.mockReturnValue(service);
    const response = await POST(new NextRequest('http://localhost/api/onboarding/activate-admin-invite', { method: 'POST' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ business_id: 'business-1', intended_plan: 'growth', checkout_required: true });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('admin_onboarding_customer_accepted');
    expect(service.from('businesses')).not.toHaveProperty('update');
  });
});
