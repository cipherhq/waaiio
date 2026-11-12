import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateNativeFlowToken } from '@/lib/whatsapp-forms/flow-token';
import { compilePublication } from '@/lib/whatsapp-forms/publication';
import { handleNativeFormWebhook } from '@/lib/whatsapp-forms/webhook';
import { MetaCloudSender } from '@/lib/channels/message-sender';
import { CUSTOMER_DAILY_LIMIT_MESSAGE } from '@/lib/messaging/customer-message-guard';

// Owner decision 2026-11-12 (#988 review): native form messages get #536's
// per-customer protections. The real guard functions run against a fake
// database; only the provider send is stubbed.

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByBusinessId = mocks.resolve; } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/platformSettings', () => {
  const settings = { customer_daily_reply_limit: 50, customer_daily_reply_limit_max: 500, customer_repeat_message_limit: 3, abuse_cooldown_soft_minutes: 5 };
  return { getPlatformSettingsSync: () => settings, loadPlatformSettings: async () => settings };
});

const formId = '11111111-1111-4111-8111-111111111111';
const businessId = '22222222-2222-4222-8222-222222222222';
const channelId = '33333333-3333-4333-8333-333333333333';
const publicationId = '44444444-4444-4444-8444-444444444444';
const responseId = '55555555-5555-4555-8555-555555555555';
const phone = '447700900000';
const phoneNumberId = '123456789';
const compiled = compilePublication({ title: 'Program signup', fields: [{ id: 'name', label: 'Name', type: 'text', required: true }] });
const publication = { id: publicationId, form_id: formId, business_id: businessId, channel_id: channelId,
  phone_number_id: phoneNumberId, waba_id: '987654321', meta_flow_id: '123123123', status: 'published', ...compiled, flow_json: compiled.flowJson };

let outcomes: Record<string, any>;
let rpcResults: Record<string, { data: unknown; error: unknown }>;
let rpc: ReturnType<typeof vi.fn>;
let sender: any;

function fakeDb(): SupabaseClient {
  rpc = vi.fn(async (name: string) => rpcResults[name] ?? { data: null, error: null });
  return { rpc, from(table: string) {
    const q: any = {};
    for (const op of ['select', 'eq', 'is', 'in', 'or', 'gte', 'lte', 'order', 'limit', 'update']) q[op] = () => q;
    q.maybeSingle = () => Promise.resolve(outcomes[table]);
    q.then = (yes: any, no: any) => Promise.resolve(outcomes[table]).then(yes, no);
    return q;
  } } as unknown as SupabaseClient;
}

/** A MetaCloudSender instance (so the guard installs) whose provider calls are stubbed.
 * Like the real sender, every business-paid send asks the installed guard first. */
function guardedFakeSender() {
  const s: any = Object.create(MetaCloudSender.prototype);
  s.bindBusiness = vi.fn((id: string) => { s.boundBusiness = id; });
  const paid = (name: string) => vi.fn(async (msg: { to: string }) => {
    if (s.customerReplyGuard && s.boundBusiness) await s.customerReplyGuard(s.boundBusiness, msg.to);
    return { success: true, messageId: `wamid.${name}` };
  });
  s.sendFlow = paid('flow');
  s.sendText = paid('text');
  s.sendButtons = paid('buttons');
  s.enterPlatformDiscovery = vi.fn(() => { s.boundBusiness = undefined; });
  s.sendPlatformText = vi.fn().mockResolvedValue({ success: true });
  return s;
}

const entry = () => ({ id: 'wamid.entry', text: { body: 'waaiio_form:abcdefgh' }, timestamp: String(Math.floor(Date.now() / 1000)) });
const submission = () => ({ interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ name: 'Ada',
  flow_token: generateNativeFlowToken({ formId, businessId, publicationId, channelId, phoneNumberId, assetId: publication.meta_flow_id, revision: compiled.revision, phone }).token }) } } });
const run = (message: any, db: SupabaseClient) => handleNativeFormWebhook({ db, message, phone, channelId, phoneNumberId, guardSender: s => s });

let db: SupabaseClient;
beforeEach(() => {
  vi.stubEnv('FLOW_TOKEN_SECRET', 'x'.repeat(64));
  vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED', 'true');
  outcomes = {
    forms: { data: { ...compiled.config, id: formId, business_id: businessId, is_active: true }, error: null },
    native_form_publications: { data: publication, error: null },
    form_responses: { data: { id: responseId }, error: null },
    messaging_opt_outs: { count: 0, error: null },
    businesses: { data: { status: 'active', metadata: {} }, error: null },
    blocked_phones: { count: 0, error: null },
    whatsapp_inbound_receipts: { data: { message_id: 'wamid.entry', provider_timestamp: new Date().toISOString() }, error: null },
    bot_sessions: { data: null, error: null },
  };
  rpcResults = {
    save_native_form_response_591: { data: { response_id: responseId, duplicate: false }, error: null },
    record_customer_inbound: { data: { repeat_count: 1, paused: false }, error: null },
    record_customer_daily_reply: { data: { over_limit: false }, error: null },
    claim_customer_daily_limit_notice: { data: true, error: null },
  };
  db = fakeDb();
  sender = guardedFakeSender();
  mocks.resolve.mockResolvedValue({ channel: { id: channelId, phone_number_id: phoneNumberId, waba_id: publication.waba_id, channel_type: 'shared' },
    sender, cloud: { nativeFlowAssets: () => ({ status: vi.fn().mockResolvedValue({ status: 'PUBLISHED', wabaId: publication.waba_id }) }) } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('native form entry send (#536 protections)', () => {
  it('records the entry text through the shared pause/repeat check and counts the form send', async () => {
    expect(await run(entry(), db)).toEqual({ retry: false });
    expect(rpc).toHaveBeenCalledWith('record_customer_inbound', expect.objectContaining({ p_phone: phone, p_text_hash: expect.any(String) }));
    expect(rpc).toHaveBeenCalledWith('record_customer_daily_reply', expect.objectContaining({ p_business_id: businessId, p_phone: phone }));
    expect(sender.sendFlow).toHaveBeenCalledTimes(1);
    expect(sender.customerReplyGuard).toBeUndefined(); // cleared by finish()
  });

  it('a paused customer gets no form, and is told once for free', async () => {
    rpcResults.record_customer_inbound = { data: { paused: true, cooldown_until: new Date(Date.now() + 4 * 60_000).toISOString(), cooldown_notice_due: true }, error: null };
    expect(await run(entry(), db)).toEqual({ retry: false });
    expect(sender.sendFlow).not.toHaveBeenCalled();
    expect(sender.sendPlatformText).toHaveBeenCalledWith({ to: phone, text: expect.stringContaining('You can message again in') });
  });

  it('a repeated entry text gets no form and no notice', async () => {
    rpcResults.record_customer_inbound = { data: { repeat_count: 4, paused: false }, error: null };
    expect(await run(entry(), db)).toEqual({ retry: false });
    expect(sender.sendFlow).not.toHaveBeenCalled();
    expect(sender.sendPlatformText).not.toHaveBeenCalled();
  });

  it('over the daily limit the form send is refused and today\'s notice is sent', async () => {
    rpcResults.record_customer_daily_reply = { data: { over_limit: true }, error: null };
    expect(await run(entry(), db)).toEqual({ retry: false });
    await expect(sender.sendFlow.mock.results[0].value).rejects.toThrow(/Financial authorization denied/);
    expect(sender.sendPlatformText).toHaveBeenCalledWith({ to: phone, text: CUSTOMER_DAILY_LIMIT_MESSAGE });
    expect(sender.customerReplyGuard).toBeUndefined();
  });

  it('fails open when the guard store is unavailable', async () => {
    rpcResults.record_customer_inbound = { data: null, error: { message: 'down' } };
    rpcResults.record_customer_daily_reply = { data: null, error: { message: 'down' } };
    expect(await run(entry(), db)).toEqual({ retry: false });
    expect(sender.sendFlow).toHaveBeenCalledTimes(1);
    await expect(sender.sendFlow.mock.results[0].value).resolves.toEqual(expect.objectContaining({ success: true }));
  });
});

describe('native form submission receipt (#536 protections)', () => {
  it('counts the receipt toward the daily limit', async () => {
    expect(await run(submission(), db)).toEqual({ retry: false });
    expect(sender.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Your information has been received. Thank you.' }));
    expect(rpc).toHaveBeenCalledWith('record_customer_daily_reply', expect.objectContaining({ p_business_id: businessId }));
    expect(sender.customerReplyGuard).toBeUndefined();
  });

  it('a paused customer keeps the saved response but gets no receipt', async () => {
    rpcResults.record_customer_inbound = { data: { paused: true, cooldown_until: new Date(Date.now() + 60_000).toISOString(), cooldown_notice_due: false }, error: null };
    expect(await run(submission(), db)).toEqual({ retry: false });
    expect(rpc).toHaveBeenCalledWith('save_native_form_response_591', expect.anything());
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendButtons).not.toHaveBeenCalled();
  });

  it('over the daily limit the receipt is refused and today\'s notice is sent', async () => {
    rpcResults.record_customer_daily_reply = { data: { over_limit: true }, error: null };
    expect(await run(submission(), db)).toEqual({ retry: false });
    await expect(sender.sendText.mock.results[0].value).rejects.toThrow(/Financial authorization denied/);
    expect(sender.sendPlatformText).toHaveBeenCalledWith({ to: phone, text: CUSTOMER_DAILY_LIMIT_MESSAGE });
  });
});
