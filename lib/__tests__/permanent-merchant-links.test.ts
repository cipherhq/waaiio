/**
 * Permanent merchant links — handler tests with mocked Supabase.
 *
 * Calls actual GET handlers, asserts HTTP status, headers, redirect targets,
 * recorded eq/select filters for tenant isolation, and channel projection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { buildMerchantLink, buildMerchantCampaignLink, canonicalPublicOrigin } from '@/lib/url';

// ── Fixture data ──
const BIZ_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_BIZ = '770e8400-e29b-41d4-a716-446655440099';
const CAMP_ID = '660e8400-e29b-41d4-a716-446655440001';
const CH_SHARED = 'ch-shared-001';
const CH_DED = 'ch-ded-001';
const PHONE = '+12025551234';
const PHONE2 = '+447911999888';

function mkBusiness(channelId: string, overrides?: Partial<{
  id: string; status: string; messaging_suspended: boolean; bot_code: string | null;
  assigned_channel_id: string | null; whatsapp_channel_id: string | null;
}>) {
  return {
    id: overrides?.id ?? BIZ_ID,
    country_code: 'US',
    status: overrides?.status ?? 'active',
    messaging_suspended: overrides?.messaging_suspended ?? false,
    bot_code: overrides !== undefined && 'bot_code' in overrides ? overrides.bot_code : 'TESTBOT',
    assigned_channel_id: overrides?.assigned_channel_id !== undefined ? overrides.assigned_channel_id : channelId,
    whatsapp_channel_id: overrides?.whatsapp_channel_id ?? null,
  };
}

const sharedCh = (phone = PHONE) => ({
  id: CH_SHARED, channel_type: 'shared', is_active: true,
  connection_status: 'active', country_code: 'US', business_id: null, phone_number: phone,
});
const dedCh = (phone = PHONE) => ({
  id: CH_DED, channel_type: 'dedicated', is_active: true,
  connection_status: 'active', country_code: 'US', business_id: BIZ_ID, phone_number: phone,
});
const activeCampaign = (kw = 'PROMO50') => ({
  id: CAMP_ID, keyword: kw, is_active: true, starts_at: null, ends_at: null,
});

// ── Supabase mock with recorded eq/select calls ──
type QR = { data: unknown; error: null } | { data: null; error: { message: string } };
let mockResults: Record<string, QR>;
let selectCalls: string[];
let eqCalls: Array<{ table: string; col: string; val: unknown }>;

function buildChain(table: string) {
  const self: Record<string, (...a: unknown[]) => typeof self> = {} as never;
  for (const m of ['in', 'is', 'not', 'order', 'limit', 'range']) self[m] = () => self;
  self.select = (...args: unknown[]) => { selectCalls.push(`${table}:${args[0]}`); return self; };
  self.eq = (...args: unknown[]) => { eqCalls.push({ table, col: args[0] as string, val: args[1] }); return self; };
  self.maybeSingle = () => Promise.resolve(mockResults[table] ?? { data: null, error: null }) as never;
  self.single = self.maybeSingle;
  (self as Record<string, unknown>).then = (r: (v: unknown) => void) => Promise.resolve(mockResults[table] ?? { data: null, error: null }).then(r);
  return self;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => buildChain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: (_r: unknown, p: string) => `${p}:test`,
}));

const { GET: baseGET } = await import('@/app/m/[businessId]/route');
const { GET: actionGET } = await import('@/app/m/[businessId]/[action]/route');
const { GET: campaignGET } = await import('@/app/m/[businessId]/campaign/[campaignId]/route');

function req(path: string) { return new NextRequest(new URL(path, 'https://www.waaiio.com')); }
function ctx<T>(p: T) { return { params: Promise.resolve(p) }; }
function assertNoStore(r: Response) { expect(r.headers.get('cache-control')).toContain('no-store'); }
function eqsFor(table: string) { return eqCalls.filter(c => c.table === table); }

beforeEach(() => { mockResults = {}; selectCalls = []; eqCalls = []; vi.clearAllMocks(); });

// ══════════════════════════════════════════════════════════════
// URL helpers
// ══════════════════════════════════════════════════════════════

describe('URL helpers', () => {
  it('buildMerchantLink base', () => {
    expect(buildMerchantLink(BIZ_ID)).toBe(`https://www.waaiio.com/m/${BIZ_ID}`);
  });
  it('buildMerchantLink with action', () => {
    expect(buildMerchantLink(BIZ_ID, 'order')).toBe(`https://www.waaiio.com/m/${BIZ_ID}/order`);
  });
  it('buildMerchantLink generic = base', () => {
    expect(buildMerchantLink(BIZ_ID, 'generic')).toBe(`https://www.waaiio.com/m/${BIZ_ID}`);
  });
  it('buildMerchantCampaignLink', () => {
    expect(buildMerchantCampaignLink(BIZ_ID, CAMP_ID)).toContain(`/m/${BIZ_ID}/campaign/${CAMP_ID}`);
  });
  it('canonicalPublicOrigin', () => {
    expect(canonicalPublicOrigin()).toBe('https://www.waaiio.com');
  });
});

// ══════════════════════════════════════════════════════════════
// Base route /m/{businessId}
// ══════════════════════════════════════════════════════════════

describe('GET /m/[businessId]', () => {
  it('dedicated: redirects to plain wa.me (no ?text)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(302); assertNoStore(res);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234');
  });

  it('shared: redirects with ?text=bot_code', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(), error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(302); assertNoStore(res);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=TESTBOT');
  });

  it('same permanent URL redirects to current channel phone (dynamic destination)', async () => {
    // First assignment: phone A on shared
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(PHONE), error: null } };
    const res1 = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res1.headers.get('location')).toContain('12025551234');

    // Channel re-assigned to phone B — same permanent URL, different destination
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(PHONE2), error: null } };
    const res2 = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res2.headers.get('location')).toContain('447911999888');
    assertNoStore(res2); // no-store ensures browser fetches fresh redirect
  });

  it('same permanent URL redirects to current dedicated channel (re-assignment)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(PHONE), error: null } };
    const res1 = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res1.headers.get('location')).toBe('https://wa.me/12025551234');

    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(PHONE2), error: null } };
    const res2 = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res2.headers.get('location')).toBe('https://wa.me/447911999888');
    assertNoStore(res2);
  });

  it('filters business by exact id', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    const bizEqs = eqsFor('businesses');
    expect(bizEqs).toContainEqual({ table: 'businesses', col: 'id', val: BIZ_ID });
  });

  it('filters channel by exact assigned_channel_id', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    const chEqs = eqsFor('whatsapp_channels');
    expect(chEqs).toContainEqual({ table: 'whatsapp_channels', col: 'id', val: CH_DED });
  });

  it('400 invalid UUID', async () => {
    const res = await baseGET(req('/m/not-uuid'), ctx({ businessId: 'not-uuid' }));
    expect(res.status).toBe(400); assertNoStore(res);
  });

  it('404 nonexistent business', async () => {
    mockResults = { businesses: { data: null, error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(404); assertNoStore(res);
  });

  it('503 inactive business', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED, { status: 'pending' }), error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
  });

  it('503 messaging suspended', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED, { messaging_suspended: true }), error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
  });

  it('503 no channel assigned', async () => {
    mockResults = { businesses: { data: mkBusiness('', { assigned_channel_id: null }), error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
  });

  it('503 channel inactive', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: { ...dedCh(), is_active: false }, error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
  });

  it('503 shared country mismatch', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: { ...sharedCh(), country_code: 'GB' }, error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
  });

  it('503 shared missing bot_code (explicit null)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED, { bot_code: null }), error: null }, whatsapp_channels: { data: sharedCh(), error: null } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503); assertNoStore(res);
  });

  it('503 dedicated channel owned by wrong business', async () => {
    mockResults = {
      businesses: { data: mkBusiness(CH_DED), error: null },
      whatsapp_channels: { data: { ...dedCh(), business_id: OTHER_BIZ }, error: null },
    };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503); // isAssignedWhatsAppChannelReady fails: channel.business_id !== business.id
  });

  it('503 shared channel wrongly owned (business_id not null)', async () => {
    mockResults = {
      businesses: { data: mkBusiness(CH_SHARED), error: null },
      whatsapp_channels: { data: { ...sharedCh(), business_id: OTHER_BIZ }, error: null },
    };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503); // shared requires business_id === null
  });

  it('500 channel DB error', async () => {
    mockResults = {
      businesses: { data: mkBusiness(CH_DED), error: null },
      whatsapp_channels: { data: null, error: { message: 'channel db fail' } },
    };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(500); assertNoStore(res);
  });

  it('400 rejects any query parameters', async () => {
    const res = await baseGET(req(`/m/${BIZ_ID}?redirect=evil`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(400);
  });

  it('500 on business DB error', async () => {
    mockResults = { businesses: { data: null, error: { message: 'db' } } };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(500); assertNoStore(res);
  });

  it('channel select projection is credential-free', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    const chSelect = selectCalls.find(s => s.startsWith('whatsapp_channels:'));
    expect(chSelect).toBeDefined();
    expect(chSelect).not.toContain('access_token');
    expect(chSelect).not.toContain('api_key');
    expect(chSelect).not.toContain('waba_id');
    // Must include the fields needed for readiness checks
    expect(chSelect).toContain('channel_type');
    expect(chSelect).toContain('is_active');
    expect(chSelect).toContain('connection_status');
    expect(chSelect).toContain('phone_number');
  });

  it('business select projection is credential-free', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    const bizSelect = selectCalls.find(s => s.startsWith('businesses:'));
    expect(bizSelect).toBeDefined();
    expect(bizSelect).not.toContain('access_token');
    expect(bizSelect).not.toContain('stripe_');
    expect(bizSelect).not.toContain('paystack_');
  });
});

// ══════════════════════════════════════════════════════════════
// Action route /m/{businessId}/{action}
// ══════════════════════════════════════════════════════════════

describe('GET /m/[businessId]/[action]', () => {
  it('shared + order → bot_code:ordering suffix', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(), error: null } };
    const res = await actionGET(req(`/m/${BIZ_ID}/order`), ctx({ businessId: BIZ_ID, action: 'order' }));
    expect(res.status).toBe(302); assertNoStore(res);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=TESTBOT%3Aordering');
  });

  it('shared + queue → bot_code:queue suffix', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(), error: null } };
    const res = await actionGET(req(`/m/${BIZ_ID}/queue`), ctx({ businessId: BIZ_ID, action: 'queue' }));
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=TESTBOT%3Aqueue');
  });

  it('shared + generic → bot_code only (no suffix)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(), error: null } };
    const res = await actionGET(req(`/m/${BIZ_ID}/generic`), ctx({ businessId: BIZ_ID, action: 'generic' }));
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=TESTBOT');
  });

  it('dedicated + book → ?text=Hi', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    const res = await actionGET(req(`/m/${BIZ_ID}/book`), ctx({ businessId: BIZ_ID, action: 'book' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=Hi');
  });

  it('dedicated + generic → plain wa.me (verifiedLink)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    const res = await actionGET(req(`/m/${BIZ_ID}/generic`), ctx({ businessId: BIZ_ID, action: 'generic' }));
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234');
  });

  it('attendance → /checkin/{uuid} (not wa.me)', async () => {
    const res = await actionGET(req(`/m/${BIZ_ID}/attendance`), ctx({ businessId: BIZ_ID, action: 'attendance' }));
    expect(res.status).toBe(302); assertNoStore(res);
    expect(res.headers.get('location')).toContain(`/checkin/${BIZ_ID}`);
    expect(res.headers.get('location')).not.toContain('wa.me');
  });

  it('attendance rejects invalid UUID', async () => {
    const res = await actionGET(req('/m/bad/attendance'), ctx({ businessId: 'bad', action: 'attendance' }));
    expect(res.status).toBe(400);
  });

  it('attendance rejects query params', async () => {
    const res = await actionGET(req(`/m/${BIZ_ID}/attendance?x=1`), ctx({ businessId: BIZ_ID, action: 'attendance' }));
    expect(res.status).toBe(400);
  });

  it('400 unknown action', async () => {
    const res = await actionGET(req(`/m/${BIZ_ID}/hack`), ctx({ businessId: BIZ_ID, action: 'hack' }));
    expect(res.status).toBe(400);
  });

  it('400 rejects query params on WhatsApp actions', async () => {
    const res = await actionGET(req(`/m/${BIZ_ID}/book?to=evil`), ctx({ businessId: BIZ_ID, action: 'book' }));
    expect(res.status).toBe(400);
  });

  it('503 shared missing bot_code on action', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED, { bot_code: null }), error: null }, whatsapp_channels: { data: sharedCh(), error: null } };
    const res = await actionGET(req(`/m/${BIZ_ID}/pay`), ctx({ businessId: BIZ_ID, action: 'pay' }));
    expect(res.status).toBe(503);
  });

  it('all valid actions accepted', async () => {
    for (const a of ['book', 'order', 'pay', 'ticket', 'donate', 'queue', 'waitlist', 'give', 'chat', 'generic']) {
      mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
      const res = await actionGET(req(`/m/${BIZ_ID}/${a}`), ctx({ businessId: BIZ_ID, action: a }));
      expect(res.status).toBe(302);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Campaign route /m/{businessId}/campaign/{campaignId}
// ══════════════════════════════════════════════════════════════

describe('GET /m/[businessId]/campaign/[campaignId]', () => {
  it('dedicated: keyword prefill', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: activeCampaign(), error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(302); assertNoStore(res);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=PROMO50');
  });

  it('shared: keyword prefill (same as dedicated — original getWaLink)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_SHARED), error: null }, whatsapp_channels: { data: sharedCh(), error: null }, keyword_campaigns: { data: activeCampaign(), error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=PROMO50');
  });

  it('campaign query filters by both campaign_id and business_id (tenant isolation)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: activeCampaign(), error: null } };
    await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    const campEqs = eqsFor('keyword_campaigns');
    expect(campEqs).toContainEqual({ table: 'keyword_campaigns', col: 'id', val: CAMP_ID });
    expect(campEqs).toContainEqual({ table: 'keyword_campaigns', col: 'business_id', val: BIZ_ID });
  });

  it('404 when campaign belongs to different business (mock returns null for wrong tenant)', async () => {
    // Simulate: campaign exists in DB but business_id doesn't match → .eq('business_id', BIZ_ID) returns null
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: null, error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(404); assertNoStore(res);
  });

  it('503 inactive campaign', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: { ...activeCampaign(), is_active: false }, error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(503);
  });

  it('503 future start date', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: { ...activeCampaign(), starts_at: future }, error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(503);
  });

  it('503 past end date', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: { ...activeCampaign(), ends_at: past }, error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(503);
  });

  it('503 invalid date (NaN parse)', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: { ...activeCampaign(), starts_at: 'not-a-date' }, error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(503);
  });

  it('503 empty keyword', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: activeCampaign(''), error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(503);
  });

  it('dedicated campaign with null bot_code: keyword prefill succeeds (bot_code not needed)', async () => {
    // Campaign uses keyword-only prefill — bot_code is irrelevant for dedicated channels
    mockResults = { businesses: { data: mkBusiness(CH_DED, { bot_code: null }), error: null }, whatsapp_channels: { data: dedCh(), error: null }, keyword_campaigns: { data: activeCampaign(), error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=PROMO50');
  });

  it('shared campaign with null bot_code: keyword prefill succeeds (readiness does not require bot_code)', async () => {
    // isAssignedWhatsAppChannelReady checks channel state, not bot_code.
    // Campaign route uses result.digits with keyword — no bot_code prerequisite.
    mockResults = { businesses: { data: mkBusiness(CH_SHARED, { bot_code: null }), error: null }, whatsapp_channels: { data: sharedCh(), error: null }, keyword_campaigns: { data: activeCampaign(), error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(302); assertNoStore(res);
    expect(res.headers.get('location')).toBe('https://wa.me/12025551234?text=PROMO50');
  });

  it('400 invalid campaign UUID', async () => {
    mockResults = { businesses: { data: mkBusiness(CH_DED), error: null }, whatsapp_channels: { data: dedCh(), error: null } };
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/bad`), ctx({ businessId: BIZ_ID, campaignId: 'bad' }));
    expect(res.status).toBe(400);
  });

  it('400 rejects query params', async () => {
    const res = await campaignGET(req(`/m/${BIZ_ID}/campaign/${CAMP_ID}?x=1`), ctx({ businessId: BIZ_ID, campaignId: CAMP_ID }));
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// Rate limiting
// ══════════════════════════════════════════════════════════════

describe('Rate limiting', () => {
  it('429 with no-store when rate-limited', async () => {
    const { rateLimitResponseAsync } = await import('@/lib/rate-limit');
    vi.mocked(rateLimitResponseAsync).mockResolvedValueOnce(new Response('Too many', { status: 429 }));
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(429); assertNoStore(res);
  });
});
