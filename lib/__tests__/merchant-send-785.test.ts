import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const m = vi.hoisted(() => ({
  consent: true, from: vi.fn(), rpc: vi.fn(), auth: vi.fn(), capability: vi.fn(), text: vi.fn(), audio: vi.fn(), template: vi.fn(), resolveCategory: vi.fn(), fallback: vi.fn(), initialize: vi.fn(), email: vi.fn(), writes: [] as Array<{table: string; row: Record<string, unknown>}>,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: m.auth }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: m.capability }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'key' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return { cloud: { wabaId: 'actual' }, sender: { sendText: m.text, sendAudio: m.audio, sendTemplate: m.template } }; } } }));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ resolveTemplateCategory: m.resolveCategory }));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: m.fallback, findCustomerEmail: async () => null }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: (args: unknown) => ({ html: JSON.stringify(args), subject: 'test' }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: m.email }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ broadcast_limits: { growth: { maxBroadcasts: 100, maxRecipients: 1000 } } }) }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: m.initialize }));
import { POST as reportSend } from '@/app/api/reports/send/route';
import { POST as chat } from '@/app/api/chat/send/route';
import { POST as broadcast } from '@/app/api/broadcasts/send/route';
import { POST as payment } from '@/app/api/payment-request/send/route';
function req(body: unknown) { return new NextRequest('https://example.test/api', { method: 'POST', body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.clearAllMocks(); m.writes = []; m.consent = true;
  m.auth.mockResolvedValue({ user: { id: 'owner' }, businessId: 'biz', service: { from: m.from } }); m.capability.mockResolvedValue({ allowed: true });
  m.text.mockResolvedValue({ success: true }); m.audio.mockResolvedValue({ success: true }); m.template.mockResolvedValue({ success: true });
  m.resolveCategory.mockResolvedValue('marketing'); m.fallback.mockResolvedValue({ whatsapp: 'sent', email: 'no_address' });
  m.initialize.mockResolvedValue({ url: 'https://staging.waaiio.com/api/pay?ref=short', reference: 'transaction-reference' });
  m.email.mockResolvedValue({ success: true }); m.rpc.mockResolvedValue({ error: null });
  m.from.mockImplementation((table: string) => {
    const data = table === 'businesses' ? { id: 'biz', owner_id: 'owner', name: 'Test', country_code: 'NG', subscription_tier: 'growth', payment_gateway: 'paystack' }
      : table === 'customer_consents' ? { status: m.consent ? 'granted' : 'revoked', expires_at: null }
      : table === 'customer_profiles' ? { phone: '+12025550123' }
      : table === 'customer_reports' ? { id: 'report', business_id: 'biz', customer_phone: '+12025550123', title: 'Document', businesses: { name: 'Test' } }
      : table === 'bookings' ? { id: 'booking', reference_code: 'WA-PY-1234' }
      : table === 'payments' ? { gateway: 'paystack', gateway_reference: 'transaction-reference' }
      : table === 'chat_conversations' ? { id: 'conversation', assigned_to: 'owner' }
      : null;
    const result = { data, count: 0, error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'or', 'upsert', 'update', 'order', 'limit']) chain[method] = (row: Record<string, unknown>) => { if (method === 'update') m.writes.push({ table, row }); return chain; };
    chain.insert = (row: Record<string, unknown>) => { m.writes.push({ table, row }); return chain; };
    chain.single = chain.maybeSingle = async () => result;
    chain.then = (resolve: (x: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  });
});
describe('chat send classification and failures', () => {
  it.each([false, true])('supplies service for audio=%s', async audio => {
    const response = await chat(req({ businessId: 'biz', customerPhone: '+12025550123', ...(audio ? { audioUrl: 'https://example.test/audio' } : { messageText: 'Hello' }) }));
    expect(response.status).toBe(200);
    expect(audio ? m.audio : m.text).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service', to: '12025550123' }));
  });
  it('does not persist a sent chat when sender rejects', async () => {
    m.text.mockResolvedValue({ success: false });
    const response = await chat(req({ businessId: 'biz', customerPhone: '+12025550123', messageText: 'Hello' }));
    expect(response.status).toBe(502); expect(m.writes).toHaveLength(0);
  });
  it('retains authentication denial before sending', async () => {
    m.auth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await chat(req({ businessId: 'biz', customerPhone: '+12025550123', messageText: 'Hello' }))).status).toBe(401);
    expect(m.text).not.toHaveBeenCalled();
  });
});
describe('broadcast acceptance reporting', () => {
  const body = { business_id: 'biz', message: 'News', phones: ['12025550123'], template_name: 'business_update' };
  it('uses approved category from actual WABA, not update label', async () => {
    const response = await broadcast(req(body)); const result = await response.json();
    expect(m.resolveCategory).toHaveBeenCalledWith({ wabaId: 'actual' }, 'business_update');
    expect(m.template).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'marketing' }));
    expect(result).toMatchObject({ success: true, sent: 1, not_sent: 0 });
  });
  it('does not report a resolved template/fallback failure as sent', async () => {
    m.template.mockResolvedValue({ success: false }); m.fallback.mockResolvedValue({ whatsapp: 'failed', email: 'no_address' });
    const result = await (await broadcast(req(body))).json();
    expect(result).toMatchObject({ success: false, sent: 0, not_sent: 1, email_only: 0 });
    expect(m.fallback).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service' }));
    expect(m.writes.filter(w => w.table === 'notifications').map(w => w.row.status)).toEqual(['failed']);
  });
  it('reports email-only acceptance separately', async () => {
    m.template.mockRejectedValue(new Error('template rejected')); m.fallback.mockResolvedValue({ whatsapp: 'failed', email: 'sent' });
    expect(await (await broadcast(req(body))).json()).toMatchObject({ sent: 0, email_only: 1, success: false });
  });
  it('does not send a template with unknown category', async () => {
    m.resolveCategory.mockResolvedValue(null);
    expect(await (await broadcast(req(body))).json()).toMatchObject({ sent: 1, used_template: false });
    expect(m.template).not.toHaveBeenCalled();
  });
  it('reports partial outcomes', async () => {
    m.template.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('failed'));
    m.fallback.mockResolvedValue({ whatsapp: 'failed', email: 'no_address' });
    expect(await (await broadcast(req({ ...body, phones: ['12025550123', '12025550124'] }))).json()).toMatchObject({ sent: 1, not_sent: 1, total: 2, success: false });
  });
  it('preserves capability denial', async () => {
    m.capability.mockResolvedValue({ allowed: false, status: 403, denial: { message: 'Denied' } });
    expect((await broadcast(req(body))).status).toBe(403); expect(m.template).not.toHaveBeenCalled();
  });
});
describe('payment request checkout URL', () => {
  it.each(['https://staging.waaiio.com/api/pay?ref=short', 'https://checkout.paystack.com/access-code'])('preserves initializer URL %s', async url => {
    m.initialize.mockResolvedValue({ url, reference: 'transaction-reference' });
    const response = await payment(req({ businessId: 'biz', customerPhone: '+12025550123', amount: 500 }));
    expect(response.status).toBe(200); expect((await response.json()).paymentUrl).toBe(url);
    expect(m.fallback.mock.calls[0][0].text).toContain(url);
    expect(m.from).not.toHaveBeenCalledWith('payments');
  });
});


describe('merchant consent enforcement before side effects', () => {
  it('rejects chat without utility consent before sending or persisting', async () => {
    m.consent = false;
    expect((await chat(req({ businessId: 'biz', customerPhone: '+12025550123', messageText: 'Hello' }))).status).toBe(403);
    expect(m.text).not.toHaveBeenCalled(); expect(m.writes).toHaveLength(0);
  });
  it.each(['whatsapp', 'email'])('rejects payment request via %s before booking or initialization', async sendVia => {
    m.consent = false;
    expect((await payment(req({ businessId: 'biz', customerPhone: '+12025550123', customerEmail: 'customer@example.test', amount: 100, sendVia }))).status).toBe(403);
    expect(m.initialize).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled(); expect(m.writes).toHaveLength(0);
  });
  it('suppresses broadcast without marketing consent, including fallback', async () => {
    m.consent = false;
    await broadcast(req({ business_id: 'biz', message: 'News', phones: ['12025550123'] }));
    expect(m.template).not.toHaveBeenCalled(); expect(m.fallback).not.toHaveBeenCalled();
  });
});


describe('document sending consent and acceptance', () => {
  it('does not rotate access token or send when consent is revoked', async () => {
    m.consent = false;
    const response = await reportSend(req({ businessId: 'biz', reportIds: ['report'] }));
    expect((await response.json()).results[0].status).toBe('consent_required');
    expect(m.text).not.toHaveBeenCalled(); expect(m.writes).toHaveLength(0);
  });
  it.each([true, false])('records sender acceptance=%s truthfully', async success => {
    m.text.mockResolvedValue({ success });
    const response = await reportSend(req({ businessId: 'biz', reportIds: ['report'] }));
    expect((await response.json()).results[0].status).toBe(success ? 'sent' : 'failed');
    expect(m.text).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'utility' }));
    if (!success) expect(m.writes.some(write => write.row.status === 'sent')).toBe(false);
  });
});
