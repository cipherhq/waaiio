/**
 * WhatsApp Flow sign-up (Owner decision 2026-11-07): the trial is never set by
 * hand. The free credit starts only through activate_trial_if_eligible after
 * the owner verifies a phone on /dashboard/claim-credit, so this path neither
 * trusts the number in the flow token nor runs the credit check itself.
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
});

describe('WhatsApp Flow sign-up and the free credit', () => {
  it('completes, and never saves the flow-token number as a confirmed phone', async () => {
    expect((await run()).success).toBe(true);
    expect(m.createUser).toHaveBeenCalledTimes(1);
    const attrs = m.createUser.mock.calls[0][0];
    expect(attrs).toMatchObject({ email: 'owner@example.com', email_confirm: true });
    expect(attrs).not.toHaveProperty('phone');
    expect(attrs).not.toHaveProperty('phone_confirm');
  });

  it('never sets the trial by hand on the new business', async () => {
    await run();
    const biz = m.inserts.find(i => i.table === 'businesses')!.row;
    expect(biz).not.toHaveProperty('trial_ends_at');
    expect(biz.subscription_tier).toBe('free');
  });

  it('does not run the credit check itself (it runs when the owner claims)', async () => {
    await run();
    expect(m.rpc).not.toHaveBeenCalledWith('activate_trial_if_eligible', expect.anything());
  });
});
