/**
 * Customer updates opt-in (Owner decision 2026-11-06, Option A).
 *
 * Behaviour on an in-memory database (filters really applied, unknown filters
 * throw): the offer is shown once, a tap records consent for that business and
 * Waaiio with source and timestamp, it is not shown again, opt-outs are
 * respected and consent never crosses businesses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildUpdatesOptInRow,
  handleUpdatesOptInTap,
  recordUpdatesOptIn,
  parseUpdatesOptInPostback,
  shouldOfferUpdatesOptIn,
  updatesOptInPostback,
  updatesOptInRowFor,
  UPDATES_OPTIN_POLICY_VERSION,
} from '@/lib/bot/customer-updates-optin';
import { _FLOW_COPY_FOR_TESTS } from '@/lib/bot/flows/flow-localization';
import { isBusinessEditableKey } from '@/lib/bot/translations';

const BIZ_A = '11111111-1111-4111-8111-111111111111';
const BIZ_B = '22222222-2222-4222-8222-222222222222';
const BIZ_WL = '33333333-3333-4333-8333-333333333333';
const PHONE = '2348012345678'; // as Meta sends it
const E164 = `+${PHONE}`;

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}): MemoryDb {
  return createMemoryDb({
    businesses: [
      { id: BIZ_A, name: 'Mama Put Kitchen', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG' },
      { id: BIZ_B, name: 'Lekki Barbers', subscription_tier: 'free', is_whitelabel: false, country_code: 'NG' },
      { id: BIZ_WL, name: 'Private Label Spa', subscription_tier: 'growth', is_whitelabel: true, country_code: 'GH' },
    ],
    // The customer has chatted with A and the white-label spa, never with B.
    bot_sessions: [
      { id: 's-a', business_id: BIZ_A, whatsapp_number: PHONE, session_data: { _detected_language: 'en' }, updated_at: '2026-11-06T10:00:00Z' },
      { id: 's-wl', business_id: BIZ_WL, whatsapp_number: PHONE, session_data: {}, updated_at: '2026-11-06T10:00:00Z' },
    ],
    customer_profiles: [],
    // Waaiio's shared Nigerian number (launch delivery only sends from shared numbers).
    whatsapp_channels: [
      { id: 'ch-ng', phone_number_id: 'pnid-shared-ng', channel_type: 'shared', is_active: true, country_code: 'NG', created_at: '2026-01-01T00:00:00Z' },
      { id: 'ch-a', phone_number_id: 'pnid-dedicated-a', channel_type: 'dedicated', is_active: true, country_code: 'NG', created_at: '2026-01-01T00:00:00Z' },
    ],
    customer_consents: [],
    messaging_opt_outs: [],
    launch_subscribers: [],
    ...extra,
  });
}

function tap(db: MemoryDb, businessId: string, opts: { source?: 'menu' | 'welcome'; preResolvedBusinessId?: string; destinationPhone?: string; messageType?: string } = {}) {
  const replies: string[] = [];
  const handled = handleUpdatesOptInTap(db as any, {
    from: PHONE,
    text: updatesOptInPostback(opts.source ?? 'menu', businessId),
    messageType: opts.messageType ?? 'list',
    preResolvedBusinessId: opts.preResolvedBusinessId,
    destinationPhone: opts.destinationPhone ?? 'pnid-shared-ng',
    sendReply: async (_to, text) => { replies.push(text); },
  });
  return handled.then(h => ({ handled: h, replies }));
}

const consentsFor = (db: MemoryDb, businessId: string) =>
  (db.tables.customer_consents || []).filter(r => r.business_id === businessId);

beforeEach(() => { vi.clearAllMocks(); });

describe('opt-in row wording', () => {
  it('names the business and Waaiio, fits WhatsApp limits, and carries the business in its id', () => {
    const row = buildUpdatesOptInRow('en', 'Mama Put Kitchen', true, 'menu', BIZ_A);
    expect(row.title).toBe('🎁 Get first dibs');
    expect(row.title.length).toBeLessThanOrEqual(24);
    expect(row.description).toBe('Offers & updates from Mama Put Kitchen and Waaiio. Stop anytime.');
    expect(row.description.length).toBeLessThanOrEqual(72);
    expect(row.postbackText).toBe(`updates_yes:menu:${BIZ_A}`);
  });

  it("short business name → the Owner's exact wording A", () => {
    const row = buildUpdatesOptInRow('en', "Kemi's Spa", true, 'menu', BIZ_A);
    expect(row.description).toBe("Offers, reminders & updates from Kemi's Spa and Waaiio. Stop anytime.");
  });

  it('a very long business name is shortened, never the parties or the way out', () => {
    const name = 'The Extremely Long Named Restaurant And Lounge Of Victoria Island';
    for (const lang of Object.keys(_FLOW_COPY_FOR_TESTS)) {
      const row = buildUpdatesOptInRow(lang, name, true, 'menu', BIZ_A);
      expect(row.description.length, lang).toBeLessThanOrEqual(72);
      expect(row.description, lang).toContain('Waaiio');
      expect(row.description, lang).toContain('…');
    }
  });

  it('white-label businesses: the row names only the business', () => {
    const row = buildUpdatesOptInRow('en', 'Private Label Spa', false, 'menu', BIZ_WL);
    expect(row.description).toBe('Offers, reminders & updates from Private Label Spa. Stop anytime.');
    expect(row.description).not.toContain('Waaiio');
  });

  it('every locale has every opt-in key, the title fits 24 chars and leaves room for a 20-char name', () => {
    const keys = ['updates.optin_title', 'updates.optin_desc', 'updates.optin_desc_business', 'updates.optin_desc_short',
      'updates.optin_desc_business_short', 'updates.thanks',
      'updates.thanks_business', 'updates.already', 'updates.opted_out', 'updates.save_failed', 'updates.expired'];
    for (const [lang, copy] of Object.entries(_FLOW_COPY_FOR_TESTS)) {
      for (const k of keys) expect(copy[k], `${lang}.${k}`).toBeTruthy();
      expect(copy['updates.optin_title'].length, lang).toBeLessThanOrEqual(24);
      expect(copy['updates.optin_desc_short'].replace('{businessName}', 'x'.repeat(20)).length, lang).toBeLessThanOrEqual(72);
      expect(copy['updates.optin_desc'], lang).toContain('Waaiio');
      expect(copy['updates.optin_desc_short'], lang).toContain('Waaiio');
      expect(copy['updates.optin_desc_business'], lang).not.toContain('Waaiio');
      expect(copy['updates.optin_desc_business_short'], lang).not.toContain('Waaiio');
      expect(copy['updates.thanks'], lang).toContain('Waaiio');
      expect(copy['updates.thanks'], lang).toContain('STOP');
      expect(copy['updates.thanks_business'], lang).not.toContain('Waaiio');
      expect(copy['updates.opted_out'], lang).toContain('START');
    }
  });

  it('every wording, full and short, mentions updates or news, not only offers (one yes also covers service messages)', () => {
    // The word for updates/news/info in each locale's lines.
    const updatesWord: Record<string, RegExp> = {
      en: /updates/, pcm: /updates/, yo: /ìròyìn/, ig: /ozi/, ha: /labarai/, tw: /nsɛm/, fr: /infos/, es: /novedades/,
    };
    for (const [lang, copy] of Object.entries(_FLOW_COPY_FOR_TESTS)) {
      for (const k of ['updates.optin_desc', 'updates.optin_desc_short', 'updates.optin_desc_business', 'updates.optin_desc_business_short']) {
        expect(copy[k], `${lang}.${k}`).toMatch(updatesWord[lang]);
      }
    }
  });

  it('businesses cannot override the consent wording', () => {
    for (const k of ['updates.optin_title', 'updates.optin_desc', 'updates.thanks']) {
      expect(isBusinessEditableKey(k)).toBe(false);
    }
  });

  it('only exact opt-in postbacks are recognised', () => {
    expect(parseUpdatesOptInPostback(`updates_yes:menu:${BIZ_A}`)).toEqual({ source: 'menu', businessId: BIZ_A });
    expect(parseUpdatesOptInPostback(`updates_yes:welcome:${BIZ_A}`)).toEqual({ source: 'welcome', businessId: BIZ_A });
    for (const t of ['yes', 'updates_yes', `updates_yes:menu:${BIZ_A}x`, `updates_yes:other:${BIZ_A}`, 'updates_yes:menu:not-a-uuid']) {
      expect(parseUpdatesOptInPostback(t), t).toBeNull();
    }
  });
});

describe('shown once, recorded, not shown again', () => {
  it('fresh customer → offered; tap records business + Waaiio with source and timestamp; then not offered', async () => {
    const db = seed();
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(true);

    const { handled, replies } = await tap(db, BIZ_A);
    expect(handled).toBe(true);

    // One yes covers marketing AND utility (Owner decision 2026-11-06): two rows, same evidence and time.
    const rows = consentsFor(db, BIZ_A);
    expect(rows.map(r => r.purpose).sort()).toEqual(['marketing', 'utility']);
    for (const r of rows) {
      expect(r).toMatchObject({
        business_id: BIZ_A, phone: E164, channel: 'whatsapp', status: 'granted',
        source: 'whatsapp', evidence_reference: 'bot_next_steps_menu',
        policy_version: `${UPDATES_OPTIN_POLICY_VERSION}:business+waaiio`,
      });
      expect(Number.isNaN(Date.parse(String(r.granted_at)))).toBe(false);
    }
    expect(rows[0].granted_at).toBe(rows[1].granted_at);

    expect(db.tables.launch_subscribers).toHaveLength(1);
    expect(db.tables.launch_subscribers[0]).toMatchObject({
      wa_number: PHONE, // exactly as Meta sends it: the STOP handler looks it up this way
      market: 'NG', receiving_number: 'pnid-shared-ng', signup_source: 'bot_next_steps_menu', opt_in_status: 'active',
    });

    expect(replies).toEqual([
      "🎉 You're in! Mama Put Kitchen and Waaiio will send you offers and updates. Reply STOP anytime to unsubscribe.",
    ]);

    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
  });

  it('a second tap does not add a duplicate consent row', async () => {
    const db = seed();
    await tap(db, BIZ_A);
    const { replies } = await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A)).toHaveLength(2); // marketing + utility
    expect(db.tables.launch_subscribers).toHaveLength(1);
    expect(replies[0]).toContain('already signed up');
  });

  it('welcome tap is recorded with the welcome source', async () => {
    const db = seed();
    await tap(db, BIZ_A, { source: 'welcome' });
    expect(consentsFor(db, BIZ_A)[0].evidence_reference).toBe('bot_welcome_menu');
    expect(db.tables.launch_subscribers[0].signup_source).toBe('bot_welcome_menu');
  });

  it('an existing Waaiio subscriber is kept, not duplicated', async () => {
    const db = seed({ launch_subscribers: [{ id: 'l1', wa_number: PHONE, market: 'NG', receiving_number: 'x', signup_source: 'direct', opt_in_status: 'active' }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(true);
    const { replies } = await tap(db, BIZ_A);
    expect(db.tables.launch_subscribers).toHaveLength(1);
    expect(db.tables.launch_subscribers[0].signup_source).toBe('direct');
    expect(replies[0]).toContain('and Waaiio');
  });

  it('an unverified web-form tick (pending) does not hide the offer', async () => {
    const db = seed({ customer_consents: [{ id: 'c0', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'marketing', status: 'pending', created_at: '2026-11-01T00:00:00Z' }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(true);
  });
});

describe('opt-outs are respected and never re-asked', () => {
  it('active STOP for the business → not offered; a tap records nothing and says how to come back', async () => {
    const db = seed({ messaging_opt_outs: [{ id: 'o1', phone: E164, business_id: BIZ_A, channel: 'whatsapp', resubscribed_at: null }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
    const { replies } = await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A)).toHaveLength(0);
    expect(db.tables.launch_subscribers).toHaveLength(0);
    expect(replies[0]).toContain('START');
  });

  it('someone who once said STOP (even if later resubscribed) is never shown the offer again', async () => {
    const db = seed({ messaging_opt_outs: [{ id: 'o1', phone: E164, business_id: BIZ_A, channel: 'whatsapp', resubscribed_at: '2026-11-02T00:00:00Z' }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
  });

  it('a global opt-out (all businesses) hides the offer everywhere', async () => {
    const db = seed({ messaging_opt_outs: [{ id: 'o1', phone: E164, business_id: null, channel: 'whatsapp', resubscribed_at: null }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_B, true)).toBe(false);
  });

  // Owner decision 2026-11-06: latest row wins. An earlier "No thanks" (revoked)
  // still hides the offer, but a newer explicit Yes tap records both purposes.
  it('latest consent revoked → not offered, but a newer explicit tap grants marketing + utility', async () => {
    const db = seed({ customer_consents: [
      { id: 'c1', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'marketing', status: 'granted', created_at: '2026-10-01T00:00:00Z' },
      { id: 'c2', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'marketing', status: 'revoked', created_at: '2026-10-02T00:00:00Z' },
    ] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
    const { replies } = await tap(db, BIZ_A);
    const added = consentsFor(db, BIZ_A).filter(r => r.id !== 'c1' && r.id !== 'c2');
    expect(added.map(r => r.purpose).sort()).toEqual(['marketing', 'utility']);
    expect(added.every(r => r.status === 'granted')).toBe(true);
    expect(replies[0]).toContain("You're in!");
    // The newest marketing row is now granted, so the business can message again.
    expect(await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: BIZ_A, source: 'menu' })).toMatchObject({ status: 'already' });
  });

  it('latest consent revoked plus an active STOP → the tap is still blocked', async () => {
    const db = seed({
      customer_consents: [
        { id: 'c2', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'marketing', status: 'revoked', created_at: '2026-10-02T00:00:00Z' },
      ],
      messaging_opt_outs: [{ id: 'o1', phone: E164, business_id: BIZ_A, channel: 'whatsapp', resubscribed_at: null }],
    });
    const { replies } = await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A)).toHaveLength(1); // only the seeded row
    expect(replies[0]).toContain('START');
  });

  it('unsubscribed from Waaiio updates → not offered; a stale tap records the business only and never re-activates Waaiio', async () => {
    const db = seed({ launch_subscribers: [{ id: 'l1', wa_number: PHONE, market: 'NG', receiving_number: 'x', signup_source: 'direct', opt_in_status: 'opted_out' }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
    const { replies } = await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A)).toHaveLength(2); // marketing + utility
    expect(db.tables.launch_subscribers).toHaveLength(1);
    expect(db.tables.launch_subscribers[0].opt_in_status).toBe('opted_out');
    expect(replies[0]).not.toContain('Waaiio');
  });
});

describe('no cross-business consent', () => {
  it('consent for business A does not hide or satisfy the offer for business B', async () => {
    const db = seed({ bot_sessions: [
      { id: 's-a', business_id: BIZ_A, whatsapp_number: PHONE, session_data: {}, updated_at: '2026-11-06T10:00:00Z' },
      { id: 's-b', business_id: BIZ_B, whatsapp_number: PHONE, session_data: {}, updated_at: '2026-11-06T10:00:00Z' },
    ] });
    await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A)).toHaveLength(2); // marketing + utility
    expect(consentsFor(db, BIZ_B)).toHaveLength(0);
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_B, true)).toBe(true);
  });

  it('a tap naming a business this number never dealt with records nothing', async () => {
    const db = seed();
    const { handled, replies } = await tap(db, BIZ_B);
    expect(handled).toBe(true);
    expect(db.tables.customer_consents).toHaveLength(0);
    expect(db.tables.launch_subscribers).toHaveLength(0);
    expect(replies[0]).toContain('no longer available');
  });

  it("on a business's own number, a tap naming another business records nothing", async () => {
    const db = seed();
    await tap(db, BIZ_A, { preResolvedBusinessId: BIZ_WL });
    expect(db.tables.customer_consents).toHaveLength(0);
    expect(db.tables.launch_subscribers).toHaveLength(0);
  });

  it('a customer profile (no chat session) also counts as prior contact', async () => {
    const db = seed({ bot_sessions: [], customer_profiles: [{ id: 'cp', business_id: BIZ_A, phone: E164 }] });
    await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A)).toHaveLength(2); // marketing + utility
  });
});

describe('white-label businesses', () => {
  it('records consent for the business only and never joins Waaiio updates', async () => {
    const db = seed();
    const row = await updatesOptInRowFor(db as any, {
      phone: PHONE, lang: 'en', source: 'menu',
      business: { id: BIZ_WL, name: 'Private Label Spa', subscription_tier: 'growth', is_whitelabel: true },
    });
    expect(row?.description).not.toContain('Waaiio');
    const { replies } = await tap(db, BIZ_WL);
    expect(consentsFor(db, BIZ_WL)[0].policy_version).toBe(`${UPDATES_OPTIN_POLICY_VERSION}:business`);
    expect(db.tables.launch_subscribers).toHaveLength(0);
    expect(replies[0]).toBe("🎉 You're in! Private Label Spa will send you offers and updates here. Reply STOP anytime to unsubscribe.");
  });

  it('a Waaiio opt-out does not block a white-label business offer', async () => {
    const db = seed({ launch_subscribers: [{ id: 'l1', wa_number: PHONE, opt_in_status: 'opted_out' }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_WL, false)).toBe(true);
  });
});

describe('reviewer follow-ups', () => {
  it("tap on the business's own number → Waaiio list uses Waaiio's shared number for that country, so Waaiio can deliver", async () => {
    const db = seed();
    await tap(db, BIZ_A, { preResolvedBusinessId: BIZ_A, destinationPhone: 'pnid-dedicated-a' });
    expect(db.tables.launch_subscribers[0].receiving_number).toBe('pnid-shared-ng');
  });

  it('no shared Waaiio number for the market → business consent only, and the reply says so', async () => {
    const db = seed({ whatsapp_channels: [] });
    const { replies } = await tap(db, BIZ_A, { destinationPhone: 'pnid-unknown' });
    expect(consentsFor(db, BIZ_A)).toHaveLength(2); // marketing + utility
    expect(db.tables.launch_subscribers).toHaveLength(0);
    expect(replies[0]).not.toContain('Waaiio');
  });

  it('typed text that looks like the postback is not consent', async () => {
    const db = seed();
    const { handled } = await tap(db, BIZ_A, { messageType: 'text' });
    expect(handled).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it('no prior contact with the business → offer not shown (it could not be accepted)', async () => {
    expect(await shouldOfferUpdatesOptIn(seed() as any, PHONE, BIZ_B, true)).toBe(false);
  });

  it('white-label switch not loaded by the caller → read from the database, never guessed', async () => {
    const db = seed();
    const row = await updatesOptInRowFor(db as any, { phone: PHONE, lang: 'en', source: 'menu', business: { id: BIZ_WL, name: 'Private Label Spa', subscription_tier: 'growth' } });
    expect(row?.description).toBe('Offers, reminders & updates from Private Label Spa. Stop anytime.');
    db.failReads.add('businesses');
    expect(await updatesOptInRowFor(db as any, { phone: PHONE, lang: 'en', source: 'menu', business: { id: BIZ_WL, name: 'Private Label Spa' } })).toBeNull();
  });

  it('welcome: shown only on a first visit (no other chat with this business)', async () => {
    const db = seed();
    const biz = { id: BIZ_A, name: 'Mama Put Kitchen', subscription_tier: 'growth', is_whitelabel: false };
    expect(await updatesOptInRowFor(db as any, { phone: PHONE, lang: 'en', source: 'welcome', business: biz, firstVisitSessionId: 's-a' })).not.toBeNull();
    db.tables.bot_sessions.push({ id: 's-old', business_id: BIZ_A, whatsapp_number: PHONE, session_data: {} });
    expect(await updatesOptInRowFor(db as any, { phone: PHONE, lang: 'en', source: 'welcome', business: biz, firstVisitSessionId: 's-a' })).toBeNull();
  });
});

describe('marketing + utility (Owner decision 2026-11-06)', () => {
  it('an older utility-only consent does not hide the offer; the tap adds both purposes', async () => {
    const db = seed({ customer_consents: [{ id: 'u0', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'utility', status: 'granted', created_at: '2026-11-01T00:00:00Z' }] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(true);
    await tap(db, BIZ_A);
    expect(consentsFor(db, BIZ_A).filter(r => r.id !== 'u0').map(r => r.purpose).sort()).toEqual(['marketing', 'utility']);
  });

  it('a revoked service (utility) consent also hides the offer; a newer explicit tap grants both (latest row wins)', async () => {
    const db = seed({ customer_consents: [
      { id: 'u1', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'utility', status: 'granted', created_at: '2026-10-01T00:00:00Z' },
      { id: 'u2', business_id: BIZ_A, phone: E164, channel: 'whatsapp', purpose: 'utility', status: 'revoked', created_at: '2026-10-02T00:00:00Z' },
    ] });
    expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
    await tap(db, BIZ_A);
    const added = consentsFor(db, BIZ_A).filter(r => r.id !== 'u1' && r.id !== 'u2');
    expect(added.map(r => r.purpose).sort()).toEqual(['marketing', 'utility']);
  });

  it("the shared function itself enforces the business's own-number rule", async () => {
    const db = seed();
    expect(await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: BIZ_A, source: 'menu', channelBusinessId: BIZ_WL }))
      .toEqual({ status: 'channel_mismatch' });
    expect(db.tables.customer_consents).toHaveLength(0);
    expect((await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: BIZ_A, source: 'menu', channelBusinessId: BIZ_A, destinationPhone: 'pnid-dedicated-a' })).status)
      .toBe('granted');
  });

  it('the exported recordUpdatesOptIn reports the outcome without sending anything', async () => {
    const db = seed();
    expect(await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: BIZ_A, source: 'menu', destinationPhone: 'pnid-shared-ng' }))
      .toEqual({ status: 'granted', businessName: 'Mama Put Kitchen', waaiioSubscribed: true });
    expect(await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: BIZ_A, source: 'menu' }))
      .toEqual({ status: 'already', businessName: 'Mama Put Kitchen' });
    expect(await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: BIZ_B, source: 'menu' }))
      .toEqual({ status: 'no_contact' });
    expect(await recordUpdatesOptIn(db as any, { phone: PHONE, businessId: 'not-a-uuid', source: 'menu' }))
      .toEqual({ status: 'unknown_business' });
  });
});

describe('fails closed', () => {
  for (const table of ['customer_consents', 'messaging_opt_outs', 'launch_subscribers']) {
    it(`${table} read error → offer hidden`, async () => {
      const db = seed();
      db.failReads.add(table);
      expect(await shouldOfferUpdatesOptIn(db as any, PHONE, BIZ_A, true)).toBe(false);
    });
  }

  it('opt-out read error on tap → nothing recorded, customer asked to retry', async () => {
    const db = seed();
    db.failReads.add('messaging_opt_outs');
    const { replies } = await tap(db, BIZ_A);
    expect(db.tables.customer_consents).toHaveLength(0);
    expect(replies[0]).toContain('try again');
  });

  it('not a business id → never offered', async () => {
    expect(await shouldOfferUpdatesOptIn(seed() as any, PHONE, 'biz-1', true)).toBe(false);
    expect(await shouldOfferUpdatesOptIn(seed() as any, PHONE, null, true)).toBe(false);
  });

  it('other text is not handled', async () => {
    const db = seed();
    const handled = await handleUpdatesOptInTap(db as any, { from: PHONE, text: 'yes', messageType: 'list', sendReply: async () => {} });
    expect(handled).toBe(false);
    expect(db.writes).toHaveLength(0);
  });
});
