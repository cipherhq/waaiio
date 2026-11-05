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
        channel: { id: `chan-${businessId}` },
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

  it('skips a recipient with no recorded consent, even inside the 24-hour window', async () => {
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
    expect(m.db.tables.notifications[0]).toMatchObject({ status: 'failed', failed_reason: expect.stringContaining('did not accept') });
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
    expect(await res.json()).toEqual({ contacts: [{ phone: P1, name: 'Ada' }], truncated: false });
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

  it('records WhatsApp marketing consent for this business through the existing consent store when ticked', async () => {
    m.db.tables.forms[0].settings = { marketing_opt_in: true };
    const res = await submit(post('/api/forms/submit', submitBody({ marketing_opt_in: true, customer_phone: '0803 222 2222' })));
    expect(await res.json()).toEqual({ success: true, optInRecorded: true });
    expect(consents()).toEqual([expect.objectContaining({ kind: 'insert', row: expect.objectContaining({
      business_id: BIZ, phone: P2, channel: 'whatsapp', purpose: 'marketing', status: 'granted', source: 'website', evidence_reference: `form:${FORM}`,
    }) })]);
    expect(m.db.tables.form_responses[0]).toMatchObject({ consent_given: true });
    // The person can now be sent a form.
    m.db.tables.whatsapp_inbound_receipts.push({ channel_id: `chan-${BIZ}`, sender_phone: P2.slice(1), provider_timestamp: hourAgo() });
    const sent = await (await send(post('/api/forms/send', sendBody({ phone: P2 })))).json();
    expect(sent.results[0]).toEqual({ phone: P2, status: 'sent', via: 'text' });
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

describe('network isolation', () => {
  it('made no network calls', () => { expect(net.state.attempts).toBe(0); });
});
