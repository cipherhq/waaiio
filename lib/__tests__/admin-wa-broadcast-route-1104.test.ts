// #1104: /api/admin/broadcasts/whatsapp with the real requirePlatformAdmin, the
// real consumeStepUp and the real recipient, opt-out, suspension and delivery
// logic. Synthetic: Supabase Auth, the in-memory tables, the shared-number
// resolver and the provider (no WhatsApp message is sent anywhere).
// The table constraints themselves are proved on PostgreSQL in
// admin-whatsapp-broadcasts-548.pg.test.ts; the platform-scope send (no
// merchant credit) through the real MetaCloudSender is proved at the end.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';
import { hashOperationParams } from '@/lib/admin-step-up';

const f = vi.hoisted(() => ({
  role: 'admin' as string, aal: 'aal2', db: null as any,
  rpcCalls: [] as string[],
  templates: [] as any[],
  sent: [] as any[],
  sendError: null as Error | null,
  businessTemplateSends: 0,
  limited: false,
  lookupFails: new Set<string>(),
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async (token: string) => token === 'good'
      ? { data: { claims: { sub: 'admin-1', aal: f.aal, session_id: 'sess-1' } } } : { error: new Error('invalid') },
    getUser: async () => ({ data: { user: { id: 'admin-1', email: 'a@x.test', app_metadata: { role: f.role } } } }),
  },
  rpc: (name: string) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) };
    f.rpcCalls.push(name);
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
  },
  from: (table: string) => f.db.from(table),
}) }));
// The audit writer's own dynamic import of the service client races with the
// step-up's background audit in vitest and can load the real client. Write the
// same row (lib/admin-audit.ts) into the in-memory table instead.
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: async (e: any) => {
    await f.db.from('admin_audit_logs').insert({
      actor_id: e.actorId, action: e.action, entity_type: e.entityType ?? null, entity_id: e.entityId ?? null,
      details: e.details ?? null, ip_address: e.ipAddress ?? null,
    });
    return {};
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('cookie client not expected'); } }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: async () => (f.limited ? new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }) : null),
}));

const cloud = vi.hoisted(() => ({
  getTemplates: async () => ({ data: f.templates }),
}));
vi.mock('@/lib/channels/meta-cloud', () => ({ MetaCloudService: class { getTemplates = cloud.getTemplates; } }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async getSharedChannelForCountry(country: string) {
      if (f.lookupFails.has(country)) throw new Error('Shared channel lookup unavailable.');
      // Waaiio has shared numbers in NG and GB only in this fixture.
      if (country !== 'NG' && country !== 'GB') return null;
      return {
        channel: { id: `shared-${country}`, channel_type: 'shared', business_id: null, waba_id: 'waaiio-waba' },
        cloud,
        sender: {
          async sendPlatformTemplate(msg: any) {
            if (f.sendError) throw f.sendError;
            f.sent.push({ ...msg, from: country });
            return { success: true, messageId: `wamid.${msg.to}` };
          },
          // A business-scoped send would draw merchant credit; it must never be used.
          async sendTemplate() { f.businessTemplateSends++; return { success: true }; },
        },
      };
    }
  },
}));

import { GET, POST } from '@/app/api/admin/broadcasts/whatsapp/route';

const NG_OWNER = '2348012345678';
const NG_OPTED_OUT = '2348022222222';
const NG_SUSPENDED = '2348033333333';
const GB_USER = '447400123456';
const US_USER = '12025550143';
const REQUEST_ID = '6f1c2f9e-6c2a-4d7e-9a51-2b0c1e4d1104';

const TEMPLATE = {
  name: 'waaiio_news', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
  components: [{ type: 'BODY', text: 'Hi from Waaiio: {{1}}' }],
};

const req = (method: 'GET' | 'POST', body?: unknown, token = 'good') => new NextRequest('https://app.test/api/admin/broadcasts/whatsapp', {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const specific = {
  templateName: 'waaiio_news', language: 'en_US', audience: 'specific',
  phones: [`+${NG_OWNER}`, NG_OPTED_OUT, `+${NG_SUSPENDED}`, `+${GB_USER}`], params: ['New feature'],
};
/** What the step-up is bound to: the normalized request (as the preview returns it). */
const descriptor = {
  templateName: 'waaiio_news', language: 'en_US', audience: 'specific', country: null, plan: null,
  phones: [GB_USER, NG_OPTED_OUT, NG_OWNER, NG_SUSPENDED].sort(), params: ['New feature'],
};

function grant(params: Record<string, unknown> = descriptor, extra: Record<string, unknown> = {}) {
  f.db.tables.admin_step_up_authorizations.push({
    id: 'su-1', admin_user_id: 'admin-1', session_id: 'sess-1', action_type: 'admin_broadcast', target_id: REQUEST_ID,
    params_hash: hashOperationParams(params), verified_at: new Date().toISOString(), consumed_at: null,
    expires_at: new Date(Date.now() + 120_000).toISOString(), ...extra,
  });
}
const sendBody = (extra: Record<string, unknown> = {}) => ({ mode: 'send', requestId: REQUEST_ID, stepUpId: 'su-1', ...specific, ...extra });
const recipients = () => Object.fromEntries(f.db.tables.admin_broadcast_recipients.map((r: any) => [r.phone, r.status]));

beforeEach(() => {
  f.role = 'admin'; f.aal = 'aal2'; f.rpcCalls = []; f.sent = []; f.sendError = null;
  f.businessTemplateSends = 0; f.limited = false; f.templates = [TEMPLATE]; f.lookupFails = new Set();
  f.db = createMemoryDb({
    admin_step_up_authorizations: [], admin_audit_logs: [], admin_broadcasts: [], admin_broadcast_recipients: [],
    customer_suspensions: [{ id: 's-1', phone: NG_SUSPENDED }],
    messaging_opt_outs: [
      // Waaiio-level STOP (no business): skipped.
      { id: 'o-1', phone: `+${NG_OPTED_OUT}`, business_id: null, channel: 'whatsapp', resubscribed_at: null },
      // A STOP to one merchant is that merchant's; it does not opt out of Waaiio.
      { id: 'o-2', phone: `+${NG_OWNER}`, business_id: 'biz-other', channel: 'whatsapp', resubscribed_at: null },
    ],
    launch_subscribers: [],
    profiles: [], businesses: [],
    platform_config_versions: [{ id: 'cfg-1', effective_from: '2026-01-01T00:00:00Z', config_snapshot: { messaging_pricing: {
      NGN: { rates: { NG: { marketing: 2000, utility: 500 } } },
      GBP: { rates: { GB: { marketing: 9 } } },
    } } }],
  }, { admin_broadcasts: [['request_id']], admin_broadcast_recipients: [['broadcast_id', 'phone']] });
});

describe('authorization', () => {
  it('refuses a missing token, a support admin and a non-aal2 session', async () => {
    expect((await POST(req('POST', { mode: 'preview', ...specific }, 'bad'))).status).toBe(403);
    f.role = 'support';
    expect((await POST(req('POST', { mode: 'preview', ...specific }))).status).toBe(403);
    expect((await GET(req('GET'))).status).toBe(403);
    f.role = 'admin'; f.aal = 'aal1';
    expect((await POST(req('POST', sendBody()))).status).toBe(403);
    expect(f.sent).toEqual([]);
  });

  it('refuses to send without a step-up, and with a step-up bound to different values', async () => {
    const none = await POST(req('POST', sendBody({ stepUpId: undefined })));
    expect(none.status).toBe(403);
    expect((await none.json()).code).toBe('step_up_required');

    grant({ ...descriptor, params: ['Something else'] });
    const mismatch = await POST(req('POST', sendBody()));
    expect(mismatch.status).toBe(403);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
    expect(f.sent).toEqual([]);
    expect(f.db.tables.admin_broadcasts).toEqual([]);
  });

  it('is rate limited per admin', async () => {
    grant(); f.limited = true;
    expect((await POST(req('POST', sendBody()))).status).toBe(429);
    expect(f.sent).toEqual([]);
  });
});

describe('templates and preview', () => {
  it('lists only templates this page can send', async () => {
    f.templates = [
      TEMPLATE,
      { ...TEMPLATE, name: 'pending_one', status: 'PENDING' },
      { ...TEMPLATE, name: 'otp_code', category: 'AUTHENTICATION' },
      { ...TEMPLATE, name: 'with_image', components: [{ type: 'HEADER', format: 'IMAGE' }, TEMPLATE.components[0]] },
      { ...TEMPLATE, name: 'named_vars', components: [{ type: 'BODY', text: 'Hi {{first_name}}' }] },
    ];
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).templates).toEqual([
      { name: 'waaiio_news', language: 'en_US', category: 'marketing', bodyText: 'Hi from Waaiio: {{1}}', paramCount: 1 },
    ]);
  });

  it('counts recipients, skips and Waaiio cost without sending', async () => {
    const res = await POST(req('POST', { mode: 'preview', ...specific, phones: [...specific.phones, US_USER] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.rendered).toBe('Hi from Waaiio: New feature');
    expect(body.counts).toEqual({ matched: 5, withoutNumber: 0, eligible: 2, noSender: 1, optedOut: 1, suspended: 1, unverified: 0 });
    // NG marketing 2000 kobo + GB marketing 9 pence.
    // Only numbers that will be sent are priced; the US number has no Waaiio sender.
    expect(body.estimate).toEqual({
      byCurrency: [{ currency: 'GBP', amountMinor: 9, recipients: 1 }, { currency: 'NGN', amountMinor: 2000, recipients: 1 }],
      unpriced: 0,
    });
    expect(body.descriptor).toEqual({ ...descriptor, phones: [...descriptor.phones, US_USER].sort() });
    expect(f.sent).toEqual([]);
    expect(f.db.tables.admin_broadcasts).toEqual([]);
  });

  it('rejects an unapproved template or the wrong number of values before any step-up is used', async () => {
    grant();
    f.templates = [{ ...TEMPLATE, status: 'PAUSED' }];
    expect((await POST(req('POST', sendBody()))).status).toBe(422);
    f.templates = [TEMPLATE];
    grant({ ...descriptor, params: [] });
    expect((await POST(req('POST', sendBody({ params: [] })))).status).toBe(400);
    expect(f.db.tables.admin_step_up_authorizations.every((g: any) => g.consumed_at === null)).toBe(true);
    expect(f.sent).toEqual([]);
  });

  it('refuses an audience over the per-send limit', async () => {
    f.db.tables.profiles = Array.from({ length: 251 }, (_, i) => ({ id: `p-${i}`, phone: `+23480${String(10000000 + i)}` }));
    const res = await POST(req('POST', { mode: 'preview', templateName: 'waaiio_news', language: 'en_US', audience: 'all_users', params: ['x'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 250/);
  });
});

describe('send', () => {
  it('sends once per eligible number as a platform message, skips opted-out and suspended numbers, records and audits', async () => {
    grant();
    const res = await POST(req('POST', sendBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ replayed: false, status: 'sent', sent: 2, failed: 0, unknown: 0, skipped: { optedOut: 1, suspended: 1, unverified: 0 } });

    expect(f.sent.map(s => [s.to, s.from])).toEqual([[NG_OWNER, 'NG'], [GB_USER, 'GB']]);
    expect(f.sent[0]).toMatchObject({ templateName: 'waaiio_news', languageCode: 'en_US', templateParams: ['New feature'], messageCategory: 'marketing' });
    // No merchant credit: no business-scoped send, no billing RPC (check_or_authorize_send, settle_message_cost).
    expect(f.businessTemplateSends).toBe(0);
    expect(f.rpcCalls).toEqual([]);

    expect(recipients()).toEqual({
      [NG_OWNER]: 'sent', [GB_USER]: 'sent', [NG_OPTED_OUT]: 'skipped_opted_out', [NG_SUSPENDED]: 'skipped_suspended',
    });
    expect(f.db.tables.admin_broadcast_recipients.find((r: any) => r.phone === NG_OWNER).meta_message_id).toBe(`wamid.${NG_OWNER}`);
    const [broadcast] = f.db.tables.admin_broadcasts;
    expect(broadcast).toMatchObject({
      request_id: REQUEST_ID, sender_id: 'admin-1', channel: 'whatsapp', audience: 'specific', status: 'sent',
      recipient_count: 2, message: 'Hi from Waaiio: New feature', subject: 'waaiio_news (en_US)',
    });
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toEqual(expect.any(String));
    await vi.waitFor(() => expect(f.db.tables.admin_audit_logs.map((r: any) => r.action)).toContain('send_whatsapp_broadcast'));
    // The start is audited before the first send, so a run that is cut off still has a record.
    const actions = f.db.tables.admin_audit_logs.map((r: any) => r.action);
    expect(actions.indexOf('start_whatsapp_broadcast')).toBeGreaterThan(-1);
    expect(actions.indexOf('start_whatsapp_broadcast')).toBeLessThan(actions.indexOf('send_whatsapp_broadcast'));
    expect(broadcast.audience_filter).toMatchObject({ recipients: 4, category: 'marketing' });
    const audit = f.db.tables.admin_audit_logs.find((r: any) => r.action === 'send_whatsapp_broadcast');
    expect(audit).toMatchObject({ actor_id: 'admin-1', entity_type: 'admin_broadcast', entity_id: broadcast.id });
    expect(audit.details).toMatchObject({ template: 'waaiio_news', category: 'marketing', sent: 2, merchant_credit_charged: false });
  });

  it('is idempotent: the same request id returns the first result and never sends again', async () => {
    grant();
    expect((await POST(req('POST', sendBody()))).status).toBe(200);
    expect(f.sent).toHaveLength(2);

    // A retry with a fresh step-up, and one with none, both replay.
    grant(descriptor, { id: 'su-2' });
    for (const body of [sendBody({ stepUpId: 'su-2' }), sendBody({ stepUpId: undefined })]) {
      const again = await POST(req('POST', body));
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ replayed: true, status: 'sent', sent: 2, skipped: { optedOut: 1, suspended: 1 } });
    }
    expect(f.sent).toHaveLength(2);
    expect(f.db.tables.admin_broadcasts).toHaveLength(1);
    expect(f.db.tables.admin_step_up_authorizations.find((g: any) => g.id === 'su-2').consumed_at).toBeNull();
  });

  it('fails closed: when suspension or opt-out status cannot be read, nobody in that batch is sent to', async () => {
    for (const table of ['messaging_opt_outs', 'customer_suspensions']) {
      f.db.failReads.clear();
      f.db.failReads.add(table);
      const preview = await (await POST(req('POST', { mode: 'preview', ...specific }))).json();
      expect(preview.counts).toMatchObject({ eligible: 0, unverified: 4, optedOut: 0, suspended: 0 });
    }
    grant();
    const res = await POST(req('POST', sendBody()));
    expect(res.status).toBe(422);
    expect(f.sent).toEqual([]);
    expect(f.db.tables.admin_broadcasts).toEqual([]);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
  });

  it('records unverifiable numbers as skipped when others in the send are deliverable', async () => {
    const { deliverBroadcast } = await import('@/lib/admin-broadcast/whatsapp');
    const sender = { sendPlatformTemplate: vi.fn().mockResolvedValue({ messageId: 'wamid.1' }) };
    const summary = await deliverBroadcast(f.db as any, {
      broadcastId: 'b-1', phones: [NG_OWNER, GB_USER],
      checks: new Map([[NG_OWNER, 'ok'], [GB_USER, 'unverified']]),
      senderFor: async () => ({ accountKey: 'k', sender: sender as any, cloud: {} as any }),
      template: { name: 'waaiio_news', language: 'en_US', category: 'marketing', bodyText: '', paramCount: 1 },
      params: ['x'], intervalMs: 0,
    });
    expect(summary).toMatchObject({ sent: 1, skippedUnverified: 1 });
    expect(sender.sendPlatformTemplate).toHaveBeenCalledTimes(1);
    expect(recipients()).toEqual({ [NG_OWNER]: 'sent', [GB_USER]: 'skipped_unverified' });
  });

  it('a failed number lookup fails only those recipients; the rest are sent and the broadcast is finished', async () => {
    f.lookupFails.add('GB');
    grant();
    const res = await POST(req('POST', sendBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'partial', sent: 1, failed: 1 });
    expect(f.sent.map(s => s.to)).toEqual([NG_OWNER]);
    expect(recipients()[GB_USER]).toBe('failed');
    expect(f.db.tables.admin_broadcasts[0]).toMatchObject({ status: 'partial', recipient_count: 1 });
  });

  it('status mode reads a recorded result and never sends or uses a step-up', async () => {
    const none = await POST(req('POST', { mode: 'status', requestId: REQUEST_ID }));
    expect(await none.json()).toEqual({ recorded: false });
    // A broadcast cut off mid-send: still 'sending', one claimed, two never reached.
    f.db.tables.admin_broadcasts.push({ id: 'b-cut', request_id: REQUEST_ID, status: 'sending', audience_filter: { recipients: 4 } });
    f.db.tables.admin_broadcast_recipients.push(
      { id: 'r1', broadcast_id: 'b-cut', phone: NG_OWNER, status: 'sent' },
      { id: 'r2', broadcast_id: 'b-cut', phone: GB_USER, status: 'sending' },
    );
    const cut = await (await POST(req('POST', { mode: 'status', requestId: REQUEST_ID }))).json();
    expect(cut).toMatchObject({ replayed: true, status: 'sending', sent: 1, unknown: 1, notProcessed: 2 });
    expect((await POST(req('POST', { mode: 'status' }))).status).toBe(400);
    f.role = 'support';
    expect((await POST(req('POST', { mode: 'status', requestId: REQUEST_ID }))).status).toBe(403);
    expect(f.sent).toEqual([]);
  });

  it('skips a Waaiio launch-alert opt-out as well', async () => {
    f.db.tables.launch_subscribers = [{ id: 'l-1', wa_number: GB_USER, opt_in_status: 'opted_out' }];
    grant();
    await POST(req('POST', sendBody()));
    expect(recipients()[GB_USER]).toBe('skipped_opted_out');
    expect(f.sent.map(s => s.to)).toEqual([NG_OWNER]);
  });

  it('records a provider failure per recipient and reports a failed broadcast honestly', async () => {
    grant();
    f.sendError = new Error('(#131026) Message undeliverable');
    const body = await (await POST(req('POST', sendBody()))).json();
    expect(body).toMatchObject({ status: 'failed', sent: 0, failed: 2 });
    expect(recipients()[NG_OWNER]).toBe('failed');
    expect(f.db.tables.admin_broadcast_recipients.find((r: any) => r.phone === NG_OWNER).error).toContain('131026');
    expect(f.db.tables.admin_broadcasts[0]).toMatchObject({ status: 'failed', recipient_count: 0 });
  });

  it('reaches account owners by plan and country, reading local numbers in the business country', async () => {
    f.db.tables.businesses = [
      { id: 'b-1', owner_id: 'u-1', country_code: 'NG', subscription_tier: 'growth' },
      { id: 'b-2', owner_id: 'u-2', country_code: 'NG', subscription_tier: 'free' },
      { id: 'b-3', owner_id: 'u-3', country_code: 'GB', subscription_tier: 'growth' },
    ];
    f.db.tables.profiles = [
      { id: 'u-1', phone: '08012345678' }, { id: 'u-2', phone: '+2348099999999' }, { id: 'u-3', phone: '+447400123456' },
    ];
    const res = await POST(req('POST', { mode: 'preview', templateName: 'waaiio_news', language: 'en_US', audience: 'all_businesses', country: 'NG', plan: 'growth', params: ['x'] }));
    const body = await res.json();
    expect(body.counts).toMatchObject({ matched: 1, eligible: 1 });
    expect(body.descriptor).toMatchObject({ audience: 'all_businesses', country: 'NG', plan: 'growth', phones: [] });
  });
});

describe('platform scope through the real sender (no merchant credit)', () => {
  it('records a platform attempt and never calls the financial authorization', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/channels/meta-cloud');
    const financial: string[] = [];
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
      rpc: (name: string) => { financial.push(name); return Promise.resolve({ data: { authorized: true }, error: null }); },
    }) }));
    const { MetaCloudSender } = await import('@/lib/channels/message-sender');
    const attempts: any[] = [];
    const db: any = {
      from: () => ({
        insert: (row: any) => { attempts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'att-1' }, error: null }) }) }; },
        update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: 'att-1' }], error: null }) }), select: async () => ({ data: [{ id: 'att-1' }], error: null }), then: (r: any) => r({ error: null }) }) }),
      }),
    };
    const provider = { sendTemplate: vi.fn().mockResolvedValue({ messageId: 'wamid.platform' }) };
    const sender = new MetaCloudSender(provider as any, db);

    const result = await sender.sendPlatformTemplate({
      to: NG_OWNER, templateName: 'waaiio_news', languageCode: 'en_US', templateParams: ['New feature'], messageCategory: 'marketing',
    });
    expect(result.messageId).toBe('wamid.platform');
    expect(provider.sendTemplate).toHaveBeenCalledExactlyOnceWith({
      to: NG_OWNER, templateName: 'waaiio_news', languageCode: 'en_US',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'New feature' }] }],
    });
    expect(financial).toEqual([]);
    expect(attempts[0]).toMatchObject({ attempt_scope: 'platform', business_id: null });

    // On a business-bound sender the same call is refused before any provider call.
    const bound = new MetaCloudSender(provider as any, db);
    bound.bindBusiness('biz-1');
    await expect(bound.sendPlatformTemplate({
      to: NG_OWNER, templateName: 'waaiio_news', languageCode: 'en_US', templateParams: ['x'], messageCategory: 'marketing',
    })).rejects.toThrow(/refused on a business-bound sender/);
    expect(provider.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
