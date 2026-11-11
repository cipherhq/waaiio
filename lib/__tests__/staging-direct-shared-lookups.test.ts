/**
 * Follow-up to PR #970 (Owner rule 2026-11-10): server paths that picked "a
 * shared WhatsApp number" themselves now follow the staging rule.
 *
 * Staging: every path uses only the designated number +1 240 471 2139, for any
 * business country; competing shared numbers (another US number, a local NG
 * number) are never chosen, even when they come first; a broken designated row
 * fails closed. Production: the exact same query chain as before, and the
 * same result.
 *
 * Runs the real route handlers and library functions on an in-memory database
 * that really applies filters (lib/__tests__/helpers/memory-db.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';
import {
  BROKEN_DESIGNATED, DESIGNATED_ID, allShared, channelChains, designated, localNg, otherUs,
  record, saveEnv, setStaging, type Recorded,
} from './helpers/staging-channels';

const H = vi.hoisted(() => ({
  db: null as unknown,
  cloudConfigs: [] as Array<{ phoneNumberId: string; accessToken: string }>,
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => H.db }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...l, withContext: () => l } };
});
vi.mock('@/lib/channels/message-sender', () => ({ MetaCloudSender: class { bindBusiness() {} } }));
vi.mock('@/lib/channels/meta-cloud', () => ({
  MetaCloudService: class {
    constructor(config: { phoneNumberId: string; accessToken: string }) { H.cloudConfigs.push(config); }
    async sendAuthenticationTemplate() { return { messageId: 'wamid.test' }; }
  },
}));
vi.mock('@/lib/otp-phone-token', () => ({ generatePhoneOtp: async () => ({ code: '123456', challengeId: 'c1' }) }));
vi.mock('@/lib/brute-force', () => ({ checkBruteForce: () => ({ blocked: false }) }));
vi.mock('@/lib/channels/direct-route-attempt', () => ({
  withDirectRouteAttempt: async (_sb: unknown, _p: unknown, fn: () => Promise<unknown>) => { await fn(); return { ok: true }; },
}));
// Primary path only: proves which database channel the OTP route picks.
vi.mock('@/lib/channels/otp-send-orchestrator', () => ({
  orchestrateOtpSend: async (d: { supabase: unknown; primarySend: (sb: unknown) => Promise<{ ok: boolean }> }) => {
    const r = await d.primarySend(d.supabase);
    return { sent: r.ok, deliveryPath: null, waMessageId: null };
  },
}));

type Row = Record<string, unknown>;
const BIZ = '11111111-1111-4111-8111-111111111111';
const OWNER_PHONE = '2348099999999';

let restoreEnv: () => void;
beforeEach(() => { restoreEnv = saveEnv(); H.cloudConfigs.length = 0; });
afterEach(() => restoreEnv());

function useDb(tables: Record<string, Row[]>): Recorded {
  const rec = record(createMemoryDb(tables));
  H.db = rec.client;
  return rec;
}
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${url}`, init);

// ── Helper ───────────────────────────────────────────────────────────

describe('loadStagingDesignatedChannel', () => {
  it('reads the designated row by its pinned id only (no country or type search)', async () => {
    const { loadStagingDesignatedChannel } = await import('@/lib/channels/staging-whatsapp-routing');
    const rec = useDb({ whatsapp_channels: allShared() });
    const row = await loadStagingDesignatedChannel(rec.client as never);
    expect(row?.id).toBe(DESIGNATED_ID);
    const chains = channelChains(rec);
    expect(chains).toHaveLength(1);
    expect(chains[0].filter(c => c[0] === 'eq')).toEqual([['eq', 'id', DESIGNATED_ID]]);
    expect(String(chains[0][0][1])).not.toContain('meta_access_token');
  });

  it('adds the token columns only when credentials are asked for', async () => {
    const { loadStagingDesignatedChannel } = await import('@/lib/channels/staging-whatsapp-routing');
    const rec = useDb({ whatsapp_channels: allShared() });
    const row = await loadStagingDesignatedChannel(rec.client as never, { credentials: true });
    expect(row?.meta_access_token).toBe('tok-staging');
    expect(String(channelChains(rec)[0][0][1])).toContain('meta_access_token');
  });

  it.each(BROKEN_DESIGNATED)('designated row %s → null', async (_label, rows) => {
    const { loadStagingDesignatedChannel } = await import('@/lib/channels/staging-whatsapp-routing');
    const rec = useDb({ whatsapp_channels: rows });
    expect(await loadStagingDesignatedChannel(rec.client as never)).toBeNull();
  });

  it('a read error → null', async () => {
    const { loadStagingDesignatedChannel } = await import('@/lib/channels/staging-whatsapp-routing');
    const db = createMemoryDb({ whatsapp_channels: allShared() });
    db.failReads.add('whatsapp_channels');
    expect(await loadStagingDesignatedChannel(db as never)).toBeNull();
  });
});

// ── ChannelResolver.resolveByChannelIdForBusiness ───────────────────

describe('ChannelResolver.resolveByChannelIdForBusiness', () => {
  const dedicatedOwned = (): Row => designated({
    id: 'ded-a', channel_type: 'dedicated', business_id: BIZ, phone_number: '2348011111111', phone_number_id: 'pnid-ded-a',
  });
  async function resolve(channelId: string, rows: Row[]) {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const rec = useDb({ whatsapp_channels: rows, businesses: [{ id: BIZ, assigned_channel_id: null, whatsapp_channel_id: null }] });
    return new ChannelResolver(rec.client as never).resolveByChannelIdForBusiness(channelId, BIZ);
  }

  it('staging: the designated shared number is accepted', async () => {
    setStaging(true);
    expect((await resolve(DESIGNATED_ID, allShared()))?.channel.id).toBe(DESIGNATED_ID);
  });
  it.each(['other-us', 'local-ng'])('staging: competing shared number %s is refused', async (id) => {
    setStaging(true);
    expect(await resolve(id, allShared())).toBeNull();
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → refused', async (_l, rows) => {
    setStaging(true);
    expect(await resolve(DESIGNATED_ID, rows)).toBeNull();
  });
  it("staging: the business's own dedicated channel is unchanged", async () => {
    setStaging(true);
    expect((await resolve('ded-a', [...allShared(), dedicatedOwned()]))?.channel.id).toBe('ded-a');
  });
  it.each(['other-us', 'local-ng', DESIGNATED_ID])('production: any active shared number %s is accepted (unchanged)', async (id) => {
    setStaging(false);
    expect((await resolve(id, allShared()))?.channel.id).toBe(id);
  });
});

// ── Launch delivery credentials ─────────────────────────────────────

describe('launch delivery: resolveChannelCredentials', () => {
  async function creds(receiving: string, rows: Row[]) {
    const { resolveChannelCredentials } = await import('@/lib/launch/delivery');
    const rec = useDb({ whatsapp_channels: rows });
    return { result: await resolveChannelCredentials(rec.client as never, receiving), rec };
  }
  const STAGING_CREDS = { phone_number_id: 'pnid-staging', meta_access_token: 'tok-staging', waba_id: 'waba-staging', phone_number: '12404712139' };

  it.each(['pnid-staging', '12404712139'])('staging: subscriber on the designated number (%s) → designated credentials', async (r) => {
    setStaging(true);
    expect((await creds(r, allShared())).result).toEqual(STAGING_CREDS);
  });
  it.each(['pnid-us2', 'pnid-ng', '2348000000000'])('staging: subscriber on competing number %s → no credentials', async (r) => {
    setStaging(true);
    expect((await creds(r, allShared())).result).toBeNull();
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → no credentials', async (_l, rows) => {
    setStaging(true);
    expect((await creds('pnid-staging', rows)).result).toBeNull();
  });
  it('production: same queries and result as before', async () => {
    setStaging(false);
    const { result, rec } = await creds('pnid-us2', allShared());
    expect(result).toMatchObject({ phone_number_id: 'pnid-us2', meta_access_token: 'tok-us2' });
    expect(channelChains(rec)).toEqual([[
      ['select', 'phone_number_id, meta_access_token, waba_id, phone_number'],
      ['eq', 'phone_number_id', 'pnid-us2'], ['eq', 'channel_type', 'shared'], ['eq', 'is_active', true],
      ['limit', 1], ['maybeSingle'],
    ]]);
    const fallback = await creds('2348000000000', allShared());
    expect(fallback.result?.phone_number_id).toBe('pnid-ng');
    expect(channelChains(fallback.rec)[1]).toEqual([
      ['select', 'phone_number_id, meta_access_token, waba_id, phone_number'],
      ['eq', 'phone_number', '2348000000000'], ['eq', 'channel_type', 'shared'], ['eq', 'is_active', true],
      ['limit', 1], ['maybeSingle'],
    ]);
  });
});

// ── Merchant notification enrollment ────────────────────────────────

describe('merchant notifications: sharedChannel', () => {
  async function pick(biz: Row, rows: Row[]) {
    const { sharedChannel } = await import('@/lib/merchant-notifications/enrollment');
    const rec = useDb({ businesses: [{ id: BIZ, ...biz }], whatsapp_channels: rows });
    return { result: await sharedChannel(rec.client as never, BIZ), rec };
  }
  const DESIGNATED_PICK = { id: DESIGNATED_ID, phone_number: '12404712139', phone_number_id: 'pnid-staging' };

  it.each(['NG', 'GB', 'US', 'KE'])('staging: %s business assigned the designated number → designated', async (cc) => {
    setStaging(true);
    expect((await pick({ country_code: cc, assigned_channel_id: DESIGNATED_ID }, allShared())).result).toEqual(DESIGNATED_PICK);
  });
  it('staging: business assigned a competing shared number → none', async () => {
    setStaging(true);
    expect((await pick({ country_code: 'NG', assigned_channel_id: 'local-ng' }, allShared())).result).toBeNull();
    expect((await pick({ country_code: 'US', assigned_channel_id: 'other-us' }, allShared())).result).toBeNull();
  });
  it('staging: business on its own dedicated number → designated platform number', async () => {
    setStaging(true);
    const ded = designated({ id: 'ded-a', channel_type: 'dedicated', business_id: BIZ, phone_number_id: 'pnid-ded-a' });
    expect((await pick({ country_code: 'NG', assigned_channel_id: 'ded-a' }, [...allShared(), ded])).result).toEqual(DESIGNATED_PICK);
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → none', async (_l, rows) => {
    setStaging(true);
    expect((await pick({ country_code: 'NG', assigned_channel_id: DESIGNATED_ID }, rows)).result).toBeNull();
  });
  it('production: unchanged exact-country behavior', async () => {
    setStaging(false);
    const ng = await pick({ country_code: 'NG', assigned_channel_id: 'local-ng' }, allShared());
    expect(ng.result?.id).toBe('local-ng');
    expect(channelChains(ng.rec)[1]).toEqual([
      ['select', 'id,phone_number,phone_number_id'], ['eq', 'country_code', 'NG'], ['eq', 'channel_type', 'shared'],
      ['eq', 'provider', 'meta_cloud'], ['eq', 'is_active', true], ['eq', 'id', 'local-ng'], ['maybeSingle'],
    ]);
    // A NG business pointed at the US number gets nothing in production (country must match).
    expect((await pick({ country_code: 'NG', assigned_channel_id: DESIGNATED_ID }, allShared())).result).toBeNull();
  });
});

// ── Customer updates opt-in: Waaiio sender number ───────────────────

describe('customer updates opt-in: Waaiio sender number', () => {
  const PHONE = '2348012345678';
  function seed(channels: Row[]): MemoryDb {
    const db = createMemoryDb({
      businesses: [{ id: BIZ, name: 'Mama Put Kitchen', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG' }],
      bot_sessions: [{ id: 's-a', business_id: BIZ, whatsapp_number: PHONE, session_data: {}, updated_at: '2026-11-06T10:00:00Z' }],
      customer_profiles: [], customer_consents: [], messaging_opt_outs: [], launch_subscribers: [],
      whatsapp_channels: [...channels, designated({ id: 'ded-a', channel_type: 'dedicated', business_id: BIZ, phone_number_id: 'pnid-ded-a', country_code: 'NG' })],
    });
    H.db = db;
    return db;
  }
  async function tap(db: MemoryDb, destinationPhone: string, preResolvedBusinessId?: string) {
    const { handleUpdatesOptInTap, updatesOptInPostback } = await import('@/lib/bot/customer-updates-optin');
    await handleUpdatesOptInTap(db as never, {
      from: PHONE, text: updatesOptInPostback('menu', BIZ), messageType: 'list',
      preResolvedBusinessId, destinationPhone, sendReply: async () => {},
    });
    return db.tables.launch_subscribers;
  }

  it("staging: tap on the business's own number → Waaiio sends from the designated number, not the local NG one", async () => {
    setStaging(true);
    const subs = await tap(seed(allShared()), 'pnid-ded-a', BIZ);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ receiving_number: 'pnid-staging', market: 'NG' });
  });
  it('staging: tap on a competing shared number → still the designated number', async () => {
    setStaging(true);
    expect((await tap(seed(allShared()), 'pnid-ng'))[0]).toMatchObject({ receiving_number: 'pnid-staging' });
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → business consent only, no Waaiio subscriber', async (_l, rows) => {
    setStaging(true);
    const db = seed(rows);
    expect(await tap(db, 'pnid-ded-a', BIZ)).toHaveLength(0);
    expect(db.tables.customer_consents.length).toBeGreaterThan(0);
  });
  it('production: unchanged (tap number if shared, else oldest shared number for the country)', async () => {
    setStaging(false);
    expect((await tap(seed(allShared()), 'pnid-ded-a', BIZ))[0]).toMatchObject({ receiving_number: 'pnid-ng' });
    expect((await tap(seed(allShared()), 'pnid-us2'))[0]).toMatchObject({ receiving_number: 'pnid-us2' });
  });
});

// ── Public link routes: form, invoice, check-in ─────────────────────

const ORIGINAL_SHARED_LINK_CHAIN = [
  ['select', 'phone_number'], ['eq', 'channel_type', 'shared'], ['eq', 'is_active', true], ['limit', 1], ['maybeSingle'],
];
const linkBusiness = (over: Row = {}): Row => ({
  id: BIZ, name: 'TestBiz', phone: OWNER_PHONE, logo_url: null, subscription_tier: 'free', status: 'active',
  assigned_channel_id: null, whatsapp_channel_id: null, wa_method: 'shared', bot_code: 'TESTBIZ', country_code: 'NG', ...over,
});

const routes: Array<{ name: string; call: (rows: Row[]) => Promise<{ phone: string | null; rec: Recorded }> }> = [
  {
    name: 'public form',
    call: async (rows) => {
      const { GET } = await import('@/app/api/forms/public/[token]/route');
      const rec = useDb({
        forms: [{ id: 'f1', token: 'ftok', title: 'T', description: null, fields: [], is_active: true, business_id: BIZ, settings: null }],
        businesses: [linkBusiness()], whatsapp_channels: rows,
      });
      const res = await GET(req('/api/forms/public/ftok'), { params: Promise.resolve({ token: 'ftok' }) });
      return { phone: (await res.json()).business_phone, rec };
    },
  },
  {
    name: 'public invoice',
    call: async (rows) => {
      const { GET } = await import('@/app/api/invoices/public/[token]/route');
      const rec = useDb({
        invoices: [{ id: 'i1', token: 'itok', business_id: BIZ, status: 'paid', invoice_items: [] }],
        businesses: [linkBusiness()], whatsapp_channels: rows,
      });
      const res = await GET(req('/api/invoices/public/itok'), { params: Promise.resolve({ token: 'itok' }) });
      return { phone: (await res.json()).business_phone, rec };
    },
  },
  {
    name: 'check-in',
    call: async (rows) => {
      const { POST } = await import('@/app/api/checkin/route');
      const rec = useDb({ businesses: [linkBusiness()], attendance_log: [], whatsapp_channels: rows });
      const res = await POST(req('/api/checkin', { method: 'POST', body: JSON.stringify({ business_id: BIZ, customer_name: 'Ada' }) }));
      const link = (await res.json()).wa_link as string;
      expect(link).toMatch(/\?text=TESTBIZ$/);
      return { phone: link.replace('https://wa.me/', '').split('?')[0], rec };
    },
  },
];

describe.each(routes)('$name link', ({ call }) => {
  it('staging: NG business → the designated number, not the competing ones listed first', async () => {
    setStaging(true);
    expect((await call(allShared())).phone).toBe('12404712139');
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → never a competing number (owner phone, as before with no channel)', async (_l, rows) => {
    setStaging(true);
    expect((await call(rows)).phone).toBe(OWNER_PHONE);
  });
  it('production: same query chain and same pick as before', async () => {
    setStaging(false);
    const { phone, rec } = await call(allShared());
    expect(phone).toBe('2348000000000'); // first active shared row, exactly as before
    expect(channelChains(rec)).toContainEqual(ORIGINAL_SHARED_LINK_CHAIN);
    expect(channelChains(rec).some(c => c.some(x => x[0] === 'eq' && x[1] === 'id' && x[2] === DESIGNATED_ID))).toBe(false);
  });
});

// ── Launch regions ──────────────────────────────────────────────────

describe('GET /api/launch/regions', () => {
  const countries = [
    { code: 'US', name: 'United States', flag: '🇺🇸', is_active: true },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬', is_active: true },
  ];
  async function regions(rows: Row[]) {
    const { GET } = await import('@/app/api/launch/regions/route');
    const rec = useDb({ whatsapp_channels: rows, countries });
    return { body: await (await GET()).json(), rec };
  }

  it('staging: only the designated number, under its own country', async () => {
    setStaging(true);
    expect((await regions(allShared())).body.regions).toEqual([{ phone: '12404712139', code: 'US', name: 'United States', flag: '🇺🇸' }]);
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → no regions', async (_l, rows) => {
    setStaging(true);
    expect((await regions(rows)).body.regions).toEqual([]);
  });
  it('production: unchanged (first active shared number per country)', async () => {
    setStaging(false);
    const { body, rec } = await regions(allShared());
    expect(body.regions).toEqual([
      { phone: '2348000000000', code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
      { phone: '12025550100', code: 'US', name: 'United States', flag: '🇺🇸' },
    ]);
    expect(channelChains(rec)).toEqual([[
      ['select', 'phone_number, country_code'], ['eq', 'channel_type', 'shared'], ['eq', 'is_active', true], ['order', 'country_code'],
    ]]);
  });
});

// ── OTP send ────────────────────────────────────────────────────────

describe('POST /api/auth/otp/send primary channel', () => {
  async function send(rows: Row[]) {
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const rec = useDb({ whatsapp_channels: rows, otp_delivery_attempts: [] });
    const res = await POST(req('/api/auth/otp/send', { method: 'POST', body: JSON.stringify({ phone: '+2348012345678' }) }));
    return { status: res.status, rec };
  }

  it('staging: sends from the designated number with its token', async () => {
    setStaging(true);
    expect((await send(allShared())).status).toBe(200);
    expect(H.cloudConfigs).toEqual([{ phoneNumberId: 'pnid-staging', accessToken: 'tok-staging' }]);
  });
  it.each(BROKEN_DESIGNATED)('staging: designated row %s → primary refuses, no competing number used', async (_l, rows) => {
    setStaging(true);
    expect((await send(rows)).status).toBe(503);
    expect(H.cloudConfigs).toEqual([]);
  });
  it('staging: designated row on a non-Meta provider → primary refuses', async () => {
    setStaging(true);
    expect((await send([localNg(), otherUs(), designated({ provider: 'other' })])).status).toBe(503);
    expect(H.cloudConfigs).toEqual([]);
  });
  it('production: same query chain and same pick as before', async () => {
    setStaging(false);
    const { status, rec } = await send(allShared());
    expect(status).toBe(200);
    expect(H.cloudConfigs).toEqual([{ phoneNumberId: 'pnid-ng', accessToken: 'tok-ng' }]);
    expect(channelChains(rec)).toEqual([[
      ['select', 'phone_number_id, meta_access_token'], ['eq', 'provider', 'meta_cloud'], ['eq', 'is_active', true],
      ['eq', 'channel_type', 'shared'], ['limit', 1], ['maybeSingle'],
    ]]);
  });
});
