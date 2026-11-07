/**
 * #591 Part B — the Broadcasts page's audience comes from the send rule.
 *
 * GET /api/broadcasts/recipients runs for real against an in-memory table store
 * that applies filters for real, alongside the real POST /api/broadcasts/send and
 * the real hasRecipientPermission. The key proof is the cross-check: the list the
 * page is given equals exactly the people the send route actually messages.
 * Only auth, capability/limits plumbing, the channel and the provider are replaced.
 * All network egress is denied.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const net = vi.hoisted(() => {
  const original = globalThis.fetch;
  const state = { attempts: 0 };
  globalThis.fetch = (async () => { state.attempts++; throw new Error('NETWORK-DENY'); }) as typeof fetch;
  return { state, restore: () => { globalThis.fetch = original; } };
});
afterAll(() => net.restore());

const m = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  user: { id: 'owner-a' } as { id: string } | null,
  delivered: [] as string[],
  rpc: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) }, from: (t: string) => m.db.from(t) }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t), rpc: m.rpc }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ broadcast_limits: { growth: { maxBroadcasts: 100, maxRecipients: 1000 } } }) }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ resolveTemplateCategory: async () => null }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ html: '', subject: '' }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { async resolveByBusinessId() { return { cloud: {}, sender: { sendText: vi.fn(), sendTemplate: vi.fn() } }; } },
}));
vi.mock('@/lib/channels/send-or-email', () => ({
  findCustomerEmail: async () => null,
  sendOrEmail: async ({ to }: { to: string }) => { m.delivered.push(to); return { whatsapp: 'sent', email: 'skipped' }; },
}));

import { GET as recipients } from '@/app/api/broadcasts/recipients/route';
import { POST as send } from '@/app/api/broadcasts/send/route';

const BIZ = 'biz-a';
const OTHER = 'biz-b';
const GRANTED = '+2348031111111';
const REVOKED = '+2348032222222';
const EXPIRED = '+2348033333333';
const PENDING = '+2348034444444';
const OPTED_OUT_GLOBAL = '+2348035555555';
const OPTED_OUT_HERE = '+2348036666666';
const UTILITY_ONLY = '+2348037777777';
const EMAIL_ONLY = '+2348038888888';
const OTHER_BIZ_ONLY = '+2348039999999';
const OPTED_OUT_ELSEWHERE = '+2348030000001';
const NO_PLUS = '2348030000002';
const ALL = [GRANTED, REVOKED, EXPIRED, PENDING, OPTED_OUT_GLOBAL, OPTED_OUT_HERE, UTILITY_ONLY, EMAIL_ONLY, OTHER_BIZ_ONLY, OPTED_OUT_ELSEWHERE, `+${NO_PLUS}`];

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const consent = (phone: string, extra: Record<string, unknown> = {}) => ({
  id: `c-${Math.random()}`, business_id: BIZ, phone, channel: 'whatsapp', purpose: 'marketing', status: 'granted',
  expires_at: null, created_at: ago(60_000), ...extra,
});
const optOut = (phone: string, business_id: string | null) => ({ id: `o-${Math.random()}`, phone, business_id, channel: 'whatsapp', resubscribed_at: null });

const get = (businessId: string | null = BIZ) =>
  recipients(new NextRequest(`https://example.test/api/broadcasts/recipients${businessId ? `?businessId=${businessId}` : ''}`));

beforeEach(() => {
  m.user = { id: 'owner-a' };
  m.delivered = [];
  m.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  net.state.attempts = 0;
  m.db = createMemoryDb({
    businesses: [
      { id: BIZ, owner_id: 'owner-a', name: 'Ada Salon', subscription_tier: 'growth', country_code: 'NG' },
      { id: OTHER, owner_id: 'owner-b', name: 'Other Shop', subscription_tier: 'growth', country_code: 'NG' },
    ],
    customer_consents: [
      consent(GRANTED),
      consent(REVOKED, { created_at: ago(120_000) }),
      consent(REVOKED, { status: 'revoked', created_at: ago(1_000) }),
      consent(EXPIRED, { expires_at: ago(1_000) }),
      consent(PENDING, { status: 'pending' }),
      consent(OPTED_OUT_GLOBAL),
      consent(OPTED_OUT_HERE),
      consent(UTILITY_ONLY, { purpose: 'utility' }),
      consent(EMAIL_ONLY, { channel: 'email' }),
      consent(OTHER_BIZ_ONLY, { business_id: OTHER }),
      consent(OPTED_OUT_ELSEWHERE),
      consent(NO_PLUS),
    ],
    messaging_opt_outs: [
      optOut(OPTED_OUT_GLOBAL, null),
      optOut(OPTED_OUT_HERE, BIZ),
      optOut(OPTED_OUT_ELSEWHERE, OTHER),
    ],
    customer_profiles: [
      { business_id: BIZ, phone: GRANTED, name: 'Ada Obi', tags: ['vip'], total_spent: 5000, last_seen_at: ago(86_400_000) },
      // Same person's profile at another business must not leak into this list.
      { business_id: OTHER, phone: OPTED_OUT_ELSEWHERE, name: 'Elsewhere Name', tags: ['other-tag'], total_spent: 1, last_seen_at: ago(1) },
      // Not opted in: a profile alone (notification_opt_in defaults true) never puts someone on the list.
      { business_id: BIZ, phone: '+2348030000009', name: 'Profile Only', tags: ['vip'], total_spent: 9, last_seen_at: ago(1), notification_opt_in: true },
    ],
    broadcast_usage: [],
    notifications: [],
  });
});

describe('GET /api/broadcasts/recipients — access', () => {
  it('requires a signed-in user', async () => {
    m.user = null;
    expect((await get()).status).toBe(401);
  });

  it('requires businessId', async () => {
    expect((await get(null)).status).toBe(400);
  });

  it('is owner-only: another owner gets 403 and no list', async () => {
    m.user = { id: 'owner-b' };
    const res = await get(BIZ);
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('recipients');
  });
});

describe('GET /api/broadcasts/recipients — who is listed', () => {
  it('lists only granted, unexpired, not-opted-out marketing consent on WhatsApp for this business', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.truncated).toBe(false);
    expect(body.recipients.map((r: { phone: string }) => r.phone).sort()).toEqual([GRANTED, OPTED_OUT_ELSEWHERE, `+${NO_PLUS}`].sort());
    // excluded: revoked (latest record), expired, pending, opted out (global and here),
    // utility-only, email-only, other business's consent, profile without consent
    for (const p of [REVOKED, EXPIRED, PENDING, OPTED_OUT_GLOBAL, OPTED_OUT_HERE, UTILITY_ONLY, EMAIL_ONLY, OTHER_BIZ_ONLY, '+2348030000009']) {
      expect(body.recipients.some((r: { phone: string }) => r.phone === p)).toBe(false);
    }
  });

  it('attaches this business\'s profile details only (for the page filters)', async () => {
    const body = await (await get()).json();
    const byPhone = Object.fromEntries(body.recipients.map((r: { phone: string }) => [r.phone, r]));
    expect(byPhone[GRANTED]).toMatchObject({ name: 'Ada Obi', tags: ['vip'], total_spent: 5000 });
    expect(byPhone[OPTED_OUT_ELSEWHERE]).toEqual({ phone: OPTED_OUT_ELSEWHERE, name: null, tags: [], total_spent: null, last_seen_at: null });
  });

  it('a later grant after a revoke puts the person back on the list', async () => {
    m.db.tables.customer_consents.push(consent(REVOKED, { created_at: ago(10) }));
    const body = await (await get()).json();
    expect(body.recipients.some((r: { phone: string }) => r.phone === REVOKED)).toBe(true);
  });

  it('ignores consent rows stored in a spelling the send check never reads', async () => {
    m.db.tables.customer_consents.push(consent('+234 803 111 1111', { status: 'revoked', created_at: ago(10) }));
    const body = await (await get()).json();
    // hasRecipientPermission reads only "digits" and "+digits", so GRANTED is still sendable.
    expect(body.recipients.some((r: { phone: string }) => r.phone === GRANTED)).toBe(true);
  });

  it('business isolation: the other owner sees only their own opted-in people', async () => {
    m.user = { id: 'owner-b' };
    const body = await (await get(OTHER)).json();
    expect(body.recipients.map((r: { phone: string }) => r.phone)).toEqual([OTHER_BIZ_ONLY]);
  });

  it('fails closed when consent, opt-out or profile reads fail', async () => {
    for (const table of ['customer_consents', 'messaging_opt_outs', 'customer_profiles']) {
      m.db.failReads.clear();
      m.db.failReads.add(table);
      const res = await get();
      expect(res.status).toBe(503);
      expect(await res.json()).not.toHaveProperty('recipients');
    }
  });
});

describe('the list matches what POST /api/broadcasts/send actually does', () => {
  it('the send route messages exactly the listed people (same purpose, same opt-out rule)', async () => {
    const listed = (await (await get()).json()).recipients.map((r: { phone: string }) => r.phone).sort();

    const res = await send(new NextRequest('https://example.test/api/broadcasts/send', {
      method: 'POST', body: JSON.stringify({ business_id: BIZ, message: 'Hello', phones: ALL }),
    }));
    expect(res.status).toBe(200);
    expect([...m.delivered].sort()).toEqual(listed);
    expect(net.state.attempts).toBe(0);
  });

  it('a utility grant alone is listed by neither (broadcasts use marketing consent)', async () => {
    const listed = (await (await get()).json()).recipients.map((r: { phone: string }) => r.phone);
    expect(listed).not.toContain(UTILITY_ONLY);
    await send(new NextRequest('https://example.test/api/broadcasts/send', {
      method: 'POST', body: JSON.stringify({ business_id: BIZ, message: 'Hello', phones: [UTILITY_ONLY] }),
    }));
    expect(m.delivered).toEqual([]);
  });
});

describe('GET /api/broadcasts/recipients — truncated (#948 follow-up)', () => {
  it('passes truncated: true through when the consent scan cap is reached', async () => {
    // 5,100 older rows for 102 extra people, so the scan stops before reading them all.
    for (let i = 0; i < 5100; i++) {
      m.db.tables.customer_consents.push(consent(`+234810${String(i % 102).padStart(7, '0')}`, { created_at: ago(3_600_000 + i) }));
    }
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recipients.length).toBeLessThan(500);
    expect(body.truncated).toBe(true);
  });
});
