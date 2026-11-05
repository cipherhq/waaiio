/**
 * resolveByBusinessId must only send through a shared platform number or a
 * non-shared channel owned by the business. Any other pointer is ignored
 * and never cached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/channels/message-sender', () => ({ MetaCloudSender: class { bindBusiness() {} } }));

const BIZ = 'biz-a';
const OTHER = 'biz-b';
type Row = Record<string, unknown>;
const channel = (o: Row): Row => ({
  id: 'ch', country_code: 'NG', phone_number: '2348000000000', channel_type: 'shared', business_id: null,
  is_active: true, provider: 'meta_cloud', waba_id: 'w', phone_number_id: 'p', meta_access_token: null, meta_token_expires_at: null, ...o,
});

let business: Row | null;
let channelsById: Record<string, Row>;
let ownDedicated: Row | null;
let channelQueries: number;

function from(table: string) {
  const eqs: Record<string, unknown> = {};
  const c: Record<string, any> = {};
  for (const m of ['select', 'in', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c);
  c.eq = vi.fn((col: string, val: unknown) => { eqs[col] = val; return c; });
  c.single = vi.fn(async () => ({ data: table === 'businesses' ? business : null, error: null }));
  c.maybeSingle = vi.fn(async () => {
    if (table !== 'whatsapp_channels') return { data: null, error: null };
    channelQueries++;
    if (eqs.id) return { data: channelsById[eqs.id as string] ?? null, error: null };
    if (eqs.business_id === BIZ && eqs.channel_type === 'dedicated') return { data: ownDedicated, error: null };
    return { data: null, error: null };
  });
  return c;
}

async function resolver() {
  const { ChannelResolver } = await import('../channel-resolver');
  return new ChannelResolver({ from } as any);
}

beforeEach(() => { business = null; channelsById = {}; ownDedicated = null; channelQueries = 0; });

describe('resolveByBusinessId: channel pointer ownership', () => {
  it('uses an assigned shared platform number', async () => {
    business = { country_code: 'NG', assigned_channel_id: 'shared-ng', whatsapp_channel_id: null, wa_method: 'shared' };
    channelsById['shared-ng'] = channel({ id: 'shared-ng' });
    const r = await (await resolver()).resolveByBusinessId(BIZ);
    expect(r?.channel.id).toBe('shared-ng');
  });

  it('still uses a shared number whose row carries a stale business_id', async () => {
    business = { country_code: 'NG', assigned_channel_id: 'shared-stale', whatsapp_channel_id: null, wa_method: 'shared' };
    channelsById['shared-stale'] = channel({ id: 'shared-stale', business_id: OTHER });
    const r = await (await resolver()).resolveByBusinessId(BIZ);
    expect(r?.channel.id).toBe('shared-stale');
  });

  it('uses a dedicated channel the business owns', async () => {
    business = { country_code: 'NG', assigned_channel_id: 'ded-a', whatsapp_channel_id: null, wa_method: 'dedicated' };
    channelsById['ded-a'] = channel({ id: 'ded-a', channel_type: 'dedicated', business_id: BIZ });
    const r = await (await resolver()).resolveByBusinessId(BIZ);
    expect(r?.channel.id).toBe('ded-a');
  });

  it('does not use a dedicated channel owned by a different business; shared business fails closed and nothing is cached', async () => {
    business = { country_code: 'NG', assigned_channel_id: 'ded-b', whatsapp_channel_id: null, wa_method: 'shared' };
    channelsById['ded-b'] = channel({ id: 'ded-b', channel_type: 'dedicated', business_id: OTHER });
    const res = await resolver();
    expect(await res.resolveByBusinessId(BIZ)).toBeNull();
    const cached = (res as any).cache.get(`biz:${BIZ}`);
    expect(cached?.data ?? null).toBeNull();
    // A second call does not return it either.
    expect((await res.resolveByBusinessId(BIZ))?.channel.id).toBeUndefined();
  });

  it('falls back to the business\'s own dedicated channel when whatsapp_channel_id is not its own', async () => {
    business = { country_code: 'NG', assigned_channel_id: null, whatsapp_channel_id: 'ded-b', wa_method: 'dedicated' };
    channelsById['ded-b'] = channel({ id: 'ded-b', channel_type: 'dedicated', business_id: OTHER });
    ownDedicated = channel({ id: 'ded-a', channel_type: 'dedicated', business_id: BIZ });
    const r = await (await resolver()).resolveByBusinessId(BIZ);
    expect(r?.channel.id).toBe('ded-a');
  });
});
