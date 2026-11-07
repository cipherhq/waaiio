/**
 * WhatsApp Flow sign-up (Owner decision 2026-11-07): the WhatsApp number that
 * sent the Flow becomes the owner's confirmed phone, the trial is never set by
 * hand, and the normal free-credit check (activate_trial_if_eligible) runs once
 * the business is live. A number already on another login is left off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createUser: vi.fn(),
  rpc: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  channelReady: true,
  allocated: true,
}));

vi.mock('@/lib/channels/operation-admission', () => ({
  channelOperationsEnabled: () => true,
  CHANNEL_OPERATIONS_UNAVAILABLE: { message: 'unavailable' },
}));
vi.mock('@/lib/signup-gate', () => ({ isSignupOpen: async () => true }));
vi.mock('@/lib/capabilities/service', () => ({ initCapabilities: async () => undefined }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ max_businesses_per_user: 5 }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { async getSharedChannelForCountry() { return null; } },
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: async () => undefined }));
vi.mock('@/lib/onboarding/whatsapp-readiness', () => ({
  allocateSharedChannelForNewBusiness: async () => ({ data: { allocated: m.allocated }, error: null }),
  SHARED_CHANNEL_FALLBACK_COUNTRIES: {},
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { admin: { createUser: m.createUser } },
    rpc: m.rpc,
    from: (table: string) => {
      let op: 'select' | 'insert' | 'update' = 'select';
      const q: Record<string, unknown> = {};
      const self = () => q;
      Object.assign(q, {
        select: self, eq: self, in: self, or: self, limit: self,
        insert: (row: Record<string, unknown>) => { op = 'insert'; m.inserts.push({ table, row }); return q; },
        update: () => { op = 'update'; return q; },
        maybeSingle: async () => {
          if (table === 'whatsapp_channels') return { data: m.channelReady ? { connection_status: 'active' } : null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'businesses' && op === 'insert') return { data: { id: 'biz-1', name: 'Fixture Biz', bot_code: 'FIXTUREBIZ' }, error: null };
          if (table === 'businesses' && op === 'update') return { data: { id: 'biz-1', status: 'active', assigned_channel_id: 'ch-1' }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null }),
      });
      return q;
    },
  }),
}));

import { handleOnboardingComplete } from '@/app/api/whatsapp/flow-callback/onboarding';

const submission = {
  first_name: 'Ada', last_name: 'Lovelace', email: 'owner@example.com', password: 'Fixture-Passw0rd!',
  business_name: 'Fixture Biz', category: 'salon', country: 'NG',
};
const run = () => handleOnboardingComplete('onboarding:2348012345678', submission);

beforeEach(() => {
  vi.clearAllMocks();
  m.inserts = [];
  m.channelReady = true;
  m.allocated = true;
  m.createUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  m.rpc.mockResolvedValue({ data: { activated: false, reason: 'financial_gate_off' }, error: null });
});

describe('WhatsApp Flow sign-up and the free credit', () => {
  it('saves the sending WhatsApp number as the confirmed phone of the new login', async () => {
    expect((await run()).success).toBe(true);
    expect(m.createUser).toHaveBeenCalledTimes(1);
    expect(m.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'owner@example.com', email_confirm: true, phone: '+2348012345678', phone_confirm: true,
    }));
  });

  it('never sets the trial by hand on the new business', async () => {
    await run();
    const biz = m.inserts.find(i => i.table === 'businesses')!.row;
    expect(biz).not.toHaveProperty('trial_ends_at');
    expect(biz.subscription_tier).toBe('free');
  });

  it('runs the normal free-credit check once the business is live', async () => {
    await run();
    expect(m.rpc).toHaveBeenCalledWith('activate_trial_if_eligible', { p_business_id: 'biz-1' });
  });

  it.each([
    ['no shared number was allocated', () => { m.allocated = false; }],
    ['the assigned number is not connection-ready', () => { m.channelReady = false; }],
  ])('does not run the check when %s (the business is not live)', async (_name, setup) => {
    setup();
    await run();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('a number already on another login is left off and sign-up still completes', async () => {
    m.createUser
      .mockResolvedValueOnce({ data: { user: null }, error: { code: 'phone_exists', message: 'Phone number already registered by another user' } })
      .mockResolvedValueOnce({ data: { user: { id: 'owner-1' } }, error: null });
    expect((await run()).success).toBe(true);
    expect(m.createUser).toHaveBeenCalledTimes(2);
    expect(m.createUser.mock.calls[1][0]).not.toHaveProperty('phone');
    expect(m.createUser.mock.calls[1][0]).not.toHaveProperty('phone_confirm');
  });

  it('other account errors are not retried', async () => {
    m.createUser.mockResolvedValueOnce({ data: { user: null }, error: { code: 'unexpected_failure', message: 'Database error' } });
    expect(await run()).toEqual({ success: false, error: 'Failed to create account' });
    expect(m.createUser).toHaveBeenCalledTimes(1);
  });

  it('a failed or ineligible trial never blocks sign-up', async () => {
    m.rpc.mockRejectedValueOnce(new Error('network'));
    expect((await run()).success).toBe(true);
  });
});
