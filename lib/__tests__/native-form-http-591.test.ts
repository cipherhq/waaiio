import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';
import { compilePublication } from '@/lib/whatsapp-forms/publication';
import { generateNativeFlowToken } from '@/lib/whatsapp-forms/flow-token';
import { MetaFlowApiError } from '@/lib/whatsapp-forms/meta-flow-asset';
const m = vi.hoisted(() => {
  const log: any = {}; for (const name of ['info','warn','error','debug']) log[name] = () => {}; log.withContext = () => log;
  return { db: null as unknown as MemoryDb, rpc: vi.fn(), user: 'owner', resolved: null as any, inboundError: false,
    email: vi.fn(), sendFlow: vi.fn(), sendText: vi.fn(), sendButtons: vi.fn(), create: vi.fn(), upload: vi.fn(), publish: vi.fn(), status: vi.fn(), log };
});
function client() {
  return { auth: { getUser: async () => ({ data: { user: m.user ? { id: m.user } : null }, error: null }) }, rpc: m.rpc,
    from(table: string) {
      const q = m.db.from(table);
      if (table === 'whatsapp_inbound_receipts') {
        const insert = q.insert;
        q.insert = (row: any) => (m.db.tables[table] || []).some(r => r.message_id === row.message_id && r.channel_id === row.channel_id)
          ? Promise.resolve({ data: null, error: { code: '23505' } }) : insert(row);
      }
      return q;
    } };
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'test' }));
vi.mock('@/lib/logger', () => ({ logger: m.log, generateRequestId: () => 'test' }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {
  resolveByBusinessId = async () => m.resolved;
  resolveByPhoneNumberId = async () => { if (m.inboundError) throw new Error('Unavailable'); return m.resolved; };
} }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ broadcast_limits: { growth: { maxBroadcasts: 1, maxRecipients: 2 } } }) }));
vi.mock('@/lib/trial-status', () => ({ resolveLimitTier: async () => 'growth' }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: (...args: unknown[]) => m.email(...args) }));
vi.mock('@/lib/bot/bot.service', () => ({ BotService: class {} }));
vi.mock('@/lib/bot/bot-intelligence', () => ({ BotIntelligenceService: class {} }));
vi.mock('@/lib/bot/standalone.service', () => ({ StandaloneService: class {} }));
import { POST as publish } from '@/app/api/forms/native-flow/publish/route';
import { POST as send } from '@/app/api/forms/native-flow/send/route';
import { GET as status } from '@/app/api/forms/native-flow/status/route';
import { GET as link } from '@/app/forms/whatsapp/[token]/route';
import { POST as broadcast } from '@/app/api/broadcasts/send/route';
import { POST as webhook } from '@/app/api/webhook/meta-cloud/route';
const biz = '11111111-1111-4111-8111-111111111111', form = '22222222-2222-4222-8222-222222222222';
const pub = '33333333-3333-4333-8333-333333333333', channel = '44444444-4444-4444-8444-444444444444';
const response = '55555555-5555-4555-8555-555555555555', phone = '12025550123', phoneNumberId = '123456789';
const compiled = compilePublication({ title: 'Church signup', description: null, fields: [{ id: 'name', type: 'text', label: 'Name', required: true }], settings: {} });
function seedPublication() { m.db.tables.native_form_publications = [{ id: pub, form_id: form, business_id: biz, channel_id: channel, phone_number_id: phoneNumberId,
  waba_id: '987654321', meta_flow_id: '123123123', status: 'published', revision: compiled.revision, config: compiled.config }]; }
function req(path: string, body: object) { return new NextRequest(`https://example.test${path}`, { method: 'POST', body: JSON.stringify(body) }); }
function inbound(message: object, valid = true) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '987654321', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ id: 'wamid.entry', type: 'text', from: phone, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] });
  const signature = createHmac('sha256', 'test-app-secret').update(body).digest('hex');
  return new NextRequest('https://example.test/api/webhook/meta-cloud', { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${valid ? signature : '0'.repeat(64)}` } });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED','true'); vi.stubEnv('FLOW_TOKEN_SECRET','x'.repeat(64));
  vi.stubEnv('META_APP_SECRET','test-app-secret'); vi.stubEnv('META_WEBHOOK_APP_SECRET','test-app-secret');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('NETWORK DENIED')));
  m.user = 'owner'; m.inboundError = false;
  vi.stubEnv('RESEND_API_KEY','test-only-dummy'); vi.stubEnv('NEXT_PUBLIC_APP_URL','https://example.test');
  m.email.mockResolvedValue({ success: true, id: 'email.accepted' });
  m.db = createMemoryDb({ businesses: [{ id: biz, owner_id: 'owner', name: 'Church', status: 'active', metadata: {} }], forms: [{ id: form, business_id: biz, token: 'abcdefgh', is_active: true, ...compiled.config }] });
  m.sendFlow.mockResolvedValue({ success: true, messageId: 'wamid.flow' }); m.sendText.mockResolvedValue({ success: true, messageId: 'wamid.ack' });
  m.sendButtons.mockResolvedValue({ success: true, messageId: 'wamid.button' });
  m.create.mockResolvedValue({ flowId: '123123123' }); m.upload.mockResolvedValue({ success: true }); m.publish.mockResolvedValue({ success: true });
  m.status.mockResolvedValue({ status: 'PUBLISHED', wabaId: '987654321' });
  m.resolved = { channel: { id: channel, provider: 'meta_cloud', channel_type: 'shared', phone_number_id: phoneNumberId, phone_number: '12404712139', waba_id: '987654321', business_id: null },
    sender: { bindBusiness: vi.fn(), sendFlow: m.sendFlow, sendText: m.sendText, sendButtons: m.sendButtons },
    cloud: { nativeFlowAssets: () => ({ create: m.create, upload: m.upload, publish: m.publish, status: m.status }) } };
  m.rpc.mockImplementation(async (name: string) => {
    if (name === 'claim_webhook_event') return { data: { claimed: true, claim_token: 'claim' }, error: null };
    if (name === 'complete_native_form_publication_591') return { data: true, error: null };
    if (name === 'save_native_form_response_591') { m.db.tables.form_responses ||= [{ id: response, business_id: biz }]; return { data: { response_id: response }, error: null }; }
    return { data: true, error: null };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('#591 real owner/public HTTP routes with external egress mocked', () => {
  it.each(['anonymous','other owner'])('rejects %s before a publication mutation', async kind => {
    m.user = kind === 'anonymous' ? '' : 'someone-else';
    expect((await publish(req('/api/forms/native-flow/publish',{businessId:biz,formId:form}))).status).toBe(kind === 'anonymous' ? 401 : 403);
    expect(m.create).not.toHaveBeenCalled(); expect(m.db.writes).toHaveLength(0);
  });
  it('publishes through create/upload/publish/account verification and the SQL finalizer', async () => {
    expect((await publish(req('/api/forms/native-flow/publish',{businessId:biz,formId:form}))).status).toBe(200);
    expect(m.create).toHaveBeenCalledOnce(); expect(m.upload).toHaveBeenCalledOnce(); expect(m.publish).toHaveBeenCalledOnce();
    expect(m.rpc).toHaveBeenCalledWith('complete_native_form_publication_591', expect.any(Object));
  });
  it('marks ambiguous publication for review and never marks it published', async () => {
    m.publish.mockRejectedValue(new Error('timeout'));
    expect((await publish(req('/api/forms/native-flow/publish',{businessId:biz,formId:form}))).status).toBe(502);
    expect(m.db.tables.native_form_publications[0].status).toBe('needs_review');
    expect(m.rpc).not.toHaveBeenCalledWith('complete_native_form_publication_591', expect.anything());
  });
  it('status and public link use only the current published configuration and resolved number', async () => {
    seedPublication();
    const result = await status(new NextRequest(`https://example.test/api/forms/native-flow/status?businessId=${biz}&formId=${form}`));
    expect(await result.json()).toMatchObject({ published: true, token: 'abcdefgh' });
    const redirect = await link(new Request('https://example.test'), { params: Promise.resolve({ token: 'abcdefgh' }) });
    expect(redirect.status).toBe(302); expect(redirect.headers.get('location')).toBe('https://wa.me/12404712139?text=waaiio_form%3Aabcdefgh');
    m.db.tables.forms[0].title = 'Edited';
    expect((await link(new Request('https://example.test'), { params: Promise.resolve({ token: 'abcdefgh' }) })).status).toBe(404);
  });
  it('merchant cannot spend another shared-number customer window', async () => {
    seedPublication(); m.db.tables.whatsapp_inbound_receipts = [{ channel_id: channel, sender_phone: phone, provider_timestamp: new Date().toISOString() }];
    expect((await send(req('/api/forms/native-flow/send',{businessId:biz,formId:form,recipientPhone:phone}))).status).toBe(422);
    expect(m.sendFlow).not.toHaveBeenCalled();
  });
});
describe('#591 actual signature-verified Meta HTTP entry', () => {
  it('rejects invalid signatures without writes or provider calls', async () => {
    expect((await webhook(inbound({text:{body:'waaiio_form:abcdefgh'}}, false))).status).toBe(401);
    expect(m.db.writes).toHaveLength(0); expect(m.sendFlow).not.toHaveBeenCalled();
  });
  it('returns503 for initial transport lookup failure', async () => {
    m.inboundError = true;
    expect((await webhook(inbound({text:{body:'waaiio_form:abcdefgh'}}))).status).toBe(503);
    expect(m.sendFlow).not.toHaveBeenCalled();
  });
  it('returns503 for transient provider status read before emission', async () => {
    seedPublication(); m.status.mockRejectedValue(new MetaFlowApiError('Unavailable',502));
    expect((await webhook(inbound({text:{body:'waaiio_form:abcdefgh'}}))).status).toBe(503);
    expect(m.sendFlow).not.toHaveBeenCalled();
  });
  it('does not resend the Flow when completion persistence fails and the webhook is reclaimed', async () => {
    seedPublication(); const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (...args) => args[0] === 'complete_webhook_event' ? {data:null,error:{message:'Unavailable'}} : original(...args));
    expect((await webhook(inbound({text:{body:'waaiio_form:abcdefgh'}}))).status).toBe(503);
    expect((await webhook(inbound({text:{body:'waaiio_form:abcdefgh'}}))).status).toBe(503);
    expect(m.sendFlow).toHaveBeenCalledTimes(1);
  });
  it('captures a signed nfm_reply before acknowledgement and does not acknowledge its duplicate', async () => {
    seedPublication();
    const token = generateNativeFlowToken({ formId:form,businessId:biz,publicationId:pub,channelId:channel,phoneNumberId,assetId:'123123123',revision:compiled.revision,phone }).token;
    const reply = { type:'interactive', interactive:{type:'nfm_reply',nfm_reply:{response_json:JSON.stringify({flow_token:token,name:'Ada'})}} };
    expect((await webhook(inbound(reply))).status).toBe(200); expect((await webhook(inbound(reply))).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('save_native_form_response_591', expect.objectContaining({p_phone:phone,p_answers:{name:'Ada'}}));
    expect(m.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('#591 actual email broadcast branch', () => {
  function setupEmail() {
    m.db.tables.form_responses = [{ id: response, business_id: biz, submission_source: 'native', customer_email: 'ada@example.test', customer_phone: phone }];
    m.db.tables.customer_consents = [{ business_id: biz, channel: 'email', purpose: 'marketing', status: 'granted', email_address: 'ada@example.test', phone, created_at: new Date().toISOString() }];
    return { channel: 'email', business_id: biz, response_ids: [response], request_id: pub, message: 'Programme update' };
  }
  it('sends with exact-address consent without WhatsApp consent and retrieves the same batch after quota exhaustion', async () => {
    const body = setupEmail();
    const result = await broadcast(req('/api/broadcasts/send',body));
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ accepted:1, total:1, unknown:0 });
    expect(m.email).toHaveBeenCalledWith(expect.objectContaining({ to:'ada@example.test', noRetry:true, html:expect.stringContaining('Unsubscribe') }));
    m.db.tables.broadcast_usage = [{ business_id:biz,month_key:new Date().toISOString().slice(0,7),broadcast_count:1,recipient_count:2 }];
    expect((await broadcast(req('/api/broadcasts/send',body))).status).toBe(200);
    expect(m.email).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls.filter(call=>call[0]==='increment_broadcast_usage')).toHaveLength(1);
  });
  it('does not send an unsubscribed address, and rejects another business response selection', async () => {
    const body = setupEmail(); m.db.tables.native_form_email_unsubscribes = [{business_id:biz,email_address:'ada@example.test'}];
    const result = await broadcast(req('/api/broadcasts/send',body)); expect(await result.json()).toMatchObject({accepted:0,skipped:1});
    expect(m.email).not.toHaveBeenCalled();
    m.db.tables.form_responses[0].business_id = form;
    expect((await broadcast(req('/api/broadcasts/send',{...body,request_id:channel}))).status).toBeGreaterThanOrEqual(400);
    expect(m.email).not.toHaveBeenCalled();
  });
});
