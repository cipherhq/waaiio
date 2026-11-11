/**
 * ChannelResolver under the staging routing policy (Owner rule 2026-11-10).
 * Staging sends shared traffic only through the designated US number, for every
 * business country; production keeps country lookups.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';
import { STAGING_SHARED_WHATSAPP_CHANNEL } from '@/lib/channels/staging-whatsapp-routing';

const boundBusinessIds: string[] = [];
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/channels/message-sender', () => ({
  MetaCloudSender: class { bindBusiness(id: string) { boundBusinessIds.push(id); } },
}));

type Row = Record<string, unknown>;
const ID = STAGING_SHARED_WHATSAPP_CHANNEL.id;
const channel = (over: Row = {}): Row => ({
  id: ID, country_code: 'US', phone_number: '12404712139', channel_type: 'shared', business_id: null,
  is_active: true, connection_status: 'active', provider: 'meta_cloud', waba_id: 'waba', phone_number_id: 'pnid-staging',
  meta_access_token: null, meta_token_expires_at: null, ...over,
});
const LOCAL_NG = () => channel({ id: 'local-ng', country_code: 'NG', phone_number: '2348000000000', phone_number_id: 'pnid-ng' });
const OTHER_US = () => channel({ id: 'other-us', phone_number: '12025550100', phone_number_id: 'pnid-us2' });

function fakeSupabase(state: { businesses: Row[]; whatsapp_channels: Row[] }) {
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  return {
    queries,
    client: {
      from: (table: 'businesses' | 'whatsapp_channels') => {
        const filters: Array<[string, unknown]> = [];
        queries.push({ table, filters });
        const first = () => state[table].find(r => filters.every(([k, v]) => r[k] === v)) ?? null;
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'order', 'limit']) b[m] = () => b;
        b.eq = (k: string, v: unknown) => { filters.push([k, v]); return b; };
        b.maybeSingle = async () => ({ data: first(), error: null });
        b.single = b.maybeSingle;
        return b;
      },
    } as never,
  };
}

const ENV = ['WAAIIO_ENVIRONMENT', 'VERCEL_PROJECT_ID', 'NEXT_PUBLIC_SUPABASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { boundBusinessIds.length = 0; for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
function setStaging(on: boolean) {
  if (on) {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
  } else {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    process.env.VERCEL_PROJECT_ID = 'prj_PRODUCTION';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cxcmiqotkowhxinjbytg.supabase.co';
  }
}
async function resolverFor(state: { businesses: Row[]; whatsapp_channels: Row[] }) {
  const { ChannelResolver } = await import('../channel-resolver');
  const fake = fakeSupabase(state);
  return { resolver: new ChannelResolver(fake.client), queries: fake.queries };
}

describe('staging: shared lookups use only the designated number', () => {
  it.each(['NG', 'GB', 'CA', 'US', 'GH', 'KE', 'ZA'])('getSharedChannelForCountry(%s) returns the designated number', async (cc) => {
    setStaging(true);
    const { resolver, queries } = await resolverFor({ businesses: [], whatsapp_channels: [OTHER_US(), LOCAL_NG(), channel()] });
    const res = await resolver.getSharedChannelForCountry(cc as never);
    expect(res?.channel.id).toBe(ID);
    expect(queries.every(q => !q.filters.some(([k]) => k === 'country_code'))).toBe(true);
  });

  it.each([
    ['missing', []],
    ['owned by a business', [channel({ business_id: 'biz-x' })]],
    ['disconnected', [channel({ connection_status: 'disconnected' })]],
    ['inactive', [channel({ is_active: false })]],
  ])('designated number %s: returns null, never another number', async (_l, rows) => {
    setStaging(true);
    const { resolver } = await resolverFor({ businesses: [], whatsapp_channels: [OTHER_US(), LOCAL_NG(), ...(rows as Row[])] });
    expect(await resolver.getSharedChannelForCountry('NG')).toBeNull();
    expect(await resolver.getSharedChannelForCountry('US')).toBeNull();
  });

  it('resolveByBusinessId: NG business on the designated number sends there, bound to that business', async () => {
    setStaging(true);
    const { resolver } = await resolverFor({
      businesses: [{ id: 'biz-ng', country_code: 'NG', assigned_channel_id: ID, whatsapp_channel_id: null, wa_method: 'shared' }],
      whatsapp_channels: [LOCAL_NG(), channel()],
    });
    const res = await resolver.resolveByBusinessId('biz-ng');
    expect(res?.channel.id).toBe(ID);
    expect(res?.channel.business_id).toBeNull();
    expect(boundBusinessIds).toContain('biz-ng');
  });

  it('resolveByBusinessId: a stale pointer to another shared number fails closed', async () => {
    setStaging(true);
    const { resolver } = await resolverFor({
      businesses: [{ id: 'biz-ng', country_code: 'NG', assigned_channel_id: 'local-ng', whatsapp_channel_id: null, wa_method: 'shared' }],
      whatsapp_channels: [LOCAL_NG(), channel()],
    });
    expect(await resolver.resolveByBusinessId('biz-ng')).toBeNull();
  });

  it('resolveByBusinessId: no "any shared number" fallback when the designated number is down', async () => {
    setStaging(true);
    const { resolver } = await resolverFor({
      businesses: [{ id: 'biz-t', country_code: 'GB', assigned_channel_id: null, whatsapp_channel_id: null, wa_method: 'transfer' }],
      whatsapp_channels: [OTHER_US(), LOCAL_NG(), channel({ connection_status: 'disconnected' })],
    });
    expect(await resolver.resolveByBusinessId('biz-t')).toBeNull();
  });

  it('dedicated channels keep tenant isolation', async () => {
    setStaging(true);
    const ded = channel({ id: 'ded-a', channel_type: 'dedicated', business_id: 'biz-a', phone_number_id: 'pnid-a' });
    const { resolver } = await resolverFor({
      businesses: [
        { id: 'biz-a', country_code: 'US', assigned_channel_id: 'ded-a', whatsapp_channel_id: 'ded-a', wa_method: 'transfer' },
        { id: 'biz-b', country_code: 'US', assigned_channel_id: 'ded-a', whatsapp_channel_id: null, wa_method: 'shared' },
      ],
      whatsapp_channels: [ded, channel()],
    });
    expect((await resolver.resolveByBusinessId('biz-a'))?.channel.id).toBe('ded-a');
    expect(await resolver.resolveByBusinessId('biz-b')).toBeNull();
  });
});

describe('production: country lookups are unchanged', () => {
  it('getSharedChannelForCountry filters by the requested country', async () => {
    setStaging(false);
    const { resolver, queries } = await resolverFor({ businesses: [], whatsapp_channels: [channel(), LOCAL_NG()] });
    expect((await resolver.getSharedChannelForCountry('NG'))?.channel.id).toBe('local-ng');
    expect(queries[0].filters).toContainEqual(['country_code', 'NG']);
    expect(await resolver.getSharedChannelForCountry('GB')).toBeNull();
  });

  it('staging env value on production infrastructure still uses country lookups', async () => {
    setStaging(false);
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    const { resolver } = await resolverFor({ businesses: [], whatsapp_channels: [channel(), LOCAL_NG()] });
    expect((await resolver.getSharedChannelForCountry('NG'))?.channel.id).toBe('local-ng');
  });
});
