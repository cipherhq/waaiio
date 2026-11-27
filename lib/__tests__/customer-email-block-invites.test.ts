/**
 * #1166 r7 F15, F16, F22 on merchant-started sends: event and party invites
 * (email fallback and listed emails) and broadcast email copies. A blocked
 * email, or a blocked phone's email copy, is treated exactly like an email the
 * merchant may not use: the invite falls back to SMS or the share link
 * (`needs_optin`), and the broadcast sends no email copy. Merchants see no
 * block-specific result (Q3 A).
 *
 * Harness from party-cold-invite-1005 (invite) and broadcasts-recipients-591b
 * (broadcast). The block tables live in the in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';

const m = vi.hoisted(() => ({
  from: vi.fn(), resolve: vi.fn(), optIn: vi.fn(), sms: vi.fn(), emails: [] as string[],
  blocks: null as any,
  delivered: [] as Array<{ to: string; email: unknown }>,
  bdb: null as any,
}));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => ({ user: { id: 'owner' }, service: { from: (t: string) => m.from(t) } }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-a' } } }) }, from: (t: string) => m.bdb.from(t) }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.bdb.from(t), rpc: async () => ({ data: null, error: null }) }) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/security/check-optin', () => ({ checkOptInBatch: (...a: unknown[]) => m.optIn(...a) }));
vi.mock('@/lib/sms/send', () => ({ sendBusinessSms: (...a: unknown[]) => m.sms(...a) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async (x: { to: string }) => { m.emails.push(x.to); return { success: true }; }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByBusinessId = (...a: unknown[]) => m.resolve(...a);
  },
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => {
  const q: any = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  q.withContext = () => q;
  return { logger: q };
});
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: vi.fn() }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ broadcast_limits: { growth: { maxBroadcasts: 100, maxRecipients: 1000 } } }) }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ resolveTemplateCategory: async () => null }));
vi.mock('@/lib/whatsapp-forms/email-consent', () => ({ hasEmailMarketingPermission: async () => true, normalizeConsentEmail: (e: string) => e }));
vi.mock('@/lib/merchants/recipient-permission', () => ({ hasRecipientPermission: async () => true }));
vi.mock('@/lib/channels/send-or-email', () => ({
  findCustomerEmail: async (_db: unknown, phone: string) => (phone.endsWith('1111') ? 'ann@example.com' : 'clear@example.com'),
  sendOrEmail: async ({ to, email }: { to: string; email: unknown }) => { m.delivered.push({ to, email }); return { whatsapp: 'sent', email: email ? 'sent' : 'no_address' }; },
}));

import { POST as hostInvite } from '@/app/api/events/invite/route';
import { POST as broadcast } from '@/app/api/broadcasts/send/route';

const BLOCKED_PHONE = '2348012345678';
const CLEAR_PHONE = '2348031234567';
const BLOCKED_EMAIL = 'ann@example.com';

function table(result: { single?: unknown; count?: number | null }) {
  const q: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'neq', 'in', 'or', 'is', 'order', 'limit', 'update', 'insert']) q[k] = vi.fn(() => q);
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], count: result.count ?? 0, error: null }).then(ok);
  q.single = vi.fn(async () => ({ data: result.single ?? null, error: result.single ? null : { message: 'none' } }));
  q.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return q;
}

function setupInvite() {
  m.blocks = createMemoryDb({
    customer_suspensions: [{ id: 's1', phone: BLOCKED_PHONE, reason: 'abuse', last_notified_at: null }],
    customer_email_blocks: [{ id: 'e1', email: BLOCKED_EMAIL, reason: 'abuse' }],
  });
  const tables: Record<string, unknown> = {
    parties: table({ single: { id: 'p1', name: "Ada's party", date: '2026-12-05', time: '18:00', venue: 'The Citadel', invite_message: null, max_guests: null } }),
    event_invites: table({ single: { id: 'inv-1', invite_token: 'c'.repeat(24), status: 'pending' } }),
    businesses: table({ single: { name: 'Test Bees', country_code: 'NG', subscription_tier: 'free' } }),
    messaging_opt_outs: table({ count: 0 }),
    customer_consents: table({}),
  };
  m.from.mockImplementation((t: string) => (t === 'customer_suspensions' || t === 'customer_email_blocks') ? m.blocks.from(t) : tables[t] ?? table({}));
  m.resolve.mockResolvedValue({ sender: { sendTemplate: vi.fn(), sendButtons: vi.fn(), sendImage: vi.fn() }, channel: { phone_number: '+2349000000000' } });
  m.optIn.mockResolvedValue(new Map());
  m.sms.mockResolvedValue({ status: 'skipped' }); // SMS unavailable, so the result is the share link
}
const invite = (phones: string[], emails: string[]) => hostInvite(new Request('http://x/api/events/invite', {
  method: 'POST', body: JSON.stringify({ partyId: 'p1', businessId: 'biz-1', phones, emails }),
}) as never).then(r => r.json());

beforeEach(() => { vi.clearAllMocks(); m.emails.length = 0; m.delivered.length = 0; });

describe('POST /api/events/invite: email fallback (F15, F16, F22)', () => {
  it('a clear guest gets the email invite', async () => {
    setupInvite();
    const body = await invite([CLEAR_PHONE], ['clear@example.com']);
    expect(m.emails).toContain('clear@example.com');
    expect(body.results[0].status).toBe('email_sent');
  });

  it('a blocked email gets no invite email; the merchant sees the same share-link result as a guest without consent', async () => {
    setupInvite();
    const body = await invite([CLEAR_PHONE], [BLOCKED_EMAIL]);
    expect(m.emails).not.toContain(BLOCKED_EMAIL);
    expect(body.results[0]).toMatchObject({ phone: expect.any(String), status: 'needs_optin' });
    expect(JSON.stringify(body)).not.toMatch(/block/i);
  });

  it("a blocked phone's email copy is not sent either (fallback and listed emails)", async () => {
    setupInvite();
    const body = await invite([BLOCKED_PHONE], ['clear@example.com']);
    expect(m.emails).not.toContain('clear@example.com');
    expect(body.results[0].status).toBe('needs_optin');
  });

  it('listed invite emails skip a blocked address and still go to the others', async () => {
    setupInvite();
    await invite([CLEAR_PHONE, '2348035555555'], [BLOCKED_EMAIL, 'other@example.com']);
    expect(m.emails).not.toContain(BLOCKED_EMAIL);
    expect(m.emails).toContain('other@example.com');
  });
});

describe('POST /api/broadcasts/send: email copy (F15, F16, F22)', () => {
  it('a blocked email or a blocked phone gets no email copy; WhatsApp is unchanged; the clear one gets both', async () => {
    m.bdb = createMemoryDb({
      businesses: [{ id: 'biz-a', owner_id: 'owner-a', name: 'Ada Salon', subscription_tier: 'growth', country_code: 'NG' }],
      customer_suspensions: [{ id: 's1', phone: '2348032222222', reason: 'abuse', last_notified_at: null }],
      customer_email_blocks: [{ id: 'e1', email: BLOCKED_EMAIL, reason: 'abuse' }],
      messaging_opt_outs: [], broadcast_usage: [], notifications: [], customer_consents: [], customer_profiles: [],
    });
    // ...1111 has the blocked email; ...2222 is a blocked phone; ...3333 is clear.
    const res = await broadcast(new NextRequest('https://example.test/api/broadcasts/send', {
      method: 'POST', body: JSON.stringify({ business_id: 'biz-a', message: 'Hello', phones: ['+2348031111111', '+2348032222222', '+2348033333333'] }),
    }));
    expect(res.status).toBe(200);
    const byPhone = Object.fromEntries(m.delivered.map(d => [d.to.replace(/\D/g, '').slice(-4), d.email]));
    expect(byPhone['1111']).toBeNull();
    expect(byPhone['2222']).toBeNull();
    expect(byPhone['3333']).toMatchObject({ address: 'clear@example.com' });
  });
});
