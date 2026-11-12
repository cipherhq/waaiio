/**
 * WhatsApp Flow sign-up confirmation under the staging routing policy
 * (Owner rule 2026-11-10). Uses the real ChannelResolver: in staging the
 * confirmation goes out on the designated US number for any country, and the
 * new business keeps its own country. Production keeps country lookups.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';
import { STAGING_SHARED_WHATSAPP_CHANNEL } from '@/lib/channels/staging-whatsapp-routing';

const m = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  sent: [] as Array<{ phoneNumberId: string; to: string }>,
  channels: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/channels/operation-admission', () => ({
  channelOperationsEnabled: () => true,
  CHANNEL_OPERATIONS_UNAVAILABLE: { message: 'unavailable' },
}));
vi.mock('@/lib/signup-gate', () => ({ isSignupOpen: async () => true }));
vi.mock('@/lib/capabilities/service', () => ({ initCapabilities: async () => undefined }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ max_businesses_per_user: 5 }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: async () => undefined }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/onboarding/whatsapp-readiness', () => ({
  allocateSharedChannelForNewBusiness: async () => ({ data: { allocated: true }, error: null }),
  SHARED_CHANNEL_FALLBACK_COUNTRIES: { GH: ['NG'] },
}));
vi.mock('@/lib/channels/meta-cloud', () => ({
  MetaCloudService: class { constructor(public opts: { phoneNumberId: string }) {} },
}));
vi.mock('@/lib/channels/message-sender', () => ({
  MetaCloudSender: class {
    constructor(private cloud: { opts: { phoneNumberId: string } }) {}
    bindBusiness() {}
    async sendText(msg: { to: string }) { m.sent.push({ phoneNumberId: this.cloud.opts.phoneNumberId, to: msg.to }); }
    async sendButtons() {}
  },
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { admin: { createUser: async () => ({ data: { user: { id: 'owner-1' } }, error: null }) } },
    rpc: vi.fn(),
    from: (table: string) => {
      let op: 'select' | 'insert' | 'update' = 'select';
      const filters: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {};
      const self = () => q;
      Object.assign(q, {
        select: self, in: self, or: self, limit: self,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        insert: (row: Record<string, unknown>) => { op = 'insert'; m.inserts.push({ table, row }); return q; },
        update: () => { op = 'update'; return q; },
        maybeSingle: async () => {
          if (table !== 'whatsapp_channels') return { data: null, error: null };
          return { data: m.channels.find(c => filters.every(([k, v]) => c[k] === v)) ?? null, error: null };
        },
        single: async () => {
          if (table === 'businesses' && op === 'insert') return { data: { id: 'biz-1', name: 'Fixture Biz', bot_code: 'FIXTUREBIZ' }, error: null };
          if (table === 'businesses' && op === 'update') return { data: { id: 'biz-1', status: 'active', assigned_channel_id: STAGING_SHARED_WHATSAPP_CHANNEL.id }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null }),
      });
      return q;
    },
  }),
}));

import { handleOnboardingComplete } from '@/app/api/whatsapp/flow-callback/onboarding';

const designated = {
  id: STAGING_SHARED_WHATSAPP_CHANNEL.id, country_code: 'US', phone_number: '12404712139', channel_type: 'shared',
  business_id: null, is_active: true, connection_status: 'active', provider: 'meta_cloud', phone_number_id: 'pnid-staging',
  waba_id: 'waba', meta_access_token: null, meta_token_expires_at: null,
};
const localNg = { ...designated, id: 'local-ng', country_code: 'NG', phone_number: '2348000000000', phone_number_id: 'pnid-ng' };

const ENV = ['WAAIIO_ENVIRONMENT', 'VERCEL_PROJECT_ID', 'NEXT_PUBLIC_SUPABASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.useFakeTimers();
  for (const k of ENV) saved[k] = process.env[k];
  m.inserts = []; m.sent = [];
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const submit = (country: string) => handleOnboardingComplete('onboarding:2348012345678', {
  first_name: 'Ada', email: 'owner@example.com', password: 'Fixture-Passw0rd!', business_name: 'Fixture Biz', category: 'salon', country,
});

describe('Flow sign-up confirmation number', () => {
  it.each(['NG', 'GB', 'GH', 'KE'])('staging %s sign-up: confirmation on the designated number; country kept', async (cc) => {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
    m.channels = [localNg, designated];
    expect((await submit(cc)).success).toBe(true);
    expect(m.sent).toEqual([{ phoneNumberId: 'pnid-staging', to: '2348012345678' }]);
    expect(m.inserts.find(i => i.table === 'businesses')!.row.country_code).toBe(cc);
  });

  it('staging with the designated number down: no confirmation from any other number', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
    m.channels = [localNg, { ...designated, connection_status: 'disconnected' }];
    await submit('NG');
    expect(m.sent).toEqual([]);
  });

  it('production NG sign-up: confirmation on the NG number, never the US one', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    process.env.VERCEL_PROJECT_ID = 'prj_PRODUCTION';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cxcmiqotkowhxinjbytg.supabase.co';
    m.channels = [designated, localNg];
    await submit('NG');
    expect(m.sent).toEqual([{ phoneNumberId: 'pnid-ng', to: '2348012345678' }]);
  });
});
