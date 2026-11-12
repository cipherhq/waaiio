/**
 * Staging WhatsApp routing policy (Owner rule 2026-11-10).
 *
 * Staging: every business, whatever its country, uses the one designated US
 * shared number (pinned by row id and phone number). No country search, no
 * local or second US number, fail closed when the designated row is unusable.
 * The business's country (currency, pricing, gateway, fees) never changes.
 *
 * Production: exact-country routing plus the approved GH -> NG fallback only.
 * Missing, malformed or contradictory environment values never enable staging.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';
import { STAGING_SHARED_WHATSAPP_CHANNEL } from '@/lib/channels/staging-whatsapp-routing';

type WhatsAppReadiness = typeof import('../whatsapp-readiness');

const ENV_KEYS = [
  'WAAIIO_ENVIRONMENT', 'NEXT_PUBLIC_WAAIIO_ENVIRONMENT', 'VERCEL_PROJECT_ID', 'NEXT_PUBLIC_SUPABASE_URL',
  'ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'ENABLE_FIRST_SHARED_ASSIGNMENT',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Positive-path fixtures exercise enabled allocation (staging's M430 path).
  process.env.ENABLE_CHANNEL_ALLOCATION_OPERATIONS = 'true';
  delete process.env.ENABLE_FIRST_SHARED_ASSIGNMENT;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.resetModules();
});

async function loadModule(env?: string, stagingIdentity = false): Promise<WhatsAppReadiness> {
  if (env !== undefined) process.env.WAAIIO_ENVIRONMENT = env;
  else delete process.env.WAAIIO_ENVIRONMENT;
  delete process.env.NEXT_PUBLIC_WAAIIO_ENVIRONMENT;
  if (stagingIdentity) {
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
  } else {
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
  vi.resetModules();
  return import('../whatsapp-readiness');
}
const loadStaging = () => loadModule('staging', true);

const DESIGNATED_ID = STAGING_SHARED_WHATSAPP_CHANNEL.id;
type Row = Record<string, unknown>;
type Channel = Row & {
  id?: string | null; channel_type: string | null; is_active: boolean; connection_status: string | null;
  country_code: string | null; business_id: string | null; phone_number?: string | null;
};
const designated = (over: Row = {}): Channel => ({
  id: DESIGNATED_ID, channel_type: 'shared', is_active: true, connection_status: 'active',
  country_code: 'US', business_id: null, phone_number: '12404712139', created_at: '2026-09-25', ...over,
});
// Competing numbers that must never be chosen in staging. Ids sort before the designated id.
const OTHER_US = (): Channel => ({ ...designated(), id: '00000000-0000-4000-8000-000000000001', phone_number: '12025550100', created_at: '2026-01-01' });
const LOCAL_NG = (): Channel => ({ ...designated(), id: '00000000-0000-4000-8000-000000000002', phone_number: '2348000000000', country_code: 'NG', created_at: '2026-01-01' });

const COUNTRIES = ['NG', 'GB', 'CA', 'US', 'GH', 'KE', 'ZA', 'IN'] as const;

function business(country: string | null, over: Row = {}): Row {
  return {
    id: `biz-${country}`, country_code: country, wa_method: 'shared', assigned_channel_id: null, whatsapp_channel_id: null,
    payment_gateway: country === 'NG' || country === 'GH' ? 'paystack' : 'stripe', subscription_tier: 'free', ...over,
  };
}

/** In-memory Supabase stand-in: eq / is / limit filters, update, maybeSingle, rpc. */
function fakeService(state: { businesses: Row[]; whatsapp_channels: Row[] }) {
  const updates: Array<{ table: string; patch: Row; rows: number }> = [];
  const from = (table: 'businesses' | 'whatsapp_channels') => {
    const filters: Array<[string, unknown, 'eq' | 'is']> = [];
    let patch: Row | null = null;
    let limit: number | undefined;
    const matches = () => state[table].filter(r => filters.every(([k, v, op]) => (op === 'is' ? (r[k] ?? null) === v : r[k] === v)));
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (k: string, v: unknown) => { filters.push([k, v, 'eq']); return b; };
    b.is = (k: string, v: unknown) => { filters.push([k, v, 'is']); return b; };
    b.order = () => b;
    b.limit = (n: number) => { limit = n; return b; };
    b.update = (p: Row) => { patch = p; return b; };
    b.maybeSingle = async () => ({ data: matches()[0] ? { ...matches()[0] } : null, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      let rows = matches();
      if (patch) { for (const r of rows) Object.assign(r, patch); updates.push({ table, patch, rows: rows.length }); }
      if (limit !== undefined) rows = rows.slice(0, limit);
      return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(res, rej);
    };
    return b;
  };
  const rpc = vi.fn(async (name: string, args: Row) => {
    if (name === 'reassign_shared_channel') {
      const biz = state.businesses.find(r => r.id === args.p_business_id);
      const ch = state.whatsapp_channels.find(r => r.id === args.p_new_channel_id && r.channel_type === 'shared' && r.is_active);
      if (!biz) return { data: { reassigned: false, reason: 'business_not_found' }, error: null };
      if (!ch) return { data: { reassigned: false, reason: 'invalid_target_channel' }, error: null };
      const old = biz.assigned_channel_id;
      biz.assigned_channel_id = ch.id;
      return { data: { reassigned: true, old_channel_id: old, new_channel_id: ch.id }, error: null };
    }
    return { data: { allocated: false, reason: `unexpected_rpc_${name}` }, error: null };
  });
  return { service: { from, rpc } as never, rpc, updates };
}

// ─── Production (default) ────────────────────────────────────────────────────

describe('production routing is unchanged', () => {
  it.each([undefined, 'production'])('WAAIIO_ENVIRONMENT=%s keeps exact country + GH -> NG only', async (env) => {
    const mod = await loadModule(env);
    expect(mod.isCompatibleSharedChannelCountry('GH', 'NG')).toBe(true);
    for (const cc of ['NG', 'GB', 'CA', 'GH', 'KE']) expect(mod.isCompatibleSharedChannelCountry(cc, 'US')).toBe(false);
    expect(mod.SHARED_CHANNEL_FALLBACK_COUNTRIES).toEqual({ GH: ['NG'] });
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: 'NG' }, designated())).toBe(false);
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: 'US' }, designated())).toBe(true);
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: 'GH' }, LOCAL_NG())).toBe(true);
  });

  it('getSharedChannelFallbackPolicy labels are unchanged (step-up MFA hash contract)', async () => {
    for (const env of [undefined, 'staging']) {
      const mod = await loadModule(env, env === 'staging');
      expect(mod.getSharedChannelFallbackPolicy('GH')).toBe('GH_TO_NG_SHARED');
      for (const cc of ['NG', 'GB', 'CA', 'US', 'KE']) expect(mod.getSharedChannelFallbackPolicy(cc)).toBe('EXACT_COUNTRY');
    }
  });

  it('allocation searches by exact country, then GH -> NG, never US', async () => {
    const mod = await loadModule('production');
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null })
      .mockResolvedValueOnce({ data: { allocated: true, channel_id: 'ch-ng' }, error: null });
    const res = await mod.allocateSharedChannelWithFallback({ rpc } as never, 'biz-gh', 'GH');
    expect(rpc.mock.calls).toEqual([
      ['allocate_shared_channel', { p_business_id: 'biz-gh', p_country_code: 'GH' }],
      ['allocate_shared_channel', { p_business_id: 'biz-gh', p_country_code: 'NG' }],
    ]);
    expect(res.data).toMatchObject({ allocated: true, channel_country: 'NG', fallback_used: true });

    const ngRpc = vi.fn().mockResolvedValue({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null });
    const ng = await mod.allocateSharedChannelWithFallback({ rpc: ngRpc } as never, 'biz-ng', 'NG');
    expect(ngRpc).toHaveBeenCalledTimes(1);
    expect(ng.data?.allocated).toBe(false);
  });

  it('M507 first assignment still uses the database function', async () => {
    delete process.env.ENABLE_CHANNEL_ALLOCATION_OPERATIONS;
    process.env.ENABLE_FIRST_SHARED_ASSIGNMENT = 'true';
    const mod = await loadModule('production');
    const rpc = vi.fn().mockResolvedValue({ data: { allocated: true, channel_id: 'ch-ng' }, error: null });
    await mod.allocateSharedChannelForNewBusiness({ rpc } as never, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledWith('assign_first_shared_channel', { p_business_id: 'biz-ng' });
  });

  it('dedicated tenant isolation is unchanged in both environments', async () => {
    for (const env of ['production', 'staging']) {
      const mod = await loadModule(env, env === 'staging');
      const own = { id: 'ded', channel_type: 'dedicated', is_active: true, connection_status: 'active', country_code: 'NG', business_id: 'biz-a' };
      expect(mod.isAssignedWhatsAppChannelReady({ id: 'biz-a', country_code: 'NG' }, own)).toBe(true);
      expect(mod.isAssignedWhatsAppChannelReady({ id: 'biz-b', country_code: 'NG' }, own)).toBe(false);
    }
  });
});

// ─── Environment identity ────────────────────────────────────────────────────

describe('only real staging infrastructure enables staging routing', () => {
  const ngOnDesignated = (mod: WhatsAppReadiness) => mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: 'NG' }, designated());

  it.each(['Staging', 'STAGING', ' staging', 'staging ', 'stage', 'development', ''])(
    'WAAIIO_ENVIRONMENT=%j (with staging identity) does not enable it', async (env) => {
      expect(ngOnDesignated(await loadModule(env, true))).toBe(false);
    });

  it('staging env value without staging infrastructure identity does not enable it', async () => {
    expect(ngOnDesignated(await loadModule('staging', false))).toBe(false);
  });

  it('staging env value on production infrastructure does not enable it', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = 'prj_PRODUCTION_PROJECT_ID';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cxcmiqotkowhxinjbytg.supabase.co';
    vi.resetModules();
    const mod = await import('../whatsapp-readiness');
    expect(ngOnDesignated(mod)).toBe(false);
    const rpc = vi.fn().mockResolvedValue({ data: { allocated: false, reason: 'no_shared_channel_for_country' }, error: null });
    await mod.allocateSharedChannelWithFallback({ rpc } as never, 'biz-ng', 'NG');
    expect(rpc).toHaveBeenCalledWith('allocate_shared_channel', { p_business_id: 'biz-ng', p_country_code: 'NG' });
  });

  it('client-side NEXT_PUBLIC_WAAIIO_ENVIRONMENT alone does not enable it', async () => {
    delete process.env.WAAIIO_ENVIRONMENT;
    process.env.NEXT_PUBLIC_WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
    vi.resetModules();
    expect(ngOnDesignated(await import('../whatsapp-readiness'))).toBe(false);
  });
});

// ─── Staging readiness and links ─────────────────────────────────────────────

describe('staging readiness: every country uses the designated number', () => {
  it.each(COUNTRIES)('%s business is ready on the designated US number', async (cc) => {
    const mod = await loadStaging();
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: cc }, designated())).toBe(true);
  });

  it.each([
    ['another US shared number', OTHER_US()],
    ['a country-local shared number', LOCAL_NG()],
    ['the designated row with a business owner', designated({ business_id: 'biz-x' })],
    ['the designated row inactive', designated({ is_active: false })],
    ['the designated row disconnected', designated({ connection_status: 'disconnected' })],
    ['the designated id with a different number', designated({ phone_number: '12025550199' })],
    ['the designated row with another country', designated({ country_code: 'NG' })],
    ['a row with no id (caller did not select it)', designated({ id: undefined })],
  ])('NG business is NOT ready on %s', async (_label, channel) => {
    const mod = await loadStaging();
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: 'NG' }, channel as never)).toBe(false);
  });

  it('a business with no country is not ready', async () => {
    const mod = await loadStaging();
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: null }, designated())).toBe(false);
    expect(mod.isAssignedWhatsAppChannelReady({ id: 'b', country_code: ' ' }, designated())).toBe(false);
  });

  it('merchant link keeps the business bot code for every country', async () => {
    const mod = await loadStaging();
    for (const cc of COUNTRIES) {
      const biz = { id: 'b', country_code: cc, bot_code: 'TESTBIZ', status: 'active' };
      expect(mod.buildVerifiedWhatsAppLink(biz, designated() as never)).toBe('https://wa.me/12404712139?text=TESTBIZ');
    }
    const prod = await loadModule('production');
    expect(prod.buildVerifiedWhatsAppLink({ id: 'b', country_code: 'NG', bot_code: 'TESTBIZ', status: 'active' }, designated() as never)).toBeNull();
  });
});

// ─── Staging allocation ──────────────────────────────────────────────────────

describe('staging allocation (channel operations / M430 path)', () => {
  it.each(COUNTRIES)('%s business gets the designated number; country and money settings unchanged', async (cc) => {
    const mod = await loadStaging();
    const biz = business(cc);
    const before = { ...biz };
    const { service, rpc, updates } = fakeService({ businesses: [biz], whatsapp_channels: [OTHER_US(), LOCAL_NG(), designated()] });
    const res = await mod.allocateSharedChannelWithFallback(service, biz.id as string, cc);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ allocated: true, channel_id: DESIGNATED_ID, phone_number: '12404712139', channel_country: 'US', fallback_used: cc !== 'US' });
    expect(rpc.mock.calls).toEqual([['reassign_shared_channel', { p_business_id: biz.id, p_new_channel_id: DESIGNATED_ID }]]);
    expect(updates).toEqual([]);
    expect(biz).toEqual({ ...before, assigned_channel_id: DESIGNATED_ID });
  });

  it('never searches by country, even when local and other US numbers exist', async () => {
    const mod = await loadStaging();
    const { service, rpc } = fakeService({ businesses: [business('NG')], whatsapp_channels: [LOCAL_NG(), OTHER_US(), designated()] });
    await mod.allocateSharedChannelWithFallback(service, 'biz-NG', 'NG', { repairStaleSharedChannel: true });
    expect(rpc.mock.calls.map(c => c[0])).not.toContain('allocate_shared_channel');
  });

  it.each([
    ['missing', null, 'staging_designated_channel_missing'],
    ['inactive', designated({ is_active: false }), 'staging_designated_channel_inactive'],
    ['disconnected', designated({ connection_status: 'disconnected' }), 'staging_designated_channel_disconnected'],
    ['owned by a business', designated({ business_id: 'biz-x' }), 'staging_designated_channel_business_owned'],
    ['a different number', designated({ phone_number: '12025550199' }), 'staging_designated_channel_identity_mismatch'],
  ])('designated number %s: fails closed and assigns nothing', async (_label, channel, reason) => {
    const mod = await loadStaging();
    const biz = business('GB');
    const channels = [OTHER_US(), LOCAL_NG(), ...(channel ? [channel] : [])];
    const { service, rpc, updates } = fakeService({ businesses: [biz], whatsapp_channels: channels });
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-GB', 'GB', { repairStaleSharedChannel: true });
    expect(res.data).toMatchObject({ allocated: false, reason });
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(biz.assigned_channel_id).toBeNull();
  });

  it('already on the designated number: idempotent, no writes', async () => {
    const mod = await loadStaging();
    const { service, rpc } = fakeService({ businesses: [business('NG', { assigned_channel_id: DESIGNATED_ID })], whatsapp_channels: [designated()] });
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-NG', 'NG');
    expect(res.data).toMatchObject({ allocated: true, idempotent: true, channel_id: DESIGNATED_ID });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('on another shared number: not moved without repair; moved by the repair path', async () => {
    const mod = await loadStaging();
    const biz = business('NG', { assigned_channel_id: LOCAL_NG().id });
    const { service, rpc } = fakeService({ businesses: [biz], whatsapp_channels: [LOCAL_NG(), designated()] });
    const plain = await mod.allocateSharedChannelWithFallback(service, 'biz-NG', 'NG');
    expect(plain.data).toMatchObject({ allocated: false, reason: 'assigned_channel_not_staging_designated' });
    expect(rpc).not.toHaveBeenCalled();
    const repaired = await mod.allocateSharedChannelWithFallback(service, 'biz-NG', 'NG', { repairStaleSharedChannel: true });
    expect(repaired.data).toMatchObject({ allocated: true, repaired: true, channel_id: DESIGNATED_ID });
    expect(biz.assigned_channel_id).toBe(DESIGNATED_ID);
  });

  it('a ready own dedicated channel is kept', async () => {
    const mod = await loadStaging();
    const ded = { id: 'ded-1', channel_type: 'dedicated', is_active: true, connection_status: 'active', country_code: 'US', business_id: 'biz-US', phone_number: '+12405070285' };
    const biz = business('US', { wa_method: 'transfer', assigned_channel_id: 'ded-1', whatsapp_channel_id: 'ded-1' });
    const { service, rpc } = fakeService({ businesses: [biz], whatsapp_channels: [ded, designated()] });
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-US', 'US', { repairStaleSharedChannel: true });
    expect(res.data).toMatchObject({ allocated: true, idempotent: true, channel_id: 'ded-1' });
    expect(rpc).not.toHaveBeenCalled();
    expect(biz.assigned_channel_id).toBe('ded-1');
  });

  it('refuses first assignment when the business has other channel authority', async () => {
    const mod = await loadStaging();
    const cases: Array<[Row, Row[], string]> = [
      [business('NG', { whatsapp_channel_id: 'ded-9' }), [], 'has_channel'],
      [business('NG', { wa_method: 'dedicated' }), [], 'not_shared_method'],
      [business('NG'), [{ id: 'ded-2', channel_type: 'dedicated', business_id: 'biz-NG', is_active: false, connection_status: 'disconnected', country_code: 'NG' }], 'has_dedicated_channel'],
    ];
    for (const [biz, extra, reason] of cases) {
      const { service, rpc } = fakeService({ businesses: [biz], whatsapp_channels: [designated(), ...extra] });
      const res = await mod.allocateSharedChannelWithFallback(service, 'biz-NG', 'NG');
      expect(res.data).toMatchObject({ allocated: false, reason });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('capacity refusal from the database function is reported, not bypassed', async () => {
    const mod = await loadStaging();
    const { service, rpc } = fakeService({ businesses: [business('KE')], whatsapp_channels: [designated()] });
    rpc.mockResolvedValueOnce({ data: { reassigned: false, reason: 'target_at_capacity' }, error: null });
    const res = await mod.allocateSharedChannelWithFallback(service, 'biz-KE', 'KE');
    expect(res.data).toMatchObject({ allocated: false, reason: 'target_at_capacity' });
  });
});

describe('staging allocation (first-assignment / M507 switch only)', () => {
  beforeEach(() => {
    delete process.env.ENABLE_CHANNEL_ALLOCATION_OPERATIONS;
    process.env.ENABLE_FIRST_SHARED_ASSIGNMENT = 'true';
  });

  it.each(COUNTRIES)('%s business gets the designated number, not the exact-country function', async (cc) => {
    const mod = await loadStaging();
    const biz = business(cc);
    const before = { ...biz };
    const { service, rpc, updates } = fakeService({ businesses: [biz], whatsapp_channels: [OTHER_US(), LOCAL_NG(), designated()] });
    const res = await mod.allocateSharedChannelForNewBusiness(service, biz.id as string, cc);
    expect(res.data).toMatchObject({ allocated: true, channel_id: DESIGNATED_ID, channel_country: 'US' });
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toEqual([{ table: 'businesses', patch: { assigned_channel_id: DESIGNATED_ID }, rows: 1 }]);
    expect(biz).toEqual({ ...before, assigned_channel_id: DESIGNATED_ID });
  });

  it('never replaces an existing assignment', async () => {
    const mod = await loadStaging();
    const biz = business('NG', { assigned_channel_id: LOCAL_NG().id });
    const { service, updates } = fakeService({ businesses: [biz], whatsapp_channels: [LOCAL_NG(), designated()] });
    const res = await mod.assignFirstSharedChannel(service, 'biz-NG');
    expect(res.data).toMatchObject({ allocated: false, reason: 'assigned_channel_not_staging_designated' });
    expect(updates).toEqual([]);
    expect(biz.assigned_channel_id).toBe(LOCAL_NG().id);
  });

  it('fails closed when the designated number is unusable', async () => {
    const mod = await loadStaging();
    const { service, updates } = fakeService({ businesses: [business('ZA')], whatsapp_channels: [OTHER_US(), designated({ connection_status: 'pending' })] });
    const res = await mod.assignFirstSharedChannel(service, 'biz-ZA');
    expect(res.data).toMatchObject({ allocated: false, reason: 'staging_designated_channel_disconnected' });
    expect(updates).toEqual([]);
  });

  it('both switches off: still unavailable, exactly as before', async () => {
    delete process.env.ENABLE_FIRST_SHARED_ASSIGNMENT;
    const mod = await loadStaging();
    const { service, rpc, updates } = fakeService({ businesses: [business('NG')], whatsapp_channels: [designated()] });
    const res = await mod.allocateSharedChannelForNewBusiness(service, 'biz-NG', 'NG');
    expect(res.data).toMatchObject({ allocated: false, unavailable: true });
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});
