import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Install before route imports. No hosted clients or real sockets are allowed.
const network = await vi.hoisted(async () => {
  const { Socket } = await import('node:net');
  const originalFetch = globalThis.fetch;
  const originalConnect = Socket.prototype.connect;
  const state = { attempts: 0, expected: 0 };
  globalThis.fetch = async () => {
    state.attempts++;
    throw new Error('NETWORK-DENY: isolated acceptance forbids all external fetch');
  };
  Socket.prototype.connect = function () {
    state.attempts++;
    throw new Error('NETWORK-DENY: isolated acceptance forbids all socket connections');
  };
  return { state, restore() {
    globalThis.fetch = originalFetch;
    Socket.prototype.connect = originalConnect;
  } };
});
import { CapturingMessageSender } from '@/synthetic-e2e/lib/capturing-sender';
import { installMetaEgressDeny, uninstallMetaEgressDeny, getBlockedMetaAttempts } from '@/synthetic-e2e/lib/network-deny';
import { request as httpsRequest } from 'node:https';

const capture = new CapturingMessageSender();
let expectedMetaAttempts = 0;
afterEach(() => {
  try {
    expect(getBlockedMetaAttempts()).toBe(expectedMetaAttempts);
    expect(network.state.attempts).toBe(network.state.expected);
    // Routes must never manufacture or change consent, even in the fixture DB.
    expect(m.writes.filter(w => ['customer_consents', 'messaging_opt_outs'].includes(w.table))).toEqual([]);
  } finally {
    uninstallMetaEgressDeny();
  }
});
afterAll(() => network.restore());

const m = vi.hoisted(() => ({
  user: { id: 'owner' } as { id: string } | null, owns: true,
  due: [] as Array<Record<string, unknown>>,
  consents: {} as Record<string, { status: string; expires_at: string | null } | null>,
  optOutCount: 0, readError: null as unknown,
  writes: [] as Array<{ table: string; kind: string; row: Record<string, unknown> }>,
  calls: [] as unknown[][], from: vi.fn(), rpc: vi.fn(), capability: vi.fn(), cronAuth: vi.fn(),
  text: vi.fn(), template: vi.fn(), category: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: m.capability }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: m.cronAuth }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ broadcast_limits: { growth: { maxBroadcasts: 100, maxRecipients: 1000 } } }) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {
  async resolveByBusinessId() { return { cloud: { wabaId: 'actual-waba' }, sender: { sendText: m.text, sendTemplate: m.template } }; }
} }));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ resolveTemplateCategory: m.category }));

// Keep the real permission helper: these route checks exercise purpose, revocation,
// global opt-outs and failed consent reads rather than mocking a boolean gate.
import { POST as schedule } from '@/app/api/broadcasts/schedule/route';
import { GET as dispatch } from '@/app/api/cron/scheduled-broadcasts/route';
import { RECIPIENT_POLICY } from '@/lib/merchants/recipient-permission';

const phone = '12025550123';
const otherPhone = '12025550124';
const grant = { status: 'granted', expires_at: null };
const request = (body: Record<string, unknown>) => new NextRequest('https://example.test/api/broadcasts/schedule', {
  method: 'POST', body: JSON.stringify(body),
});
const body = () => ({ business_id: 'biz', message: 'QA update', phones: [phone], scheduled_at: new Date(Date.now() + 120000).toISOString() });
const tick = () => dispatch(new NextRequest('https://example.test/api/cron/scheduled-broadcasts'));
const finalWrite = () => m.writes.filter(w => w.table === 'business_broadcasts' && w.kind === 'update').at(-1)?.row;
const enqueue = (extra: Record<string, unknown> = {}) => { m.due = [{ id: 'scheduled1', ...body(), ...extra }]; };

beforeEach(() => {
  capture.reset(); network.state.attempts = 0; network.state.expected = 0; expectedMetaAttempts = 0;
  installMetaEgressDeny();
  vi.resetAllMocks(); m.user = { id: 'owner' }; m.owns = true; m.due = [];
  m.consents = { [phone]: grant }; m.optOutCount = 0; m.readError = null; m.writes = []; m.calls = [];
  m.capability.mockResolvedValue({ allowed: true }); m.cronAuth.mockReturnValue(null);
  m.text.mockImplementation(msg => capture.sendText(msg));
  m.template.mockImplementation(msg => capture.sendTemplate(msg));
  m.category.mockResolvedValue('marketing'); m.rpc.mockResolvedValue({ error: null });
  m.from.mockImplementation((table: string) => {
    let phones: string[] = [];
    let kind = 'read';
    const result = () => ({
      data: table === 'business_broadcasts' ? kind === 'insert' ? { id: 'scheduled1', scheduled_at: body().scheduled_at } : m.due
        : table === 'businesses' ? m.owns ? { id: 'biz', owner_id: 'owner', name: 'QA', subscription_tier: 'growth' } : null
        : table === 'customer_consents' ? m.consents[(phones[0] || '').replace(/\D/g, '')] ?? null : null,
      count: table === 'messaging_opt_outs' ? m.optOutCount : 0,
      error: ['customer_consents', 'messaging_opt_outs'].includes(table) ? m.readError : null,
    });
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'or', 'is', 'order', 'limit', 'lte']) {
      query[method] = (...args: unknown[]) => {
        m.calls.push([table, method, ...args]);
        if (method === 'in' && args[0] === 'phone') phones = args[1] as string[];
        return query;
      };
    }
    for (const method of ['insert', 'update']) query[method] = (row: Record<string, unknown>) => {
      kind = method; m.writes.push({ table, kind, row }); return query;
    };
    query.single = query.maybeSingle = async () => result();
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  });
});

describe('scheduled broadcast intake', () => {
  it('preserves authentication, capability and business ownership denials', async () => {
    m.user = null;
    expect((await schedule(request(body()))).status).toBe(401);
    m.user = { id: 'owner' }; m.capability.mockResolvedValue({ allowed: false, denial: { message: 'Forbidden' }, status: 403 });
    expect((await schedule(request(body()))).status).toBe(403);
    m.capability.mockResolvedValue({ allowed: true }); m.owns = false;
    expect((await schedule(request(body()))).status).toBe(404);
    expect(m.writes).toHaveLength(0);
  });
  it('rejects a non-array audience before querying', async () => {
    expect((await schedule(request({ ...body(), phones: phone }))).status).toBe(400);
    expect(m.from).not.toHaveBeenCalled();
  });
  it('saves the complete submitted audience when marketing consent is recorded', async () => {
    m.consents[otherPhone] = grant;
    const response = await schedule(request({ ...body(), phones: [phone, otherPhone] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recipient_count: 2 });
    expect(m.writes[0]).toMatchObject({ table: 'business_broadcasts', row: { phones: [phone, otherPhone], recipient_count: 2 } });
    expect(m.calls).toContainEqual(['customer_consents', 'eq', 'business_id', 'biz']);
    expect(m.calls).toContainEqual(['customer_consents', 'eq', 'purpose', 'marketing']);
  });
  it('rejects an entire mixed audience without saving a smaller batch', async () => {
    const response = await schedule(request({ ...body(), phones: [phone, otherPhone] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: RECIPIENT_POLICY });
    expect(m.writes).toHaveLength(0);
  });
  it.each([null, { status: 'revoked', expires_at: null }, { status: 'granted', expires_at: '2000-01-01' }])('refuses absent/revoked/expired consent %j', async consent => {
    m.consents[phone] = consent;
    expect((await schedule(request(body()))).status).toBe(403);
    expect(m.writes).toHaveLength(0);
  });
});

describe('scheduled broadcast dispatch', () => {
  it('retains cron authentication before database access', async () => {
    m.cronAuth.mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await tick()).status).toBe(401);
    expect(m.from).not.toHaveBeenCalled();
  });
  it('rechecks consent revoked after a successful schedule', async () => {
    expect((await schedule(request(body()))).status).toBe(200);
    m.consents[phone] = { status: 'revoked', expires_at: null }; enqueue();
    await tick();
    expect(m.text).not.toHaveBeenCalled(); expect(m.template).not.toHaveBeenCalled();
    expect(finalWrite()).toMatchObject({ status: 'failed', sent_at: null, sent_count: 0, error_message: 'No eligible recipients at dispatch time' });
    expect(m.writes.filter(w => w.table === 'notifications')).toHaveLength(0);
  });
  it.each(['global opt-out', 'read failure'])('suppresses scheduling and dispatch for %s', async reason => {
    if (reason === 'global opt-out') m.optOutCount = 1;
    else m.readError = { message: 'unavailable' };
    expect((await schedule(request(body()))).status).toBe(403);
    expect(m.writes).toHaveLength(0);
    enqueue(); await tick();
    expect(m.calls).toContainEqual(['messaging_opt_outs', 'or', 'business_id.eq.biz,business_id.is.null']);
    expect(m.text).not.toHaveBeenCalled(); expect(m.template).not.toHaveBeenCalled();
    expect(finalWrite()).toMatchObject({ status: 'failed', sent_at: null, sent_count: 0 });
  });
  it('tags accepted text with service billing category and records its acceptance', async () => {
    enqueue(); expect((await tick()).status).toBe(200);
    expect(capture.getCapturedSends()).toHaveLength(1);
    expect(capture.getLastSend()).toMatchObject({ method: 'sendText', to: phone, content: { messageCategory: 'service' } });
    expect(m.text).toHaveBeenCalledWith(expect.objectContaining({ to: phone, messageCategory: 'service' }));
    expect(finalWrite()).toMatchObject({ status: 'sent', sent_count: 1, failed_count: 0, error_message: null });
  });
  it('resolves the template category from the sending WABA', async () => {
    enqueue({ template_name: 'business_update' }); await tick();
    expect(m.category).toHaveBeenCalledWith({ wabaId: 'actual-waba' }, 'business_update');
    expect(m.template).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'marketing' }));
    expect(m.text).not.toHaveBeenCalled();
    expect(capture.getCapturedSends()).toHaveLength(1);
    expect(capture.getLastSend()).toMatchObject({ method: 'sendTemplate', to: phone, content: { templateName: 'business_update' } });
    expect(finalWrite()).toMatchObject({ status: 'sent', sent_count: 1 });
  });
  it.each(['unknown category', 'lookup failure', 'template rejection'])('uses guarded text fallback for %s', async reason => {
    if (reason === 'unknown category') m.category.mockResolvedValue(null);
    if (reason === 'lookup failure') m.category.mockRejectedValue(new Error('unavailable'));
    if (reason === 'template rejection') m.template.mockRejectedValue(new Error('provider rejected'));
    enqueue({ template_name: 'business_update' }); await tick();
    if (reason !== 'template rejection') expect(m.template).not.toHaveBeenCalled();
    expect(m.text).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service' }));
    expect(finalWrite()).toMatchObject({ status: 'sent', sent_count: 1 });
  });
  it('records provider rejection without claiming any message was sent', async () => {
    m.text.mockRejectedValue(new Error('provider rejected')); enqueue(); await tick();
    expect(finalWrite()).toMatchObject({ status: 'failed', sent_at: null, sent_count: 0, failed_count: 1, error_message: 'No WhatsApp messages were accepted' });
    expect(m.writes.filter(w => w.table === 'notifications').map(w => w.row.status)).toEqual(['failed']);
  });
});

// Deliberate safety probes: these assert blocked attempts, never successful egress.
describe('isolated acceptance network boundary', () => {
  it.each([
    'https://graph.facebook.com/v21.0/synthetic/messages',
    new URL('https://graph.facebook.com/v21.0/synthetic/messages'),
    new Request('https://graph.facebook.com/v21.0/synthetic/messages'),
  ])('blocks Meta fetch input %s before transport', async input => {
    expectedMetaAttempts = 1;
    await expect(fetch(input)).rejects.toThrow('NETWORK-DENY');
    expect(network.state.attempts).toBe(0);
    expect(capture.getCapturedSends()).toEqual([]);
  });
  it('blocks non-Meta fetch too, including accidental hosted database access', async () => {
    network.state.expected = 1;
    await expect(fetch('https://example.invalid/rest/v1/customer_consents')).rejects.toThrow('NETWORK-DENY');
  });
  it('blocks native HTTPS if a sender bypasses fetch', () => {
    network.state.expected = 1;
    expect(() => httpsRequest('https://graph.facebook.com/v21.0/synthetic/messages')).toThrow('NETWORK-DENY');
  });
  it('cannot report acceptance when an accidentally unmocked sender attempts Meta', async () => {
    expectedMetaAttempts = 1;
    m.text.mockImplementation(() => fetch('https://graph.facebook.com/v21.0/synthetic/messages'));
    enqueue();
    expect((await tick()).status).toBe(200);
    expect(capture.getCapturedSends()).toEqual([]);
    expect(finalWrite()).toMatchObject({ status: 'failed', sent_at: null, sent_count: 0, failed_count: 1 });
    expect(m.writes.filter(w => w.table === 'notifications').map(w => w.row.status)).toEqual(['failed']);
  });
  it('captures only currently eligible recipients in a mixed dispatch', async () => {
    enqueue({ phones: [phone, otherPhone] });
    expect((await tick()).status).toBe(200);
    expect(capture.getCapturedSends().map(send => send.to)).toEqual([phone]);
    expect(finalWrite()).toMatchObject({ status: 'sent', sent_count: 1, failed_count: 0 });
    expect(finalWrite()?.sent_at).toEqual(expect.any(String));
  });
});
