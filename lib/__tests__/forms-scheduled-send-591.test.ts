/**
 * #591 PR C — scheduled form sends.
 *
 * Real route handlers and the real consent helper run against the in-memory
 * table store (filters applied for real). Only the auth session, cron auth, the
 * WhatsApp channel and the provider are stubbed. All network egress is denied.
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
  text: vi.fn(), template: vi.fn(), getTemplates: vi.fn(), cronAuth: vi.fn(),
  conv: { allowed: true, used: 0, limit: 100 },
  channel: true,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) }, from: (t: string) => m.db.from(t) }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t) }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: m.cronAuth }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => m.conv }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId(businessId: string) {
      if (!m.channel) return null;
      return { channel: { id: `chan-${businessId}` }, cloud: { getTemplates: m.getTemplates }, sender: { sendText: m.text, sendTemplate: m.template } };
    }
  },
}));

import { POST as send } from '@/app/api/forms/send/route';
import { GET as listSends, DELETE as cancelSend } from '@/app/api/forms/sends/route';
import { GET as cron } from '@/app/api/cron/scheduled-form-sends/route';

const BIZ = 'biz-a';
const OTHER = 'biz-b';
const FORM = '33333333-3333-4333-a333-333333333333';
const P1 = '+2348031111111';
const P2 = '+2348032222222';
const P3 = '+2348033333333';
const consent = (phone: string, extra: Record<string, unknown> = {}) => ({
  business_id: BIZ, phone, channel: 'whatsapp', purpose: 'marketing', status: 'granted', expires_at: null,
  created_at: new Date(Date.now() - 60_000).toISOString(), ...extra,
});
const template = (over: Record<string, unknown> = {}) => ({
  name: 'feedback_request', status: 'APPROVED', category: 'MARKETING', language: 'en_US',
  components: [{ type: 'BODY', text: '{{1}} would like your feedback!\n\n{{2}}' }], ...over,
});
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();
const post = (body: unknown) => new NextRequest('https://example.test/api/forms/send', { method: 'POST', body: JSON.stringify(body) });
const tick = () => cron(new NextRequest('https://example.test/api/cron/scheduled-form-sends'));
const sendRow = () => m.db.tables.form_sends[0];
/** Make every scheduled send due now. */
const makeDue = () => { for (const r of m.db.tables.form_sends) r.scheduled_at = new Date(Date.now() - 1000).toISOString(); };

beforeEach(() => {
  vi.clearAllMocks();
  net.state.attempts = 0;
  m.user = { id: 'owner-a' };
  m.conv = { allowed: true, used: 0, limit: 100 };
  m.channel = true;
  m.cronAuth.mockReturnValue(null);
  m.text.mockResolvedValue({ success: true, messageId: 'w-text' });
  m.template.mockResolvedValue({ success: true, messageId: 'w-tpl' });
  m.getTemplates.mockResolvedValue({ data: [template()] });
  m.db = createMemoryDb({
    businesses: [
      { id: BIZ, owner_id: 'owner-a', name: 'Ada Salon', country_code: 'NG' },
      { id: OTHER, owner_id: 'owner-b', name: 'Other', country_code: 'NG' },
    ],
    forms: [
      { id: FORM, business_id: BIZ, title: 'Guest list', description: null, token: 'tokA', is_active: true, settings: {} },
      { id: 'form-b', business_id: OTHER, title: 'B', description: null, token: 'tokB', is_active: true, settings: {} },
    ],
    customer_consents: [consent(P1), consent(P2)],
    messaging_opt_outs: [], whatsapp_inbound_receipts: [], notifications: [], form_responses: [], form_sends: [],
  });
});

describe('scheduling a form send', () => {
  it('stores only people who have opted in now and reports who was skipped', async () => {
    const res = await send(post({ formId: FORM, businessId: BIZ, phones: [P1, P2, P3, 'nope'], templateName: 'feedback_request', scheduledAt: inAnHour() }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ scheduled: true, recipients: 2, skipped: 2 });
    expect(data.results).toEqual([
      { phone: 'nope', status: 'skipped', reason: 'invalid_phone' },
      { phone: P3, status: 'skipped', reason: 'no_consent' },
    ]);
    expect(sendRow()).toMatchObject({
      business_id: BIZ, form_id: FORM, created_by: 'owner-a', status: 'scheduled',
      recipients: [P1, P2], template_name: 'feedback_request', skipped_count: 2,
    });
    expect(m.text).not.toHaveBeenCalled();
    expect(m.template).not.toHaveBeenCalled();
    expect(m.db.tables.form_responses).toEqual([]);
  });

  it('refuses to schedule when nobody has opted in', async () => {
    const res = await send(post({ formId: FORM, businessId: BIZ, phones: [P3], scheduledAt: inAnHour() }));
    expect(res.status).toBe(400);
    expect(m.db.tables.form_sends).toEqual([]);
  });

  it.each([
    ['in the past', new Date(Date.now() - 60_000).toISOString()],
    ['too soon', new Date(Date.now() + 10_000).toISOString()],
    ['too far ahead', new Date(Date.now() + 91 * 24 * 60 * 60_000).toISOString()],
    ['not a date', 'tomorrow'],
  ])('refuses a time that is %s', async (_l, at) => {
    expect((await send(post({ formId: FORM, businessId: BIZ, phones: [P1], scheduledAt: at }))).status).toBe(400);
    expect(m.db.tables.form_sends).toEqual([]);
  });

  it('caps how many sends one business can have waiting', async () => {
    for (let i = 0; i < 20; i++) m.db.tables.form_sends.push({ business_id: BIZ, form_id: FORM, status: 'scheduled', recipients: [P1], scheduled_at: inAnHour() });
    const res = await send(post({ formId: FORM, businessId: BIZ, phones: [P1], scheduledAt: inAnHour() }));
    expect(res.status).toBe(429);
    expect(m.db.tables.form_sends).toHaveLength(20);
  });

  it('cannot schedule another business’s form', async () => {
    expect((await send(post({ formId: 'form-b', businessId: BIZ, phones: [P1], scheduledAt: inAnHour() }))).status).toBe(404);
    m.user = { id: 'owner-b' };
    expect((await send(post({ formId: FORM, businessId: BIZ, phones: [P1], scheduledAt: inAnHour() }))).status).toBe(403);
    expect(m.db.tables.form_sends).toEqual([]);
  });
});

describe('the scheduled-sends cron', () => {
  async function schedule(extra: Record<string, unknown> = {}) {
    await send(post({ formId: FORM, businessId: BIZ, phones: [P1, P2], templateName: 'feedback_request', scheduledAt: inAnHour(), ...extra }));
    makeDue();
  }

  it('requires cron authorization', async () => {
    m.cronAuth.mockReturnValue(new Response('no', { status: 401 }));
    expect((await tick()).status).toBe(401);
  });

  it('does nothing before the send time', async () => {
    await send(post({ formId: FORM, businessId: BIZ, phones: [P1], templateName: 'feedback_request', scheduledAt: inAnHour() }));
    expect(await (await tick()).json()).toEqual({ processed: 0 });
    expect(sendRow().status).toBe('scheduled');
  });

  it('sends when due and records honest per-recipient results', async () => {
    await schedule();
    expect(await (await tick()).json()).toEqual({ processed: 1 });
    expect(m.template).toHaveBeenCalledTimes(2);
    expect(sendRow()).toMatchObject({ status: 'sent', sent_count: 2, failed_count: 0, skipped_count: 0, error_message: null });
    expect(sendRow().results).toEqual([
      { phone: P1, status: 'sent', via: 'template' },
      { phone: P2, status: 'sent', via: 'template' },
    ]);
  });

  it('checks consent again at send time: a revocation or opt-out after scheduling is honoured', async () => {
    await schedule();
    m.db.tables.customer_consents.push(consent(P1, { status: 'revoked', created_at: new Date().toISOString() }));
    m.db.tables.messaging_opt_outs.push({ phone: P2, business_id: BIZ, channel: 'whatsapp', resubscribed_at: null });
    await tick();
    expect(m.template).not.toHaveBeenCalled();
    expect(m.text).not.toHaveBeenCalled();
    expect(sendRow()).toMatchObject({ status: 'failed', sent_count: 0, skipped_count: 2, error_message: 'Nobody was eligible to receive it at send time' });
    expect(sendRow().results).toEqual([
      { phone: P1, status: 'skipped', reason: 'no_consent' },
      { phone: P2, status: 'skipped', reason: 'opted_out' },
    ]);
  });

  it('cancels instead of sending when the form was switched off', async () => {
    await schedule();
    m.db.tables.forms[0].is_active = false;
    await tick();
    expect(m.template).not.toHaveBeenCalled();
    expect(sendRow()).toMatchObject({ status: 'cancelled', error_message: expect.stringMatching(/switched off/) });
  });

  it('sends each due send once even when two runs overlap', async () => {
    await schedule();
    const [a, b] = await Promise.all([tick(), tick()]);
    const processed = (await a.json()).processed + (await b.json()).processed;
    expect(processed).toBe(1);
    expect(m.template).toHaveBeenCalledTimes(2);
  });

  it('a template that lost approval stops the whole send, like an immediate send would', async () => {
    await schedule();
    m.getTemplates.mockResolvedValue({ data: [template({ status: 'PAUSED' })] });
    m.db.tables.whatsapp_inbound_receipts.push({ channel_id: `chan-${BIZ}`, sender_phone: P2.slice(1), provider_timestamp: new Date(Date.now() - 60_000).toISOString() });
    await tick();
    expect(m.template).not.toHaveBeenCalled();
    expect(m.text).not.toHaveBeenCalled();
    expect(sendRow()).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/no longer approved.*nothing was sent/) });
  });

  it('gives up on a template check that keeps failing for 2 hours, with nothing sent', async () => {
    await schedule();
    sendRow().scheduled_at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    m.getTemplates.mockRejectedValue(new Error('Session has expired'));
    await tick();
    expect(sendRow()).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/could not be checked for 2 hours/) });
    expect(m.template).not.toHaveBeenCalled();
  });

  it('takes turns: one business’s stuck sends cannot hold up another business', async () => {
    m.db.tables.forms.push({ id: 'form-b2', business_id: OTHER, title: 'B2', description: null, token: 'tokB2', is_active: true, settings: {} });
    for (let i = 0; i < 4; i++) {
      m.db.tables.form_sends.push({ id: `00000000-0000-4000-a000-00000000000${i}`, business_id: BIZ, form_id: FORM, template_name: 'feedback_request', recipients: [P1], status: 'scheduled', scheduled_at: new Date(Date.now() - 60_000 * (10 - i)).toISOString(), updated_at: new Date(Date.now() - 60_000 * (10 - i)).toISOString(), results: [], sent_count: 0, failed_count: 0, skipped_count: 0 });
    }
    m.db.tables.form_sends.push({ id: '00000000-0000-4000-a000-0000000000bb', business_id: OTHER, form_id: 'form-b2', template_name: null, recipients: ['+2348039999999'], status: 'scheduled', scheduled_at: new Date(Date.now() - 1000).toISOString(), updated_at: new Date(Date.now() - 1000).toISOString(), results: [], sent_count: 0, failed_count: 0, skipped_count: 0 });
    // Business A's WhatsApp account can't answer template checks.
    m.getTemplates.mockRejectedValue(new Error('Session has expired'));
    const res = await (await tick()).json();
    expect(res.processed).toBe(2); // one send per business per run
    const other = m.db.tables.form_sends.find(r => r.business_id === OTHER)!;
    expect(other.status).not.toBe('scheduled'); // reached in the very first run
    expect(m.db.tables.form_sends.filter(r => r.business_id === BIZ && r.status === 'scheduled')).toHaveLength(4);
  });

  it('when time runs out, the rest go back in the queue and are sent next run; nobody is dropped', async () => {
    const people = Array.from({ length: 7 }, (_, i) => `+234803111110${i}`);
    for (const p of people) m.db.tables.customer_consents.push(consent(p));
    await send(post({ formId: FORM, businessId: BIZ, phones: people, templateName: 'feedback_request', scheduledAt: inAnHour() }));
    makeDue();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    m.template.mockImplementation(async () => { if (m.template.mock.calls.length >= 5) offset = 45_000; return { success: true, messageId: 'w' }; });
    try {
      await tick();
      expect(sendRow()).toMatchObject({ status: 'scheduled', sent_count: 5, recipients: people.slice(5), error_message: 'Partly sent; 2 still to send' });
      expect((sendRow().results as unknown[])).toHaveLength(5);
      offset = 0;
      await tick();
    } finally { spy.mockRestore(); }
    expect(m.template).toHaveBeenCalledTimes(7);
    expect(sendRow()).toMatchObject({ status: 'sent', sent_count: 7, failed_count: 0, error_message: null });
    expect((sendRow().results as Array<{ phone: string }>).map(r => r.phone)).toEqual(people);
  });

  it('never overwrites a send whose state changed while it was being sent', async () => {
    await schedule();
    // e.g. marked interrupted by another run's sweep while this run was still sending.
    m.template.mockImplementation(async () => { sendRow().status = 'failed'; sendRow().error_message = 'changed elsewhere'; return { success: true, messageId: 'w' }; });
    await tick();
    expect(sendRow()).toMatchObject({ status: 'failed', error_message: 'changed elsewhere' });
    expect(sendRow().sent_count).toBeUndefined();
  });

    it('a send left in "sending" by a killed run is marked interrupted and never re-sent', async () => {
    await schedule();
    Object.assign(sendRow(), { status: 'sending', started_at: new Date(Date.now() - 11 * 60_000).toISOString() });
    await tick();
    expect(sendRow()).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/Interrupted.*check before sending again/) });
    expect(m.template).not.toHaveBeenCalled();
    // A recent "sending" row (another run still working on it) is left alone.
    Object.assign(sendRow(), { status: 'sending', started_at: new Date(Date.now() - 60_000).toISOString(), error_message: null });
    await tick();
    expect(sendRow().status).toBe('sending');
  });

  it('a template-check outage puts the send back in the queue with nothing sent', async () => {
    await schedule();
    m.getTemplates.mockRejectedValue(new Error('Meta down'));
    await tick();
    expect(m.template).not.toHaveBeenCalled();
    expect(m.text).not.toHaveBeenCalled();
    expect(sendRow()).toMatchObject({ status: 'scheduled', started_at: null, error_message: expect.stringMatching(/will retry/) });
    m.getTemplates.mockResolvedValue({ data: [template()] });
    await tick();
    expect(sendRow()).toMatchObject({ status: 'sent', sent_count: 2 });
  });

  it('a provider rejection is recorded as failed; nothing accepted means status failed', async () => {
    await schedule();
    m.template.mockRejectedValue(new Error('rejected'));
    await tick();
    expect(sendRow()).toMatchObject({ status: 'failed', sent_count: 0, failed_count: 2 });
  });

  it('fails without sending when the channel is gone or the conversation limit is reached', async () => {
    await schedule();
    m.channel = false;
    await tick();
    expect(sendRow()).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/channel/) });
    m.db.tables.form_sends = [];
    m.channel = true; m.conv = { allowed: false, used: 100, limit: 100 };
    await schedule();
    await tick();
    expect(sendRow()).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/conversation limit/) });
    expect(m.template).not.toHaveBeenCalled();
  });

  it('only sends through the form’s own business', async () => {
    await schedule();
    // A row whose form belongs to another business is never sent (the database also refuses it, M517).
    m.db.tables.form_sends[0].form_id = 'form-b';
    await tick();
    expect(m.template).not.toHaveBeenCalled();
    expect(sendRow().status).toBe('cancelled');
  });
});

describe('listing and cancelling sends', () => {
  const list = (businessId = BIZ) => listSends(new NextRequest(`https://example.test/api/forms/sends?businessId=${businessId}&formId=${FORM}`));
  const del = (id: string, businessId = BIZ) => cancelSend(new NextRequest('https://example.test/api/forms/sends', { method: 'DELETE', body: JSON.stringify({ id, businessId }) }));

  it('an immediate send is kept in the history too', async () => {
    m.db.tables.whatsapp_inbound_receipts.push({ channel_id: `chan-${BIZ}`, sender_phone: P1.slice(1), provider_timestamp: new Date(Date.now() - 60_000).toISOString() });
    await send(post({ formId: FORM, businessId: BIZ, phones: [P1, P3] }));
    const { sends } = await (await list()).json();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ status: 'sent', sent_count: 1, skipped_count: 1 });
  });

  it('the owner can cancel a scheduled send; it then never goes out', async () => {
    await send(post({ formId: FORM, businessId: BIZ, phones: [P1], templateName: 'feedback_request', scheduledAt: inAnHour() }));
    const id = sendRow().id as string;
    expect((await del(id)).status).toBe(200);
    expect(sendRow().status).toBe('cancelled');
    expect((await del(id)).status).toBe(409);
    makeDue();
    await tick();
    expect(m.template).not.toHaveBeenCalled();
  });

  it('rejects malformed ids', async () => {
    expect((await del('not-a-uuid')).status).toBe(400);
    expect((await listSends(new NextRequest(`https://example.test/api/forms/sends?businessId=${BIZ}&formId=nope`))).status).toBe(400);
  });

  it('another owner can neither see nor cancel the send', async () => {
    await send(post({ formId: FORM, businessId: BIZ, phones: [P1], scheduledAt: inAnHour() }));
    const id = sendRow().id as string;
    m.user = { id: 'owner-b' };
    expect((await list()).status).toBe(403);
    expect((await del(id)).status).toBe(403);
    // Using their own business id does not reach this business's row.
    expect((await del(id, OTHER)).status).toBe(409);
    expect(sendRow().status).toBe('scheduled');
  });
});

describe('network isolation', () => {
  it('made no network calls', () => { expect(net.state.attempts).toBe(0); });
});
