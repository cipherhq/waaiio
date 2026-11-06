/**
 * #591 — sending web forms from the Forms page.
 *
 * Real route handlers, the real consent helper (hasRecipientPermission), the real
 * Audience resolver and the real consent writer (grantConsent) run against an
 * in-memory table store that applies filters for real, so tenant scoping,
 * latest-record-wins consent and opt-outs are proved by data, not by call lists.
 * Only the auth session, the WhatsApp channel and the provider are replaced.
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
  text: vi.fn(), template: vi.fn(), getTemplates: vi.fn(), rpc: vi.fn(),
  resolvedFor: [] as string[],
  conv: { allowed: true, used: 0, limit: 100 },
  /** Sending channel shape. Default: a shared number (its receipts alone name no business). */
  channel: null as null | ((businessId: string) => Record<string, unknown>),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) }, from: (t: string) => m.db.from(t) }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t), rpc: m.rpc }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => m.conv }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId(businessId: string) {
      m.resolvedFor.push(businessId);
      return {
        channel: m.channel ? m.channel(businessId) : { id: `chan-${businessId}`, channel_type: 'shared', business_id: null },
        cloud: { getTemplates: m.getTemplates },
        sender: { sendText: m.text, sendTemplate: m.template },
      };
    }
  },
}));

import { POST as send } from '@/app/api/forms/send/route';
import { GET as contacts } from '@/app/api/forms/recipients/route';
import { POST as submit } from '@/app/api/forms/submit/route';
import { GET as publicForm } from '@/app/api/forms/public/[token]/route';

const BIZ = 'biz-a';
const OTHER = 'biz-b';
const FORM = 'form-a';
const P1 = '+2348031111111';
const P2 = '+2348032222222';
const P3 = '+2348033333333';
const hourAgo = () => new Date(Date.now() - 60 * 60_000).toISOString();
const dayAgo = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();

const consent = (phone: string, extra: Record<string, unknown> = {}) => ({
  business_id: BIZ, phone, channel: 'whatsapp', purpose: 'marketing', status: 'granted', expires_at: null,
  created_at: new Date(Date.now() - 10_000).toISOString(), ...extra,
});
const template = (over: Record<string, unknown> = {}) => ({
  name: 'feedback_request', status: 'APPROVED', category: 'MARKETING', language: 'en_US',
  components: [{ type: 'BODY', text: '{{1}} would like your feedback!\n\n{{2}}' }], ...over,
});

const post = (url: string, body: unknown) => new NextRequest(`https://example.test${url}`, { method: 'POST', body: JSON.stringify(body) });
const sendBody = (extra: Record<string, unknown> = {}) => ({ formId: FORM, businessId: BIZ, ...extra });
const formRows = () => m.db.writes.filter(w => w.table === 'form_responses');

beforeEach(() => {
  vi.clearAllMocks();
  net.state.attempts = 0;
  m.user = { id: 'owner-a' };
  m.resolvedFor = [];
  m.conv = { allowed: true, used: 0, limit: 100 };
  m.channel = null;
  m.text.mockResolvedValue({ success: true, messageId: 'wamid.text' });
  m.template.mockResolvedValue({ success: true, messageId: 'wamid.tpl' });
  m.getTemplates.mockResolvedValue({ data: [template()] });
  m.rpc.mockResolvedValue({ data: null, error: null });
  m.db = createMemoryDb({
    businesses: [
      { id: BIZ, owner_id: 'owner-a', name: 'Ada Salon', country_code: 'NG' },
      { id: OTHER, owner_id: 'owner-b', name: 'Other Shop', country_code: 'NG' },
    ],
    forms: [
      { id: FORM, business_id: BIZ, title: 'Guest list', description: 'Tell us', token: 'tokA', is_active: true, fields: [{ id: 'p', label: 'Phone', type: 'phone', required: false }], settings: {} },
      { id: 'form-b', business_id: OTHER, title: 'Other', description: null, token: 'tokB', is_active: true, fields: [], settings: {} },
    ],
    customer_consents: [consent(P1)],
    messaging_opt_outs: [],
    whatsapp_inbound_receipts: [],
    notifications: [],
    form_responses: [],
    customer_profiles: [],
    engage_segments: [],
    bot_sessions: [],
  });
});

describe('POST /api/forms/send — access and tenant isolation', () => {
  it('requires a signed-in owner of the business', async () => {
    m.user = null;
    expect((await send(post('/api/forms/send', sendBody({ phone: P1 })))).status).toBe(401);
    m.user = { id: 'owner-b' };
    expect((await send(post('/api/forms/send', sendBody({ phone: P1 })))).status).toBe(403);
    expect(m.text).not.toHaveBeenCalled();
  });

  it('refuses another business’s form and audience', async () => {
    expect((await send(post('/api/forms/send', sendBody({ formId: 'form-b', phone: P1 })))).status).toBe(404);
    m.db.tables.engage_segments.push({ id: '11111111-1111-4111-a111-111111111111', business_id: OTHER, expression: { type: 'predicate', source: 'contact', field: 'phone', operator: 'is_not_null' } });
    const res = await send(post('/api/forms/send', sendBody({ segmentId: '11111111-1111-4111-a111-111111111111' })));
    expect(res.status).toBe(404);
    expect(m.text).not.toHaveBeenCalled();
    expect(m.template).not.toHaveBeenCalled();
  });

  it('does not count another business’s consent', async () => {
    m.db.tables.customer_consents = [consent(P1, { business_id: OTHER })];
    m.db.tables.whatsapp_inbound_receipts = [{ channel_id: `chan-${BIZ}`, sender_phone: P1.slice(1), provider_timestamp: hourAgo() }];
    const data = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(data.results).toEqual([{ phone: P1, status: 'skipped', reason: 'no_consent' }]);
    expect(m.text).not.toHaveBeenCalled();
  });

  it('sends through this business’s own channel only', async () => {
    m.db.tables.whatsapp_inbound_receipts = [{ channel_id: `chan-${BIZ}`, sender_phone: P1.slice(1), provider_timestamp: hourAgo() }];
    await send(post('/api/forms/send', sendBody({ phone: P1 })));
    expect(m.resolvedFor).toEqual([BIZ]);
  });
});

describe('POST /api/forms/send — consent and opt-outs (no cold sending)', () => {
  beforeEach(() => {
    for (const p of [P1, P2, P3]) m.db.tables.whatsapp_inbound_receipts.push({ channel_id: `chan-${BIZ}`, sender_phone: p.slice(1), provider_timestamp: hourAgo() });
  });

  it('skips a recipient with no recorded consent whose window on a shared number is not a chat with this business', async () => {
    const res = await send(post('/api/forms/send', sendBody({ phone: P2 })));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ success: false, sent: 0, failed: 0, skipped: 1 });
    expect(data.results[0]).toEqual({ phone: P2, status: 'skipped', reason: 'no_consent' });
    expect(data.policy).toMatch(/Cold messaging is not allowed/);
    expect(m.text).not.toHaveBeenCalled();
  });

  it('skips utility-only consent: invitations need marketing consent', async () => {
    m.db.tables.customer_consents = [consent(P1, { purpose: 'utility' })];
    const data = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(data.results[0].reason).toBe('no_consent');
  });

  it('skips a revoked or expired consent (latest record wins)', async () => {
    m.db.tables.customer_consents.push(consent(P1, { status: 'revoked', created_at: new Date().toISOString() }));
    m.db.tables.customer_consents.push(consent(P2, { expires_at: hourAgo() }));
    const data = await (await send(post('/api/forms/send', sendBody({ phones: [P1, P2] })))).json();
    expect(data.results.map((r: { reason: string }) => r.reason)).toEqual(['no_consent', 'no_consent']);
    expect(m.text).not.toHaveBeenCalled();
  });

  it('skips business and platform-wide opt-outs, and honours resubscription', async () => {
    m.db.tables.customer_consents.push(consent(P2), consent(P3));
    m.db.tables.messaging_opt_outs.push(
      { phone: P1, business_id: BIZ, channel: 'whatsapp', resubscribed_at: null },
      { phone: P2.slice(1), business_id: null, channel: 'whatsapp', resubscribed_at: null },
      { phone: P3, business_id: BIZ, channel: 'whatsapp', resubscribed_at: hourAgo() },
    );
    const data = await (await send(post('/api/forms/send', sendBody({ phones: [P1, P2, P3] })))).json();
    expect(data.results).toEqual([
      { phone: P1, status: 'skipped', reason: 'opted_out' },
      { phone: P2, status: 'skipped', reason: 'opted_out' },
      { phone: P3, status: 'sent', via: 'text' },
    ]);
    expect(m.text).toHaveBeenCalledTimes(1);
  });

  it('fails closed when consent or opt-out data cannot be read', async () => {
    m.db.failReads.add('messaging_opt_outs');
    let data = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(data.results[0]).toEqual({ phone: P1, status: 'skipped', reason: 'check_failed' });
    m.db.failReads.clear(); m.db.failReads.add('customer_consents');
    data = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(data.results[0].status).toBe('skipped');
    expect(m.text).not.toHaveBeenCalled();
  });

  it('skips numbers that are not valid phone numbers and sends each person once', async () => {
    const data = await (await send(post('/api/forms/send', sendBody({ phones: ['hello', P1, '0803 111 1111'] })))).json();
    expect(data.results).toEqual([
      { phone: 'hello', status: 'skipped', reason: 'invalid_phone' },
      { phone: P1, status: 'sent', via: 'text' },
    ]);
    expect(m.text).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/forms/send — 24-hour window and templates', () => {
  it('inside the window sends the form link as text', async () => {
    m.db.tables.whatsapp_inbound_receipts = [{ channel_id: `chan-${BIZ}`, sender_phone: P1.slice(1), provider_timestamp: hourAgo() }];
    const data = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(data).toMatchObject({ success: true, sent: 1 });
    expect(m.text).toHaveBeenCalledWith(expect.objectContaining({ to: P1.slice(1), messageCategory: 'service', noRetry: true }));
    expect(m.text.mock.calls[0][0].text).toContain('/form/tokA');
    expect(m.template).not.toHaveBeenCalled();
  });

  it('outside the window without a template fails honestly and sends nothing', async () => {
    m.db.tables.whatsapp_inbound_receipts = [
      { channel_id: `chan-${BIZ}`, sender_phone: P1.slice(1), provider_timestamp: dayAgo() },
      // A message on a different channel does not open this sender's window.
      { channel_id: 'chan-other', sender_phone: P1.slice(1), provider_timestamp: hourAgo() },
    ];
    const data = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(data).toMatchObject({ success: false, sent: 0, failed: 1 });
    expect(data.results[0]).toEqual({ phone: P1, status: 'failed', reason: 'no_template' });
    expect(m.text).not.toHaveBeenCalled();
    expect(m.template).not.toHaveBeenCalled();
    expect(m.db.tables.notifications).toEqual([expect.objectContaining({ status: 'failed', recipient_phone: P1 })]);
  });

  it('outside the window sends the approved template carrying the form link', async () => {
    const data = await (await send(post('/api/forms/send', sendBody({ phone: P1, templateName: 'feedback_request' })))).json();
    expect(data).toMatchObject({ success: true, sent: 1 });
    expect(data.results[0]).toEqual({ phone: P1, status: 'sent', via: 'template' });
    const call = m.template.mock.calls[0][0];
    expect(call).toMatchObject({ to: P1.slice(1), templateName: 'feedback_request', messageCategory: 'marketing', noRetry: true });
    expect(call.templateParams[0]).toBe('Ada Salon');
    expect(call.templateParams[1]).toMatch(/^Guest list: https?:\/\/.+\/form\/tokA$/);
    expect(call.templateParams.join('')).not.toMatch(/[\n\t]/);
    expect(m.text).not.toHaveBeenCalled();
  });

  it.each([
    ['not approved', template({ status: 'PENDING' })],
    ['wrong number of parameters', template({ components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}}' }] })],
    ['needs a button parameter', template({ components: [{ type: 'BODY', text: '{{1}} {{2}}' }, { type: 'BUTTONS', buttons: [] }] })],
    ['authentication category', template({ category: 'AUTHENTICATION' })],
    ['not English (US)', template({ language: 'fr' })],
  ])('refuses a template that is %s, before sending anything', async (_label, t) => {
    m.getTemplates.mockResolvedValue({ data: [t] });
    const res = await send(post('/api/forms/send', sendBody({ phone: P1, templateName: 'feedback_request' })));
    expect(res.status).toBe(400);
    expect(m.template).not.toHaveBeenCalled();
    expect(m.text).not.toHaveBeenCalled();
  });

  it('uses the template’s own category (utility) from the sending account', async () => {
    m.getTemplates.mockResolvedValue({ data: [template({ name: 'form_invite', category: 'UTILITY' })] });
    await send(post('/api/forms/send', sendBody({ phone: P1, templateName: 'form_invite' })));
    expect(m.template.mock.calls[0][0].messageCategory).toBe('utility');
  });
});

describe('POST /api/forms/send — honest delivery status', () => {
  it('reports a provider rejection as failed, never success', async () => {
    m.template.mockRejectedValue(new Error('(#131026) Message undeliverable'));
    const res = await send(post('/api/forms/send', sendBody({ phone: P1, templateName: 'feedback_request' })));
    const data = await res.json();
    expect(data).toMatchObject({ success: false, sent: 0, failed: 1 });
    expect(data.results[0]).toEqual({ phone: P1, status: 'failed', reason: 'provider_error' });
    expect(m.db.tables.notifications[0]).toMatchObject({ status: 'failed', failed_reason: expect.stringContaining('did not confirm') });
  });

  it('reports a mixed batch per recipient', async () => {
    m.db.tables.customer_consents.push(consent(P2));
    m.template.mockResolvedValueOnce({ success: true, messageId: 'w1' }).mockRejectedValueOnce(new Error('rejected'));
    const data = await (await send(post('/api/forms/send', sendBody({ phones: [P1, P2, P3], templateName: 'feedback_request' })))).json();
    expect(data).toMatchObject({ success: true, sent: 1, failed: 1, skipped: 1 });
    expect(data.results.find((r: { phone: string }) => r.phone === P3)).toEqual({ phone: P3, status: 'skipped', reason: 'no_consent' });
  });

  it('never writes form_responses when sending', async () => {
    m.db.tables.customer_consents.push(consent(P2));
    await send(post('/api/forms/send', sendBody({ phones: [P1, P2, P3], templateName: 'feedback_request' })));
    expect(formRows()).toEqual([]);
    expect(m.db.tables.form_responses).toEqual([]);
    expect(m.db.writes.filter(w => ['customer_consents', 'messaging_opt_outs'].includes(w.table))).toEqual([]);
  });

  it('refuses inactive forms, empty and oversized recipient lists', async () => {
    m.db.tables.forms[0].is_active = false;
    expect((await send(post('/api/forms/send', sendBody({ phone: P1 })))).status).toBe(400);
    m.db.tables.forms[0].is_active = true;
    expect((await send(post('/api/forms/send', sendBody({})))).status).toBe(400);
    expect((await send(post('/api/forms/send', sendBody({ phones: 'not-a-list' })))).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `+23480300${String(i).padStart(5, '0')}`);
    expect((await send(post('/api/forms/send', sendBody({ phones: many })))).status).toBe(400);
    expect(m.text).not.toHaveBeenCalled();
  });
});

describe('POST /api/forms/send — limits and failure modes', () => {
  it('refuses an oversized typed list before parsing it', async () => {
    const junk = Array.from({ length: 501 }, (_, i) => `x${i}`);
    expect((await send(post('/api/forms/send', sendBody({ phones: junk })))).status).toBe(400);
  });

  it('a template lookup outage is a 503 with nothing sent, not "bad template"', async () => {
    m.getTemplates.mockRejectedValue(new Error('Meta down'));
    const res = await send(post('/api/forms/send', sendBody({ phone: P1, templateName: 'feedback_request' })));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Nothing was sent/);
    expect(m.template).not.toHaveBeenCalled();
  });

  it('a gate or suspension block is reported as blocked, not as a WhatsApp rejection', async () => {
    const { MessagingSuspendedError } = await import('@/lib/channels/send-guard');
    m.template.mockRejectedValue(new MessagingSuspendedError(BIZ, 'suspended'));
    const data = await (await send(post('/api/forms/send', sendBody({ phone: P1, templateName: 'feedback_request' })))).json();
    expect(data.results[0]).toEqual({ phone: P1, status: 'failed', reason: 'blocked' });
  });

  it('stops starting new recipients after the time budget and reports them as not attempted', async () => {
    const { sendFormInvites } = await import('@/lib/forms/form-send');
    const phones = Array.from({ length: 7 }, (_, i) => `+23480300000${i}`);
    for (const p of phones) m.db.tables.customer_consents.push(consent(p));
    const resolved = { channel: { id: `chan-${BIZ}` }, cloud: { getTemplates: m.getTemplates }, sender: { sendText: m.text, sendTemplate: m.template } };
    const realNow = Date.now;
    let calls = 0;
    // First batch starts before the deadline; the second batch starts after it.
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (calls++ > 0 && m.template.mock.calls.length >= 5 ? 60_000 : 0));
    try {
      const out = await sendFormInvites({
        db: m.db as never, resolved: resolved as never, businessId: BIZ, businessName: 'Ada Salon',
        form: { id: FORM, title: 'Guest list', description: null, token: 'tokA' },
        template: { name: 'feedback_request', category: 'marketing' }, phones, deadline: realNow() + 30_000,
      });
      expect(out.slice(0, 5).every(o => o.status === 'sent')).toBe(true);
      expect(out.slice(5)).toEqual(phones.slice(5).map(phone => ({ phone, status: 'skipped', reason: 'not_attempted' })));
      expect(m.template).toHaveBeenCalledTimes(5);
    } finally { spy.mockRestore(); }
  });
});

describe('POST /api/forms/send — saved Audience', () => {
  const SEG = '22222222-2222-4222-a222-222222222222';
  it('resolves only this business’s contacts and still checks consent per person', async () => {
    m.db.tables.engage_segments.push({ id: SEG, business_id: BIZ, expression: { type: 'predicate', source: 'contact', field: 'phone', operator: 'is_not_null' } });
    m.db.tables.customer_profiles.push(
      { id: 'cp1', business_id: BIZ, phone: P1, name: 'Ada', created_at: '2026-01-01' },
      { id: 'cp2', business_id: BIZ, phone: P2, name: 'Bola', created_at: '2026-01-02' },
      { id: 'cp3', business_id: OTHER, phone: P3, name: 'Not mine', created_at: '2026-01-03' },
    );
    const data = await (await send(post('/api/forms/send', sendBody({ segmentId: SEG, templateName: 'feedback_request' })))).json();
    expect(data.results).toEqual(expect.arrayContaining([
      { phone: P1, status: 'sent', via: 'template' },
      { phone: P2, status: 'skipped', reason: 'no_consent' },
    ]));
    expect(data.results).toHaveLength(2);
    expect(m.template).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/forms/recipients — opted-in contacts picker', () => {
  const get = (businessId = BIZ) => contacts(new NextRequest(`https://example.test/api/forms/recipients?businessId=${businessId}`));

  it('lists only people whose latest marketing consent for this business is granted and who have not opted out', async () => {
    m.db.tables.customer_consents.push(
      consent(P2, { created_at: new Date(Date.now() - 20_000).toISOString() }),
      consent(P2, { status: 'revoked', created_at: new Date().toISOString() }),
      consent(P3, { purpose: 'utility' }),
      consent('+2348034444444'),
      consent('+2348035555555', { business_id: OTHER }),
    );
    m.db.tables.messaging_opt_outs.push({ phone: '+2348034444444', business_id: null, channel: 'whatsapp', resubscribed_at: null });
    m.db.tables.customer_profiles.push({ business_id: BIZ, phone: P1, name: 'Ada' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: [{ phone: P1, name: 'Ada' }], truncated: false, recentChats: [], recentChatsTruncated: false });
  });

  it('is owner-only and fails closed', async () => {
    m.user = { id: 'owner-b' };
    expect((await get()).status).toBe(403);
    m.user = { id: 'owner-a' };
    m.db.failReads.add('messaging_opt_outs');
    expect((await get()).status).toBe(503);
  });
});

describe('Optional "Yes, send me updates" on the public form', () => {
  const submitBody = (extra: Record<string, unknown> = {}) => ({ token: 'tokA', answers: { p: P2 }, customer_phone: P2, ...extra });
  const consents = () => m.db.writes.filter(w => w.table === 'customer_consents');

  it('records nothing when the form does not offer the box', async () => {
    const res = await submit(post('/api/forms/submit', submitBody({ marketing_opt_in: true })));
    expect(res.status).toBe(200);
    expect(consents()).toEqual([]);
    expect(m.db.tables.form_responses[0]).not.toHaveProperty('consent_given');
  });

  it('records nothing when the box is offered but left unticked', async () => {
    m.db.tables.forms[0].settings = { marketing_opt_in: true };
    await submit(post('/api/forms/submit', submitBody({ marketing_opt_in: false })));
    expect(consents()).toEqual([]);
    expect(m.db.tables.form_responses[0]).toMatchObject({ consent_given: false, status: 'submitted' });
  });

  it('records a ticked box as pending in the existing consent store, which is never sendable', async () => {
    m.db.tables.forms[0].settings = { marketing_opt_in: true };
    const res = await submit(post('/api/forms/submit', submitBody({ marketing_opt_in: true, customer_phone: '0803 222 2222' })));
    expect(await res.json()).toEqual({ success: true, optInPending: true });
    expect(consents()).toEqual([expect.objectContaining({ kind: 'insert', row: expect.objectContaining({
      business_id: BIZ, phone: P2, channel: 'whatsapp', purpose: 'marketing', status: 'pending', source: 'website', evidence_reference: `form:${FORM}`,
    }) })]);
    expect(consents().some(w => w.row.status === 'granted')).toBe(false);
    expect(m.db.tables.form_responses[0]).toMatchObject({ consent_given: true });
    // Nobody proved they own the typed number, so a web tick alone never makes it sendable
    // (here the window is on a shared number with no chat with this business).
    m.db.tables.whatsapp_inbound_receipts.push({ channel_id: `chan-${BIZ}`, sender_phone: P2.slice(1), provider_timestamp: hourAgo() });
    const sent = await (await send(post('/api/forms/send', sendBody({ phone: P2 })))).json();
    expect(sent.results[0]).toEqual({ phone: P2, status: 'skipped', reason: 'no_consent' });
    expect(m.text).not.toHaveBeenCalled();
    // And it is not offered in the opted-in contacts picker.
    const listed = await (await contacts(new NextRequest(`https://example.test/api/forms/recipients?businessId=${BIZ}`))).json();
    expect(listed.contacts.map((c: { phone: string }) => c.phone)).toEqual([P1]);
  });

  it('a web tick never replaces (and so withdraws) a real permission', async () => {
    m.db.tables.forms[0].settings = { marketing_opt_in: true };
    await submit(post('/api/forms/submit', submitBody({ marketing_opt_in: true, customer_phone: P1 })));
    expect(consents()).toEqual([]);
    m.db.tables.whatsapp_inbound_receipts.push({ channel_id: `chan-${BIZ}`, sender_phone: P1.slice(1), provider_timestamp: hourAgo() });
    const sent = await (await send(post('/api/forms/send', sendBody({ phone: P1 })))).json();
    expect(sent.results[0]).toEqual({ phone: P1, status: 'sent', via: 'text' });
  });

  it('refuses a ticked box without a valid phone, saving nothing', async () => {
    m.db.tables.forms[0].settings = { marketing_opt_in: true };
    const res = await submit(post('/api/forms/submit', submitBody({ marketing_opt_in: true, customer_phone: '12' })));
    expect(res.status).toBe(400);
    expect(consents()).toEqual([]);
    expect(m.db.tables.form_responses).toEqual([]);
  });

  it('the public form tells the page whether to show the box', async () => {
    m.db.tables.forms[0].settings = { marketing_opt_in: true };
    m.db.tables.whatsapp_channels = [];
    const res = await publicForm(new NextRequest('https://example.test/api/forms/public/tokA'), { params: Promise.resolve({ token: 'tokA' }) });
    expect(await res.json()).toMatchObject({ marketing_opt_in: true });
  });
});

describe('Owner option C — people who messaged this business in the last 24 hours', () => {
  const SHARED = 'chan-shared-ng';
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const receipt = (phone: string, at: string, channel = `chan-${BIZ}`) => ({ channel_id: channel, sender_phone: phone.slice(1), provider_timestamp: at });
  const dedicated = () => { m.channel = (b: string) => ({ id: `chan-${b}`, channel_type: 'dedicated', business_id: b }); };
  const shared = () => { m.channel = () => ({ id: SHARED, channel_type: 'shared', business_id: null }); };
  /** A bot conversation as the webhook pipeline stores it. */
  const session = (phone: string, extra: Record<string, unknown> = {}, userAt = minutesAgo(30)) => ({
    id: `s-${Math.random()}`, whatsapp_number: phone.slice(1), business_id: BIZ, is_active: true,
    session_data: { _inbound_channel_id: SHARED }, updated_at: userAt,
    conversation_log: [{ role: 'bot', content: 'Hi', timestamp: userAt }, { role: 'user', content: '1', timestamp: userAt }],
    ...extra,
  });
  const sendTo = async (phones: string[], extra: Record<string, unknown> = {}) =>
    (await (await send(post('/api/forms/send', sendBody({ phones, ...extra })))).json());

  beforeEach(() => { m.db.tables.customer_consents = []; });

  describe('on this business’s own (dedicated) number', () => {
    beforeEach(dedicated);

    it('sends the free-text invite to someone who messaged in the last 24 hours, with no opt-in', async () => {
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(12)));
      const data = await sendTo([P2]);
      expect(data.results).toEqual([{ phone: P2, status: 'sent', via: 'text' }]);
      expect(m.text).toHaveBeenCalledWith(expect.objectContaining({ to: P2.slice(1), messageCategory: 'service' }));
      expect(m.template).not.toHaveBeenCalled();
    });

    it('a window-only person still gets text, not the template, when a template is chosen', async () => {
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(12)));
      const data = await sendTo([P2], { templateName: 'feedback_request' });
      expect(data.results).toEqual([{ phone: P2, status: 'sent', via: 'text' }]);
      expect(m.template).not.toHaveBeenCalled();
    });

    it('once the window has closed a person without opt-in is skipped, never sent the template', async () => {
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, dayAgo()));
      const data = await sendTo([P2], { templateName: 'feedback_request' });
      expect(data.results).toEqual([{ phone: P2, status: 'skipped', reason: 'no_consent' }]);
      expect(m.template).not.toHaveBeenCalled();
      expect(m.text).not.toHaveBeenCalled();
    });

    it('someone with recorded consent outside the window still gets the approved template', async () => {
      m.db.tables.customer_consents.push(consent(P1));
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P1, dayAgo()));
      const data = await sendTo([P1], { templateName: 'feedback_request' });
      expect(data.results).toEqual([{ phone: P1, status: 'sent', via: 'template' }]);
      expect(m.template).toHaveBeenCalledTimes(1);
    });

    it('an opt-out wins even inside the window', async () => {
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(5)));
      m.db.tables.messaging_opt_outs.push({ phone: P2, business_id: BIZ, channel: 'whatsapp', resubscribed_at: null });
      const data = await sendTo([P2]);
      expect(data.results).toEqual([{ phone: P2, status: 'skipped', reason: 'opted_out' }]);
      expect(m.text).not.toHaveBeenCalled();
    });

    it('a message to a different channel does not count', async () => {
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(5), 'chan-other'));
      const data = await sendTo([P2]);
      expect(data.results).toEqual([{ phone: P2, status: 'skipped', reason: 'no_consent' }]);
      expect(m.text).not.toHaveBeenCalled();
    });

    it('a dedicated number recorded for another business is not treated as this business’s own', async () => {
      m.channel = (b: string) => ({ id: `chan-${b}`, channel_type: 'dedicated', business_id: OTHER });
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(5)));
      expect((await sendTo([P2])).results).toEqual([{ phone: P2, status: 'skipped', reason: 'no_consent' }]);
    });

    it('a window that closes between the check and the send means skip, never a template', async () => {
      const { deliverInvite } = await import('@/lib/forms/form-send');
      // No receipt any more at delivery time: the window has closed.
      const out = await deliverInvite({
        db: m.db as never, businessId: BIZ, businessName: 'Ada Salon', phone: P2,
        resolved: { channel: { id: `chan-${BIZ}`, channel_type: 'dedicated', business_id: BIZ }, sender: { sendText: m.text, sendTemplate: m.template } } as never,
        form: { id: FORM, title: 'Guest list', description: null, token: 'tokA' },
        template: { name: 'feedback_request', category: 'marketing' }, eligibility: { eligible: true, basis: 'window' },
      });
      expect(out).toEqual({ phone: P2, status: 'skipped', reason: 'no_consent' });
      expect(m.template).not.toHaveBeenCalled();
      expect(m.text).not.toHaveBeenCalled();
    });

    it('if the 24-hour check cannot be read, the person is skipped as check_failed and nothing is sent', async () => {
      m.db.failReads.add('whatsapp_inbound_receipts');
      const data = await sendTo([P2], { templateName: 'feedback_request' });
      expect(data.results).toEqual([{ phone: P2, status: 'skipped', reason: 'check_failed' }]);
      expect(m.text).not.toHaveBeenCalled();
      expect(m.template).not.toHaveBeenCalled();
    });

    it('Owner decision 2026-11-06: an earlier "No thanks" does not block a reply inside the window', async () => {
      m.db.tables.customer_consents.push(consent(P2, { status: 'revoked', created_at: new Date().toISOString() }));
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(12)));
      const data = await sendTo([P2], { templateName: 'feedback_request' });
      expect(data.results).toEqual([{ phone: P2, status: 'sent', via: 'text' }]);
      expect(m.template).not.toHaveBeenCalled();
    });
  });

  describe('on a shared number (many businesses share its receipts)', () => {
    beforeEach(() => {
      shared();
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P2, minutesAgo(30), SHARED));
    });

    it('a receipt alone is not enough: the person may have been talking to another business', async () => {
      m.db.tables.bot_sessions.push(session(P2, { business_id: OTHER }));
      expect((await sendTo([P2])).results).toEqual([{ phone: P2, status: 'skipped', reason: 'no_consent' }]);
      expect(m.text).not.toHaveBeenCalled();
    });

    it('sends text when this business’s own conversation on this number has their message from the last 24 hours', async () => {
      m.db.tables.bot_sessions.push(session(P2));
      expect((await sendTo([P2], { templateName: 'feedback_request' })).results).toEqual([{ phone: P2, status: 'sent', via: 'text' }]);
      expect(m.template).not.toHaveBeenCalled();
    });

    it.each([
      ['on another channel', { session_data: { _inbound_channel_id: 'chan-elsewhere' } }, minutesAgo(30)],
      ['whose last customer message is older than 24 hours', {}, dayAgo()],
      ['with only bot messages', { conversation_log: [{ role: 'bot', content: 'Hi', timestamp: minutesAgo(10) }] }, minutesAgo(10)],
    ])('does not count this business’s conversation %s', async (_l, extra, at) => {
      m.db.tables.bot_sessions.push(session(P2, extra, at));
      expect((await sendTo([P2])).results).toEqual([{ phone: P2, status: 'skipped', reason: 'no_consent' }]);
    });

    it('needs the provider receipt too, not only the conversation', async () => {
      m.db.tables.whatsapp_inbound_receipts = [];
      m.db.tables.bot_sessions.push(session(P2));
      expect((await sendTo([P2])).results).toEqual([{ phone: P2, status: 'skipped', reason: 'no_consent' }]);
    });

    it('at send time the window is re-checked against this business’s own conversation, not the receipt alone', async () => {
      const { deliverInvite } = await import('@/lib/forms/form-send');
      // The receipt is still there, but this business's conversation no longer shows a recent customer message.
      const out = await deliverInvite({
        db: m.db as never, businessId: BIZ, businessName: 'Ada Salon', phone: P2,
        resolved: { channel: { id: SHARED, channel_type: 'shared', business_id: null }, sender: { sendText: m.text, sendTemplate: m.template } } as never,
        form: { id: FORM, title: 'Guest list', description: null, token: 'tokA' },
        template: null, eligibility: { eligible: true, basis: 'window' },
      });
      expect(out).toEqual({ phone: P2, status: 'skipped', reason: 'no_consent' });
      expect(m.text).not.toHaveBeenCalled();
    });

    it('if this business’s conversations cannot be read, the person is skipped as check_failed', async () => {
      m.db.tables.bot_sessions.push(session(P2));
      m.db.failReads.add('bot_sessions');
      expect((await sendTo([P2])).results).toEqual([{ phone: P2, status: 'skipped', reason: 'check_failed' }]);
      expect(m.text).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/forms/recipients — recentChats', () => {
    const get = async () => (await contacts(new NextRequest(`https://example.test/api/forms/recipients?businessId=${BIZ}`)));

    it('lists people who messaged this business’s own number in the last 24 hours, newest first, without opt-outs', async () => {
      dedicated();
      m.db.tables.whatsapp_inbound_receipts.push(
        receipt(P1, minutesAgo(90)), receipt(P1, minutesAgo(200)),
        receipt(P2, minutesAgo(10)),
        receipt(P3, minutesAgo(20)),
        receipt('+2348034444444', dayAgo()),
        receipt('+2348035555555', minutesAgo(5), 'chan-other'),
      );
      m.db.tables.messaging_opt_outs.push({ phone: P3.slice(1), business_id: null, channel: 'whatsapp', resubscribed_at: null });
      m.db.tables.customer_profiles.push({ business_id: BIZ, phone: P2, name: 'Bola' }, { business_id: OTHER, phone: P1, name: 'Not mine' });
      const res = await get();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.contacts).toEqual([]);
      expect(data.recentChats.map((c: { phone: string; name: string | null }) => [c.phone, c.name])).toEqual([[P2, 'Bola'], [P1, null]]);
      expect(Date.parse(data.recentChats[1].lastMessageAt)).toBeGreaterThan(Date.now() - 91 * 60_000);
      expect(data.recentChatsTruncated).toBe(false);
    });

    it('on a shared number lists only people in this business’s own conversations who also have a receipt', async () => {
      shared();
      m.db.tables.whatsapp_inbound_receipts.push(receipt(P1, minutesAgo(15), SHARED), receipt(P2, minutesAgo(15), SHARED), receipt(P3, minutesAgo(15), SHARED));
      m.db.tables.bot_sessions.push(
        session(P1),
        session(P2, { business_id: OTHER }),
        // P3 messaged the shared number, but this business has no conversation with them.
        session('+2348036666666'), // conversation but no receipt
      );
      const data = await (await get()).json();
      expect(data.recentChats.map((c: { phone: string }) => c.phone)).toEqual([P1]);
    });

    it('is owner-only, and a failure on this list does not hide the opted-in contacts', async () => {
      m.user = null;
      expect((await get()).status).toBe(401);
      m.user = { id: 'owner-b' };
      expect((await get()).status).toBe(403);
      m.user = { id: 'owner-a' };
      dedicated();
      m.db.tables.customer_consents.push(consent(P1));
      m.db.failReads.add('whatsapp_inbound_receipts');
      const data = await (await get()).json();
      expect(data).toMatchObject({ contacts: [{ phone: P1, name: null }], recentChats: [], recentChatsUnavailable: true });
    });
  });
});

describe('network isolation', () => {
  it('made no network calls', () => { expect(net.state.attempts).toBe(0); });
});
