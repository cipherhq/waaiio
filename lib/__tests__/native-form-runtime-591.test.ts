import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateNativeFlowToken, authenticateNativeFlowToken } from '@/lib/whatsapp-forms/flow-token';
import { compilePublication } from '@/lib/whatsapp-forms/publication';
import { captureNativeResponse, NativePersistenceError, sendNativeForm } from '@/lib/whatsapp-forms/runtime';
import { handleNativeFormWebhook } from '@/lib/whatsapp-forms/webhook';

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByBusinessId = mocks.resolve; } }));
const formId = '11111111-1111-4111-8111-111111111111';
const businessId = '22222222-2222-4222-8222-222222222222';
const channelId = '33333333-3333-4333-8333-333333333333';
const publicationId = '44444444-4444-4444-8444-444444444444';
const responseId = '55555555-5555-4555-8555-555555555555';
const phone = '447700900000';
const phoneNumberId = '123456789';
const compiled = compilePublication({ title: 'Program signup', fields: [
  { id: 'name', label: 'Name', type: 'text', required: true },
  { id: 'choice', label: 'Session', type: 'select', options: ['Morning', 'Evening'] },
], settings: { consent_label: 'Request WhatsApp updates' } });
const publication = { id: publicationId, form_id: formId, business_id: businessId, channel_id: channelId,
  phone_number_id: phoneNumberId, waba_id: '987654321', meta_flow_id: '123123123', status: 'published', ...compiled, flow_json: compiled.flowJson };
const claims = { formId, businessId, publicationId, channelId, phoneNumberId, assetId: publication.meta_flow_id, revision: compiled.revision, phone };
let resolved: any;
let db: SupabaseClient;
let outcomes: Record<string, any>;
let rpc: ReturnType<typeof vi.fn>;
let queries: Array<{ table: string; op: string; args: unknown[] }>;
function fakeDb() {
  rpc = vi.fn().mockResolvedValue({ data: { response_id: responseId, duplicate: false }, error: null });
  return { rpc, from(table: string) {
    const q: any = {};
    for (const op of ['select', 'eq', 'is', 'in', 'or', 'gte', 'lte', 'order', 'limit', 'update']) q[op] = (...args: unknown[]) => { queries.push({ table, op, args }); return q; };
    q.maybeSingle = () => Promise.resolve(outcomes[table]);
    q.then = (yes: any, no: any) => Promise.resolve(outcomes[table]).then(yes, no);
    return q;
  } } as unknown as SupabaseClient;
}
function message(answers: Record<string, unknown> = { name: 'Ada', choice: 'option_2', _marketing_consent: true }) {
  return { interactive: { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ ...answers, flow_token: generateNativeFlowToken(claims).token }) } } };
}
beforeEach(() => {
  vi.stubEnv('FLOW_TOKEN_SECRET', 'x'.repeat(64));
  vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED', 'true');
  queries = [];
  outcomes = {
    forms: { data: { ...compiled.config, id: formId, business_id: businessId, is_active: true }, error: null },
    native_form_publications: { data: publication, error: null },
    form_responses: { data: { id: responseId }, error: null },
    messaging_opt_outs: { count: 0, error: null },
    businesses: { data: { status: 'active', metadata: {} }, error: null },
    blocked_phones: { count: 0, error: null },
    whatsapp_inbound_receipts: { data: { provider_timestamp: new Date().toISOString() }, error: null },
    bot_sessions: { data: [], error: null },
  };
  db = fakeDb();
  resolved = { channel: { id: channelId, phone_number_id: phoneNumberId, waba_id: publication.waba_id, channel_type: 'shared' },
    sender: { bindBusiness: vi.fn(), sendFlow: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.flow' }), sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.ack' }) },
    cloud: { nativeFlowAssets: () => ({ status: vi.fn().mockResolvedValue({ status: 'PUBLISHED', wabaId: publication.waba_id }) }) } };
  mocks.resolve.mockResolvedValue(resolved);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('Native v2 token authority', () => {
  it('authenticates tenant only after signature and inbound transport checks', () => {
    const t = generateNativeFlowToken(claims).token;
    expect(authenticateNativeFlowToken(t, phone, channelId, phoneNumberId)?.businessId).toBe(businessId);
    expect(authenticateNativeFlowToken(t, '15555555555', channelId, phoneNumberId)).toBeNull();
    expect(authenticateNativeFlowToken(t, phone, formId, phoneNumberId)).toBeNull();
    expect(authenticateNativeFlowToken(t, phone, channelId, '999')).toBeNull();
    expect(authenticateNativeFlowToken(`${t.slice(0, -6)}abcdef`, phone, channelId, phoneNumberId)).toBeNull();
  });
  it('rejects expiration and malformed/legacy tokens', () => {
    vi.useFakeTimers();
    const t = generateNativeFlowToken(claims).token;
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(authenticateNativeFlowToken(t, phone, channelId, phoneNumberId)).toBeNull();
    vi.useRealTimers();
    expect(authenticateNativeFlowToken('legacy.signature', phone, channelId, phoneNumberId)).toBeNull();
  });
  it('uses a stable JSONB-safe full configuration revision', () => {
    expect(compilePublication({ ...compiled.config, settings: { consent_label: 'Request WhatsApp updates' } }).revision).toBe(compiled.revision);
    expect(compilePublication({ ...compiled.config, title: 'Changed' }).revision).not.toBe(compiled.revision);
    expect(compilePublication({ ...compiled.config, settings: { event_id: formId } }).revision).not.toBe(compiled.revision);
  });
});

describe('Native capture authority', () => {
  it('captures normalized answers once through atomic RPC, binding phone from transport', async () => {
    const result = await captureNativeResponse(db, message(), phone, { channelId, phoneNumberId });
    expect(result?.responseId).toBe(responseId);
    expect(rpc).toHaveBeenCalledWith('save_native_form_response_591', expect.objectContaining({ p_phone: phone, p_business_id: businessId,
      p_publication_id: publicationId, p_answers: { name: 'Ada', choice: 'Evening' }, p_consent: true }));
    expect(queries.filter(q => q.op === 'update')).toHaveLength(0);
  });
  it.each(['wrong channel', 'wrong asset', 'wrong revision', 'wrong account'])('rejects %s before response persistence', async reason => {
    if (reason === 'wrong channel') mocks.resolve.mockResolvedValue({ ...resolved, channel: { ...resolved.channel, id: formId } });
    else outcomes.native_form_publications.data = { ...publication, [reason === 'wrong asset' ? 'meta_flow_id' : reason === 'wrong revision' ? 'revision' : 'waba_id']: 'different' };
    expect(await captureNativeResponse(db, message(), phone, { channelId, phoneNumberId })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([{ choice: 'option_1' }, { name: 'Ada', injected: 'yes' }, { name: {} }, { name: 'Ada', choice: 'unknown' }])('rejects invalid answers %j', async answers => {
    expect(await captureNativeResponse(db, message(answers), phone, { channelId, phoneNumberId })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('keeps an otherwise valid response when an optional email is blank and email opt-in is checked', async () => {
    const c = compilePublication({ title: 'Signup', fields: [{ id: 'email', type: 'email', label: 'Email' }], settings: { email_marketing_opt_in: true } });
    outcomes.native_form_publications.data = { ...publication, config: c.config, revision: c.revision };
    const token = generateNativeFlowToken({ ...claims, revision: c.revision }).token;
    const reply = { interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: token, email: '', _email_consent: true }) } } };
    expect((await captureNativeResponse(db, reply, phone, { channelId, phoneNumberId }))?.responseId).toBe(responseId);
    expect(rpc).toHaveBeenCalledWith('save_native_form_response_591', expect.objectContaining({ p_email_consent: false }));
  });
  it('does not silently consume a persistence failure', async () => {
    rpc.mockResolvedValue({ error: { code: 'connection_failure' }, data: null });
    await expect(captureNativeResponse(db, message(), phone, { channelId, phoneNumberId })).rejects.toBeInstanceOf(NativePersistenceError);
  });
  it('returns duplicates as already persisted without another insert/count', async () => {
    rpc.mockResolvedValue({ data: { response_id: responseId, duplicate: true }, error: null });
    expect((await captureNativeResponse(db, message(), phone, { channelId, phoneNumberId }))?.duplicate).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('Native send and webhook lifecycle', () => {
  it('does not spend another business shared-number window for merchant initiated sends', async () => {
    const result = await sendNativeForm({ db, businessId, formId, phone, resolved });
    expect(result.sent).toBe(false);
    expect(resolved.sender.sendFlow).not.toHaveBeenCalled();
  });
  it('sends a signed form for a verified customer request through guarded sender once', async () => {
    expect((await sendNativeForm({ db, businessId, formId, phone, resolved, verifiedCustomerRequest: true })).sent).toBe(true);
    expect(resolved.sender.sendFlow).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true, messageCategory: 'service' }));
    const token = resolved.sender.sendFlow.mock.calls[0][0].flowToken;
    expect(authenticateNativeFlowToken(token, phone, channelId, phoneNumberId)?.publicationId).toBe(publicationId);
  });
  it('STOP blocks sends even on a customer request', async () => {
    outcomes.messaging_opt_outs.count = 1;
    expect((await sendNativeForm({ db, businessId, formId, phone, resolved, verifiedCustomerRequest: true })).sent).toBe(false);
    expect(resolved.sender.sendFlow).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'table block', 'legacy block'])('suppresses native sends and acknowledgements for %s', async reason => {
    if (reason === 'inactive') outcomes.businesses.data.status = 'suspended';
    if (reason === 'table block') outcomes.blocked_phones.count = 1;
    if (reason === 'legacy block') outcomes.businesses.data.metadata.blocked_phones = ['+' + phone];
    if (reason === 'block lookup failure') outcomes.blocked_phones.error = { message: 'Unavailable' };
    expect((await sendNativeForm({ db, businessId, formId, phone, resolved, verifiedCustomerRequest: true })).sent).toBe(false);
    expect(await handleNativeFormWebhook({ db, message: message(), phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: false });
    expect(resolved.sender.sendFlow).not.toHaveBeenCalled(); expect(resolved.sender.sendText).not.toHaveBeenCalled();
  });
  it('retries failed block and channel reads before any acknowledgement', async () => {
    outcomes.blocked_phones.error = { message: 'Unavailable' };
    expect(await handleNativeFormWebhook({ db, message: message(), phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: true });
    outcomes.blocked_phones.error = null;
    mocks.resolve.mockRejectedValue(new Error('Unavailable'));
    expect(await handleNativeFormWebhook({ db, message: message(), phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: true });
    expect(resolved.sender.sendText).not.toHaveBeenCalled();
  });
  it.each(['inactive form', 'missing asset', 'changed revision'])('does not send %s', async reason => {
    if (reason === 'inactive form') outcomes.forms.data.is_active = false;
    if (reason === 'missing asset') outcomes.native_form_publications.data = { ...publication, meta_flow_id: null };
    if (reason === 'changed revision') { outcomes.forms.data = { ...outcomes.forms.data, title: 'Changed' }; outcomes.native_form_publications.data = null; }
    expect((await sendNativeForm({ db, businessId, formId, phone, resolved, verifiedCustomerRequest: true })).sent).toBe(false);
    expect(resolved.sender.sendFlow).not.toHaveBeenCalled();
  });
  it('requests retry when entry publication lookup fails before provider emission', async () => {
    outcomes.native_form_publications.error = { message: 'Unavailable' };
    const inbound = { text: { body: 'waaiio_form:abcdefgh' }, timestamp: String(Math.floor(Date.now() / 1000)) };
    expect(await handleNativeFormWebhook({ db, message: inbound, phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: true });
    expect(resolved.sender.sendFlow).not.toHaveBeenCalled();
  });
  it('requests webhook retry for DB failure before acknowledgement', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'connection_failure' } });
    expect(await handleNativeFormWebhook({ db, message: message(), phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: true });
    expect(resolved.sender.sendText).not.toHaveBeenCalled();
  });
  it('does not replay an already claimed acknowledgement', async () => {
    outcomes.form_responses.data = null;
    expect(await handleNativeFormWebhook({ db, message: message(), phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: false });
    expect(resolved.sender.sendText).not.toHaveBeenCalled();
  });
  it('does not retry after an ambiguous acknowledgement attempt', async () => {
    resolved.sender.sendText.mockRejectedValue(new Error('timeout'));
    expect(await handleNativeFormWebhook({ db, message: message(), phone, channelId, phoneNumberId, guardSender: s => s })).toEqual({ retry: false });
    expect(resolved.sender.sendText).toHaveBeenCalledTimes(1);
  });
});
