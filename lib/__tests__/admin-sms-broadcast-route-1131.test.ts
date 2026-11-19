// #1131: /api/admin/broadcasts/sms with the real requirePlatformAdmin, the
// real consumeStepUp and the real recipient, opt-out, suspension, delivery and
// platform-SMS logic. Synthetic: Supabase Auth, the in-memory tables and the
// BulkSMS provider call (no SMS is sent anywhere). Waaiio pays: the route must
// never reserve or charge merchant messaging credit.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';
import { hashOperationParams } from '@/lib/admin-step-up';

const f = vi.hoisted(() => ({
  role: 'admin' as string, db: null as any, rpcCalls: [] as string[], sent: [] as any[], configured: true,
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async (token: string) => token === 'good'
      ? { data: { claims: { sub: 'admin-1', aal: 'aal2', session_id: 'sess-1' } } } : { error: new Error('invalid') },
    getUser: async () => ({ data: { user: { id: 'admin-1', email: 'a@x.test', app_metadata: { role: f.role } } } }),
  },
  rpc: (name: string) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) };
    f.rpcCalls.push(name);
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
  },
  from: (table: string) => f.db.from(table),
}) }));
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: async (e: any) => {
    await f.db.from('admin_audit_logs').insert({ actor_id: e.actorId, action: e.action, entity_id: e.entityId ?? null, details: e.details ?? null });
    return {};
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('cookie client not expected'); } }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null }));
vi.mock('@/lib/sms/bulksms-ng', () => ({
  isSmsConfigured: () => f.configured,
  sendSms: async (msg: any) => { f.sent.push(msg); return { sent: true, messageId: `m-${msg.to}`, cost: 6.49, pages: 1 }; },
}));

import { POST } from '@/app/api/admin/broadcasts/sms/route';

const NG_OWNER = '2348012345678';
const NG_OPTED_OUT = '2348022222222';
const NG_SUSPENDED = '2348033333333';
const GH_USER = '233201234567';
const GB_USER = '447400123456';
const REQUEST_ID = '6f1c2f9e-6c2a-4d7e-9a51-2b0c1e4d1131';
const MESSAGE = 'Waaiio is now on SMS';
// 13:00 WAT / 12:00 GMT: outside quiet hours in both countries.
const DAY = new Date('2026-11-18T12:00:00Z');

const req = (body: unknown, token = 'good') => new NextRequest('https://app.test/api/admin/broadcasts/sms', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const specific = { audience: 'specific', message: MESSAGE, phones: [`+${NG_OWNER}`, NG_OPTED_OUT, `+${NG_SUSPENDED}`, `+${GH_USER}`, `+${GB_USER}`] };
const descriptor = {
  audience: 'specific', country: null, plan: null, message: MESSAGE,
  phones: [GB_USER, GH_USER, NG_OPTED_OUT, NG_OWNER, NG_SUSPENDED].sort(),
};
function grant(params: Record<string, unknown> = descriptor) {
  f.db.tables.admin_step_up_authorizations.push({
    id: 'su-1', admin_user_id: 'admin-1', session_id: 'sess-1', action_type: 'admin_broadcast', target_id: REQUEST_ID,
    params_hash: hashOperationParams(params), verified_at: new Date().toISOString(), consumed_at: null,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  });
}
const sendBody = (extra: Record<string, unknown> = {}) => ({ mode: 'send', requestId: REQUEST_ID, stepUpId: 'su-1', ...specific, ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DAY);
  f.role = 'admin'; f.rpcCalls = []; f.sent = []; f.configured = true;
  f.db = createMemoryDb({
    admin_step_up_authorizations: [], admin_audit_logs: [], admin_broadcasts: [], admin_broadcast_recipients: [],
    sms_sends: [], message_send_attempts: [],
    customer_suspensions: [{ id: 's-1', phone: NG_SUSPENDED }],
    messaging_opt_outs: [{ id: 'o-1', phone: `+${NG_OPTED_OUT}`, business_id: null, channel: 'whatsapp', resubscribed_at: null }],
    launch_subscribers: [], profiles: [], businesses: [],
    platform_config_versions: [{ id: 'cfg-1', effective_from: '2026-01-01T00:00:00Z', config_snapshot: { messaging_pricing: {
      NGN: { rates: { NG: { marketing: 2000, sms_cost: 698 } } },
      GHS: { rates: { GH: { marketing: 80, sms_cost: 50 } } },
    } } }],
  }, { admin_broadcasts: [['request_id']], admin_broadcast_recipients: [['broadcast_id', 'phone']], sms_sends: [['idempotency_key']] });
});

describe('admin SMS broadcasts (#1131)', () => {
  it('refuses a support admin and a send without a matching step-up', async () => {
    f.role = 'support';
    expect((await POST(req({ mode: 'preview', ...specific }))).status).toBe(403);
    f.role = 'admin';
    const none = await POST(req(sendBody({ stepUpId: undefined })));
    expect(none.status).toBe(403);
    grant({ ...descriptor, message: 'Something else' });
    expect((await POST(req(sendBody()))).status).toBe(403);
    expect(f.sent).toEqual([]);
  });

  it('previews NG/GH recipients, skips and Waaiio\'s own cost without sending', async () => {
    const body = await (await POST(req({ mode: 'preview', ...specific }))).json();
    expect(body.counts).toEqual({ matched: 5, withoutNumber: 0, notSmsCountry: 1, eligible: 2, optedOut: 1, suspended: 1, unverified: 0 });
    expect(body.sms).toMatchObject({ pages: 1, unicode: false });
    // Waaiio's cost, no 20% margin: NG 698 kobo, GH 50 pesewas.
    expect(body.estimate).toEqual({ byCurrency: [{ currency: 'GHS', amountMinor: 50, recipients: 1 }, { currency: 'NGN', amountMinor: 698, recipients: 1 }], unpriced: 0 });
    expect(body.descriptor).toEqual(descriptor);
    expect(f.sent).toEqual([]);
  });

  it('sends each eligible number once, Waaiio-paid: no attempt, reservation or charge', async () => {
    grant();
    const res = await POST(req(sendBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'sent', sent: 2, failed: 0, skipped: { optedOut: 1, suspended: 1, unverified: 0 } });
    expect(f.sent.map(s => s.to).sort()).toEqual([GH_USER, NG_OWNER]);
    expect(f.rpcCalls).toEqual([]);
    expect(f.db.tables.message_send_attempts).toEqual([]);
    expect(f.db.tables.sms_sends.every((r: any) => r.scope === 'platform' && r.business_id === null && r.status === 'accepted')).toBe(true);
    expect(f.db.tables.admin_broadcasts[0]).toMatchObject({ channel: 'sms', status: 'sent', recipient_count: 2 });
    const audit = f.db.tables.admin_audit_logs.find((a: any) => a.action === 'send_sms_broadcast');
    expect(audit.details.merchant_credit_charged).toBe(false);

    // A retry of the same request returns the first result and sends nothing.
    const again = await (await POST(req(sendBody()))).json();
    expect(again).toMatchObject({ replayed: true, sent: 2 });
    expect(f.sent).toHaveLength(2);
  });

  it('refuses during quiet hours and while SMS is switched off, before using the step-up', async () => {
    grant();
    vi.setSystemTime(new Date('2026-11-18T19:30:00Z')); // 20:30 WAT
    const quiet = await POST(req(sendBody()));
    expect(quiet.status).toBe(422);
    expect((await quiet.json()).error).toContain('8pm and 8am');
    vi.setSystemTime(DAY);
    f.configured = false;
    expect((await POST(req(sendBody()))).status).toBe(422);
    expect(f.sent).toEqual([]);
    expect(f.db.tables.admin_step_up_authorizations[0].consumed_at).toBeNull();
  });
});
