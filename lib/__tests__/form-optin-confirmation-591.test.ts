/**
 * #591 part B1 — confirming a web form "send me updates" tick on WhatsApp.
 *
 * Real routes (form submit, Meta webhook), the real confirmation handler and the real
 * permission gate (hasRecipientPermission) run against an in-memory table store that
 * applies filters for real. Only the channel resolver, the provider senders and the
 * bot are replaced. All network egress is denied. Phone numbers are fictional
 * (555-01xx range).
 */
import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

type AnyMock = Mock<(...args: any[]) => any>;

const net = vi.hoisted(() => {
  const original = globalThis.fetch;
  const state = { attempts: 0 };
  globalThis.fetch = (async () => { state.attempts++; throw new Error('NETWORK-DENY'); }) as typeof fetch;
  return { state, restore: () => { globalThis.fetch = original; } };
});
afterAll(() => net.restore());

const m = vi.hoisted(() => {
  const log: Record<string, unknown> = {};
  for (const k of ['error', 'warn', 'info', 'debug']) log[k] = () => undefined;
  log.withContext = () => log;
  return {
    log,
    db: null as unknown as MemoryDb,
    rpc: null as unknown as AnyMock,
    afterTasks: [] as Array<() => unknown>,
    afterThrows: false,
    /** Sending channel of each business (resolveByBusinessId). */
    channelFor: null as unknown as (businessId: string) => Record<string, unknown> | null,
    /** Channel the inbound webhook arrives on (resolveByPhoneNumberId). */
    inbound: null as unknown as Record<string, unknown>,
    sendButtons: null as unknown as AnyMock,
    sendTemplate: null as unknown as AnyMock,
    sendText: null as unknown as AnyMock,
    platformButtons: null as unknown as AnyMock,
    getTemplates: null as unknown as AnyMock,
    bot: null as unknown as AnyMock,
  };
});

vi.mock('next/server', async importOriginal => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: (task: () => unknown) => {
    if (m.afterThrows) throw new Error('`after` was called outside a request scope');
    m.afterTasks.push(task);
  },
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t), rpc: m.rpc }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: m.log, generateRequestId: () => 'req-test' }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId(businessId: string) {
      const channel = m.channelFor(businessId);
      return channel ? {
        channel, cloud: { getTemplates: m.getTemplates },
        sender: { sendText: m.sendText, sendButtons: m.sendButtons, sendTemplate: m.sendTemplate },
      } : null;
    }
    async resolveByPhoneNumberId() {
      return { channel: m.inbound, sender: { sendText: m.sendText, sendPlatformButtons: m.platformButtons, bindBusiness: () => undefined } };
    }
  },
}));
vi.mock('@/lib/bot/bot.service', () => ({ BotService: class { handleMessage = (...args: unknown[]) => m.bot(...args); } }));
vi.mock('@/lib/bot/bot-intelligence', () => ({ BotIntelligenceService: class {} }));
vi.mock('@/lib/bot/standalone.service', () => ({ StandaloneService: class {} }));

import { POST as submit } from '@/app/api/forms/submit/route';
import { POST as webhook } from '@/app/api/webhook/meta-cloud/route';
import {
  handleOptInConfirmation, hashOptInNonce, newOptInNonce, pendingEvidence, sendOptInConfirmationRequest,
} from '@/lib/consent/optin-confirmation';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';

const A = 'biz-a';
const B = 'biz-b';
const PHONE = '+12025550123';
const OTHER_PHONE = '+12025550188';
const SHARED = 'chan-shared';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const sharedChannel = { id: SHARED, phone_number: '12025550100', phone_number_id: 'pnid-shared', channel_type: 'shared', business_id: null, is_active: true, provider: 'meta_cloud' };
const dedicatedOf = (businessId: string) => ({ ...sharedChannel, id: `chan-ded-${businessId}`, phone_number: '12025550101', channel_type: 'dedicated', business_id: businessId });

const optInTemplate = (over: Record<string, unknown> = {}) => ({
  name: 'waaiio_updates_optin_v1', status: 'APPROVED', category: 'MARKETING', language: 'en',
  components: [
    { type: 'BODY', text: 'You asked {{1}} to send you updates on WhatsApp. Tap Yes to confirm. Reply STOP at any time to opt out.' },
    { type: 'FOOTER', text: 'Powered by Waaiio' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes, send updates' }, { type: 'QUICK_REPLY', text: 'No thanks' }] },
  ],
  ...over,
});

/** A pending confirmation request as the form submit records it. */
function seedRequest(businessId: string, nonce: string, ageMs = HOUR, phone = PHONE) {
  const row = {
    id: `req-${businessId}-${m.db.tables.customer_consents.length}`, business_id: businessId, phone,
    channel: 'whatsapp', purpose: 'marketing', status: 'pending', source: 'website',
    evidence_reference: pendingEvidence('form-x', nonce), policy_version: 'optin-v1', created_at: ago(ageMs),
  };
  m.db.tables.customer_consents.push(row);
  return row;
}
const optOut = (businessId: string | null, ageMs: number, phone = PHONE) => {
  const row = { id: `oo-${businessId}-${ageMs}`, phone, business_id: businessId, channel: 'whatsapp', opt_out_type: 'all', opted_out_at: ago(ageMs), resubscribed_at: null };
  m.db.tables.messaging_opt_outs.push(row);
  return row;
};
const reply = vi.fn();
const tap = (nonce: string, opts: { answer?: 'yes' | 'no'; from?: string; channel?: Record<string, unknown>; messageType?: string; text?: string } = {}) =>
  handleOptInConfirmation({
    db: m.db as never, provenance: 'verified_meta_webhook', from: (opts.from ?? PHONE).slice(1),
    text: opts.text ?? `optin_${opts.answer ?? 'yes'}:${nonce}`, messageType: opts.messageType ?? 'button',
    messageId: 'wamid.inbound', channel: (opts.channel ?? sharedChannel) as never, sendReply: reply,
  });
const consents = () => m.db.tables.customer_consents;
const granted = () => consents().filter(r => r.status === 'granted');
const lastReply = () => reply.mock.calls.at(-1)?.[0] as { body: string; buttons: Array<{ id: string }>; footer?: string };
const allowed = (businessId: string, purpose: 'marketing' | 'utility' = 'marketing') => hasRecipientPermission(m.db as never, businessId, PHONE, purpose);

beforeEach(() => {
  vi.clearAllMocks();
  net.state.attempts = 0;
  m.afterTasks = [];
  m.afterThrows = false;
  m.rpc = vi.fn(async (name: string) => (name === 'claim_webhook_event' ? { data: { claimed: true, claim_token: 'claim' }, error: null } : { data: null, error: null }));
  m.sendButtons = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.buttons' });
  m.sendTemplate = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.template' });
  m.sendText = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.text' });
  m.platformButtons = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.reply' });
  m.getTemplates = vi.fn().mockResolvedValue({ data: [] });
  m.bot = vi.fn().mockResolvedValue(undefined);
  m.channelFor = () => sharedChannel;
  m.inbound = sharedChannel;
  reply.mockResolvedValue(undefined);
  m.db = createMemoryDb({
    businesses: [
      { id: A, owner_id: 'owner-a', name: 'Test Shop', country_code: 'US', subscription_tier: 'free', is_whitelabel: false },
      { id: B, owner_id: 'owner-b', name: 'Other Shop', country_code: 'US', subscription_tier: 'free', is_whitelabel: false },
    ],
    forms: [{ id: 'form-a', business_id: A, token: 'tokA', is_active: true, fields: [], settings: { marketing_opt_in: true } }],
    form_responses: [],
    customer_consents: [],
    messaging_opt_outs: [],
    whatsapp_inbound_receipts: [],
  });
});

describe('confirmation handler: rows and the permission gate', () => {
  it('Yes writes granted marketing AND utility rows; the gate then allows both purposes', async () => {
    const nonce = newOptInNonce();
    const req = seedRequest(A, nonce);
    expect(await allowed(A)).toBe(false);
    expect(await tap(nonce)).toBe(true);
    const hash = hashOptInNonce(nonce);
    expect(granted()).toEqual([
      expect.objectContaining({ business_id: A, phone: PHONE, channel: 'whatsapp', purpose: 'marketing', status: 'granted', source: 'whatsapp', policy_version: 'optin-v1', expires_at: null, evidence_reference: `confirm:${hash}|req:${req.id}|wamid:wamid.inbound` }),
      expect.objectContaining({ business_id: A, purpose: 'utility', status: 'granted', source: 'whatsapp', expires_at: null }),
    ]);
    expect(granted().every(r => typeof r.granted_at === 'string')).toBe(true);
    expect(await allowed(A, 'marketing')).toBe(true);
    expect(await allowed(A, 'utility')).toBe(true);
    expect(lastReply()).toMatchObject({ body: expect.stringContaining("You're subscribed"), buttons: [{ id: 'menu', title: 'Main menu' }], footer: 'Powered by Waaiio.com' });
  });

  it('No appends revoked marketing and utility rows and the gate stays closed', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    expect(await tap(nonce, { answer: 'no' })).toBe(true);
    const revoked = consents().filter(r => r.status === 'revoked');
    expect(revoked.map(r => r.purpose)).toEqual(['marketing', 'utility']);
    expect(revoked.every(r => r.source === 'whatsapp' && typeof r.revoked_at === 'string')).toBe(true);
    expect(granted()).toEqual([]);
    expect(await allowed(A)).toBe(false);
    expect(lastReply().body).toContain('will not send you updates');
  });

  it('a request older than 30 days has expired: nothing is written', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce, 31 * DAY);
    expect(await tap(nonce)).toBe(true);
    expect(granted()).toEqual([]);
    expect(lastReply().body).toContain('expired');
  });

  it('a stale request (a newer record exists) grants nothing', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce, 2 * HOUR);
    consents().push({ id: 'newer', business_id: A, phone: PHONE, channel: 'whatsapp', purpose: 'marketing', status: 'revoked', source: 'manual', created_at: ago(HOUR) });
    expect(await tap(nonce)).toBe(true);
    expect(granted()).toEqual([]);
    expect(lastReply().body).toContain('expired');
  });

  it('a double tap is idempotent: one pair of grants, then "already subscribed"', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    await tap(nonce);
    await tap(nonce);
    expect(granted()).toHaveLength(2);
    expect(lastReply().body).toContain('already subscribed');
  });

  it('an unknown nonce is handled (never reaches the bot) and grants nothing', async () => {
    expect(await tap(newOptInNonce())).toBe(true);
    expect(granted()).toEqual([]);
    expect(lastReply().body).toContain('expired');
  });

  it('typed text is never accepted, and other payloads are not handled', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    expect(await tap(nonce, { messageType: 'text' })).toBe(false);
    expect(await tap(nonce, { text: 'YES' })).toBe(false);
    expect(await tap(nonce, { text: 'optin_yes:short' })).toBe(false);
    expect(granted()).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe('confirmation handler: cross-business isolation', () => {
  it('on a shared number, business A\'s nonce grants business A only', async () => {
    const nonceA = newOptInNonce();
    const nonceB = newOptInNonce();
    seedRequest(A, nonceA);
    seedRequest(B, nonceB);
    await tap(nonceA);
    expect(granted().map(r => r.business_id)).toEqual([A, A]);
    expect(await allowed(A)).toBe(true);
    expect(await allowed(B)).toBe(false);
  });

  it('the right nonce from a different phone is rejected', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    expect(await tap(nonce, { from: OTHER_PHONE })).toBe(true);
    expect(granted()).toEqual([]);
    expect(lastReply().body).toContain('expired');
  });

  it('a dedicated channel belonging to another business is rejected', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    expect(await tap(nonce, { channel: dedicatedOf(B) })).toBe(true);
    expect(granted()).toEqual([]);
  });

  it('a shared number that is not the business\'s sending number is rejected', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    m.channelFor = () => ({ ...sharedChannel, id: 'chan-shared-other' });
    await tap(nonce);
    expect(granted()).toEqual([]);
  });

  it('the business\'s own dedicated channel is accepted', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    await tap(nonce, { channel: dedicatedOf(A) });
    expect(await allowed(A)).toBe(true);
  });
});

describe('confirmation handler: STOP always wins', () => {
  it('a STOP sent after the request rejects the Yes', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce, 2 * HOUR);
    const stop = optOut(A, HOUR);
    await tap(nonce);
    expect(granted()).toEqual([]);
    expect(stop.resubscribed_at).toBeNull();
    expect(m.db.tables.messaging_opt_outs[0].resubscribed_at).toBeNull();
    expect(lastReply().body).toContain('unsubscribed');
  });

  it('a STOP sent before the request is cleared, for that business only', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce, HOUR);
    optOut(A, 2 * HOUR);
    optOut(B, 2 * HOUR);
    await tap(nonce);
    const [stopA, stopB] = m.db.tables.messaging_opt_outs;
    expect(typeof stopA.resubscribed_at).toBe('string');
    expect(stopB.resubscribed_at).toBeNull();
    expect(await allowed(A)).toBe(true);
  });

  it('a global STOP is never cleared and nothing is granted', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce, HOUR);
    optOut(null, 2 * HOUR);
    await tap(nonce);
    expect(m.db.tables.messaging_opt_outs[0].resubscribed_at).toBeNull();
    expect(granted()).toEqual([]);
    expect(await allowed(A)).toBe(false);
  });

  it('after a grant, a new STOP closes the gate again', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    await tap(nonce);
    expect(await allowed(A)).toBe(true);
    optOut(A, 0);
    expect(await allowed(A)).toBe(false);
    expect(await allowed(A, 'utility')).toBe(false);
  });
});

describe('form submit: pending request and confirmation send', () => {
  const post = (body: Record<string, unknown>) => submit(new NextRequest('https://example.test/api/forms/submit', {
    method: 'POST', body: JSON.stringify({ token: 'tokA', answers: {}, customer_phone: PHONE, marketing_opt_in: true, ...body }),
  }));
  const runAfter = () => Promise.all(m.afterTasks.splice(0).map(task => task()));
  const windowOpen = () => m.db.tables.whatsapp_inbound_receipts.push({ channel_id: SHARED, sender_phone: PHONE.slice(1), provider_timestamp: ago(HOUR) });
  const pending = () => consents().filter(r => r.status === 'pending');

  it('stores only the nonce hash; the nonce goes only in the message', async () => {
    windowOpen();
    const res = await post({});
    expect(await res.json()).toEqual({ success: true, optInPending: true });
    const [row] = pending();
    expect(row).toMatchObject({ business_id: A, phone: PHONE, status: 'pending', source: 'website', policy_version: 'optin-v1' });
    const hash = /^form:form-a\|confirm:([0-9a-f]{64})$/.exec(row.evidence_reference as string)?.[1];
    expect(hash).toBeTruthy();
    expect(m.sendButtons).not.toHaveBeenCalled(); // only after the response
    await runAfter();
    const sent = m.sendButtons.mock.calls[0][0];
    const nonce = /^optin_yes:(.+)$/.exec(sent.buttons[0].id)?.[1] as string;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashOptInNonce(nonce)).toBe(hash);
    expect(JSON.stringify(m.db.tables)).not.toContain(nonce);
  });

  it('inside the 24-hour window it sends free-form Yes/No buttons', async () => {
    windowOpen();
    await post({});
    await runAfter();
    expect(m.sendButtons).toHaveBeenCalledTimes(1);
    const sent = m.sendButtons.mock.calls[0][0];
    expect(sent).toMatchObject({ to: PHONE.slice(1), messageCategory: 'service', body: expect.stringContaining('Test Shop') });
    expect(sent.buttons.map((b: { title: string }) => b.title)).toEqual(['Yes, send updates', 'No thanks']);
    expect(sent.buttons[1].id).toMatch(/^optin_no:[A-Za-z0-9_-]{43}$/);
    expect(m.sendTemplate).not.toHaveBeenCalled();
  });

  it('outside the window, with the approved template, it sends the template with both payloads', async () => {
    m.getTemplates.mockResolvedValue({ data: [optInTemplate()] });
    await post({});
    await runAfter();
    expect(m.sendButtons).not.toHaveBeenCalled();
    expect(m.sendTemplate).toHaveBeenCalledTimes(1);
    const sent = m.sendTemplate.mock.calls[0][0];
    expect(sent).toMatchObject({
      to: PHONE.slice(1), templateName: 'waaiio_updates_optin_v1', languageCode: 'en',
      templateParams: ['Test Shop'], messageCategory: 'marketing', noRetry: true,
    });
    expect(sent.quickReplyPayloads).toHaveLength(2);
    expect(sent.quickReplyPayloads[0]).toMatch(/^optin_yes:[A-Za-z0-9_-]{43}$/);
    expect(sent.quickReplyPayloads[1]).toBe(sent.quickReplyPayloads[0].replace('optin_yes:', 'optin_no:'));
  });

  it('with no window and no approved template nothing is sent and the row stays pending', async () => {
    m.getTemplates.mockResolvedValue({ data: [optInTemplate({ status: 'PENDING' })] });
    await post({});
    await runAfter();
    expect(m.sendButtons).not.toHaveBeenCalled();
    expect(m.sendTemplate).not.toHaveBeenCalled();
    expect(pending()).toHaveLength(1);
    expect(net.state.attempts).toBe(0);
  });

  it('sends nothing to a number opted out of this business, or opted out globally', async () => {
    windowOpen();
    optOut(A, DAY);
    await post({});
    await runAfter();
    m.db.tables.messaging_opt_outs = [];
    m.db.tables.customer_consents = [];
    optOut(null, DAY);
    await post({});
    await runAfter();
    expect(m.sendButtons).not.toHaveBeenCalled();
  });

  it('caps requests per phone: 3 in the last 24 hours across businesses means no send', async () => {
    windowOpen();
    for (let i = 0; i < 3; i++) seedRequest(B, newOptInNonce(), (i + 1) * HOUR);
    await post({});
    await runAfter();
    expect(m.sendButtons).not.toHaveBeenCalled();
    expect(pending().filter(r => r.business_id === A)).toHaveLength(1);
  });

  it('two earlier requests (or older ones) still allow the send', async () => {
    windowOpen();
    seedRequest(B, newOptInNonce(), HOUR);
    seedRequest(B, newOptInNonce(), 2 * HOUR);
    seedRequest(B, newOptInNonce(), 25 * HOUR);
    await post({});
    await runAfter();
    expect(m.sendButtons).toHaveBeenCalledTimes(1);
  });

  it('caps requests per business at 200 a day', async () => {
    windowOpen();
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i < 200; i++) {
      consents().push({ id: `cap-${i}`, business_id: A, phone: `+1202555${String(1000 + i).slice(-4)}`, channel: 'whatsapp', purpose: 'marketing', status: 'pending', evidence_reference: `form:f|confirm:${'0'.repeat(64)}`, created_at: today.toISOString() });
    }
    await post({});
    await runAfter();
    expect(m.sendButtons).not.toHaveBeenCalled();
  });

  describe('re-ticking the box (Owner decision 2026-11-06: allow a fresh tick)', () => {
    const sentNonce = () => /^optin_yes:(.+)$/.exec(m.sendButtons.mock.calls.at(-1)?.[0].buttons[0].id)?.[1] as string;

    it('an expired request (over 30 days) is replaced: a new request goes out and the old nonce is stale', async () => {
      windowOpen();
      const oldNonce = newOptInNonce();
      seedRequest(A, oldNonce, 31 * DAY);
      await post({});
      await runAfter();
      expect(m.sendButtons).toHaveBeenCalledTimes(1);
      expect(pending()).toHaveLength(2);
      const newNonce = sentNonce();
      expect(newNonce).not.toBe(oldNonce);
      await tap(oldNonce);
      expect(granted()).toEqual([]);
      expect(lastReply().body).toContain('expired');
      await tap(newNonce);
      expect(await allowed(A)).toBe(true);
    });

    it('a pre-release tick (no confirm: hash) is replaced and a request goes out', async () => {
      windowOpen();
      consents().push({ id: 'legacy', business_id: A, phone: PHONE, channel: 'whatsapp', purpose: 'marketing', status: 'pending', source: 'website', evidence_reference: 'form:form-a', created_at: ago(HOUR) });
      await post({});
      await runAfter();
      expect(m.sendButtons).toHaveBeenCalledTimes(1);
      expect(pending()).toHaveLength(2);
    });

    it('a live request (30 days or less) stands: no new row, nothing sent', async () => {
      windowOpen();
      seedRequest(A, newOptInNonce(), 29 * DAY);
      const res = await post({});
      expect(await res.json()).toEqual({ success: true, optInPending: true });
      expect(m.afterTasks).toHaveLength(0);
      expect(pending()).toHaveLength(1);
      expect(m.sendButtons).not.toHaveBeenCalled();
    });

    it('a granted record stands: no new row, nothing sent', async () => {
      windowOpen();
      consents().push({ id: 'g', business_id: A, phone: PHONE, channel: 'whatsapp', purpose: 'marketing', status: 'granted', source: 'whatsapp', created_at: ago(HOUR) });
      const res = await post({});
      expect(await res.json()).toEqual({ success: true, optInPending: true });
      expect(m.afterTasks).toHaveLength(0);
      expect(consents()).toHaveLength(1);
      expect(m.sendButtons).not.toHaveBeenCalled();
    });

    it('after a "No thanks" (revoked), a new tick sends a new request', async () => {
      windowOpen();
      consents().push({ id: 'r', business_id: A, phone: PHONE, channel: 'whatsapp', purpose: 'marketing', status: 'revoked', source: 'whatsapp', created_at: ago(HOUR) });
      await post({});
      await runAfter();
      expect(m.sendButtons).toHaveBeenCalledTimes(1);
    });

    it('existing guards still apply to a re-tick (an opt-out means no send)', async () => {
      windowOpen();
      seedRequest(A, newOptInNonce(), 31 * DAY);
      optOut(A, DAY);
      await post({});
      await runAfter();
      expect(pending()).toHaveLength(2);
      expect(m.sendButtons).not.toHaveBeenCalled();
    });
  });

  it('a send failure never fails the submit', async () => {
    windowOpen();
    m.sendButtons.mockRejectedValue(new Error('provider down'));
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await runAfter()).toEqual([undefined]);
    expect(pending()).toHaveLength(1);
    // Even if scheduling itself fails, the response is still saved.
    m.afterThrows = true;
    m.db.tables.customer_consents = [];
    const again = await post({});
    expect(again.status).toBe(200);
    expect(m.db.tables.form_responses).toHaveLength(2);
  });

  it('the sender reports why it skipped (direct call)', async () => {
    const nonce = newOptInNonce();
    const row = seedRequest(A, nonce, 0);
    expect(await sendOptInConfirmationRequest(m.db as never, { businessId: A, phone: PHONE, requestId: row.id, nonce })).toBe('skipped_no_template');
    m.channelFor = () => null;
    expect(await sendOptInConfirmationRequest(m.db as never, { businessId: A, phone: PHONE, requestId: row.id, nonce })).toBe('skipped_no_channel');
  });
});

describe('Meta webhook: template quick replies and interactive buttons', () => {
  async function inbound(message: Record<string, unknown>) {
    const full = { id: `wamid.${Math.random()}`, from: PHONE.slice(1), timestamp: String(Math.floor(Date.now() / 1000) - 5), ...message };
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '12025550100', phone_number_id: 'pnid-shared' }, messages: [full] } }] }] });
    const sig = 'sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex');
    return webhook(new NextRequest('https://example.test/api/webhook/meta-cloud', { method: 'POST', body, headers: { 'x-hub-signature-256': sig } }));
  }
  beforeEach(() => { vi.stubEnv('META_APP_SECRET', 'test-secret'); });

  it('a template button with an optin_yes payload reaches the handler, not the bot', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    const res = await inbound({ type: 'button', button: { payload: `optin_yes:${nonce}`, text: 'Yes, send updates' } });
    expect(res.status).toBe(200);
    expect(m.bot).not.toHaveBeenCalled();
    expect(await allowed(A)).toBe(true);
    expect(m.platformButtons).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE.slice(1), body: expect.stringContaining("You're subscribed") }));
    expect(m.rpc).toHaveBeenCalledWith('complete_webhook_event', expect.anything());
  });

  it('other template buttons are still dropped', async () => {
    const res = await inbound({ type: 'button', button: { payload: 'promo_offer_click', text: 'Shop now' } });
    expect(res.status).toBe(200);
    expect(m.bot).not.toHaveBeenCalled();
    expect(m.platformButtons).not.toHaveBeenCalled();
    expect(consents()).toEqual([]);
    expect(m.rpc).toHaveBeenCalledWith('complete_webhook_event', expect.anything());
  });

  it('an interactive button_reply with an optin_ id also reaches the handler', async () => {
    const nonce = newOptInNonce();
    seedRequest(A, nonce);
    await inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `optin_no:${nonce}`, title: 'No thanks' } } });
    expect(m.bot).not.toHaveBeenCalled();
    expect(consents().filter(r => r.status === 'revoked')).toHaveLength(2);
  });

  it('ordinary interactive buttons still go to the bot', async () => {
    await inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'menu', title: 'Main menu' } } });
    expect(m.bot).toHaveBeenCalledTimes(1);
    expect(m.bot.mock.calls[0][1]).toBe('menu');
  });
});
