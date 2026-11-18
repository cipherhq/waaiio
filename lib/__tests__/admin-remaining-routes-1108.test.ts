/**
 * #1108 remaining non-money items: the new and changed /api/admin routes.
 *
 * Runs the real route handlers against an in-memory table store. Each route
 * must refuse a caller without the page's platform role (403); write routes
 * must report zero-row results as 404/409, change only what they should and
 * audit with the verified admin as actor; read routes must report a failed read
 * as an error and never return secret columns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

type Role = 'admin' | 'support' | 'finance' | 'operations';
const m = vi.hoisted(() => ({
  admin: null as null | { userId: string; role: Role },
  db: null as unknown as MemoryDb,
  audits: [] as Array<Record<string, unknown>>,
  selects: [] as Array<{ table: string; columns: string }>,
  tableErrors: {} as Record<string, { code?: string; message: string }>,
  authUsers: [] as Array<{ id: string; email: string; app_metadata?: Record<string, unknown> }>,
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: async (_req: unknown, opts?: { requiredRole?: Role | Role[] }) => {
    if (!m.admin) return null;
    const required = opts?.requiredRole ? ([] as Role[]).concat(opts.requiredRole) : null;
    return required && !required.includes(m.admin.role) ? null : { ...m.admin, id: m.admin.userId, email: 'a@example.test' };
  },
}));
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: async (entry: Record<string, unknown>) => { m.audits.push(entry); return {}; },
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => {
      if (m.tableErrors[t]) {
        const error = m.tableErrors[t];
        const q: any = new Proxy({}, {
          get: (_target, prop) => prop === 'then'
            ? (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(resolve)
            : prop === 'maybeSingle' || prop === 'single' ? async () => ({ data: null, error }) : () => q,
        });
        return q;
      }
      const q = m.db.from(t);
      const select = q.select;
      q.select = (columns?: string, opts?: unknown) => { m.selects.push({ table: t, columns: columns || '' }); return select(columns, opts); };
      return q;
    },
    auth: { admin: { listUsers: async () => ({ data: { users: m.authUsers }, error: null }) } },
  }),
}));

import * as botSessions from '@/app/api/admin/bot-sessions/route';
import * as assignees from '@/app/api/admin/team/assignees/route';
import * as surveys from '@/app/api/admin/surveys/route';
import * as recurring from '@/app/api/admin/recurring/route';
import * as channelChanges from '@/app/api/admin/channel-changes/route';
import * as profile from '@/app/api/admin/businesses/[id]/profile/route';

const ADMIN = '00000000-0000-4000-8000-00000000000a';
const BIZ = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://admin-staging.waaiio.com';

function req(url: string, method = 'POST', body?: unknown) {
  return new NextRequest(`https://staging.waaiio.com${url}`, {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (role: Role) => { m.admin = { userId: ADMIN, role }; };

beforeEach(() => {
  m.admin = null; m.audits = []; m.selects = []; m.tableErrors = {}; m.authUsers = [];
  m.db = createMemoryDb({
    businesses: [{ id: BIZ, name: 'Grace Church', category: 'church', city: 'Lagos', phone: '+2348000000000', email: 'old@example.test' }],
    bot_sessions: [
      { id: ID, business_id: BIZ, whatsapp_number: '2348011111111', is_active: true },
      { id: OTHER, business_id: BIZ, whatsapp_number: '2348022222222', is_active: true },
      { id: 'ended', business_id: BIZ, whatsapp_number: '2348011111111', is_active: false },
      { id: 'elsewhere', business_id: 'other-biz', whatsapp_number: '2348011111111', is_active: true },
    ],
    blocked_phones: [],
    surveys: [{ id: ID, business_id: BIZ, title: 'Feedback', status: 'active', questions: [], total_responses: 1, created_at: '2026-11-01T00:00:00Z' }],
    survey_responses: [
      { id: 'r1', survey_id: ID, business_id: BIZ, customer_phone: '234', answers: {}, completed: true, started_at: '2026-11-02T00:00:00Z' },
      { id: 'r2', survey_id: OTHER, business_id: BIZ, customer_phone: '235', answers: {}, completed: false, started_at: '2026-11-03T00:00:00Z' },
    ],
    customer_subscriptions: [{ id: ID, business_id: BIZ, service_id: 'svc', amount: 5000, status: 'active', authorization_code: 'AUTH_secret', created_at: '2026-11-01T00:00:00Z' }],
    services: [{ id: 'svc', name: 'Monthly tithe', billing_type: 'recurring' }],
  });
});

describe('POST /api/admin/bot-sessions (X2)', () => {
  it('refuses every role except admin, matching the page', async () => {
    for (const role of ['support', 'finance', 'operations'] as Role[]) {
      as(role);
      const res = await botSessions.POST(req('/api/admin/bot-sessions', 'POST', { action: 'end', session_id: ID }));
      expect(res.status).toBe(403);
    }
    expect(m.db.tables.bot_sessions.find(s => s.id === ID)!.is_active).toBe(true);
  });

  it('ends one active session and audits; an ended or missing session is 409/404, not success', async () => {
    as('admin');
    const res = await botSessions.POST(req('/api/admin/bot-sessions', 'POST', { action: 'end', session_id: ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: 1, auditRecorded: true });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(m.db.tables.bot_sessions.find(s => s.id === ID)!.is_active).toBe(false);
    expect(m.db.tables.bot_sessions.find(s => s.id === OTHER)!.is_active).toBe(true);
    expect(m.audits).toEqual([expect.objectContaining({ actorId: ADMIN, action: 'kill_bot_session', entityId: ID, details: { business_id: BIZ, phone: '2348011111111' } })]);

    const again = await botSessions.POST(req('/api/admin/bot-sessions', 'POST', { action: 'end', session_id: ID }));
    expect(again.status).toBe(409);
    const missing = await botSessions.POST(req('/api/admin/bot-sessions', 'POST', { action: 'end', session_id: '44444444-4444-4444-8444-444444444444' }));
    expect(missing.status).toBe(404);
    expect(m.audits).toHaveLength(1);
  });

  it('ends all active sessions of one business only and reports the real count', async () => {
    as('admin');
    const res = await botSessions.POST(req('/api/admin/bot-sessions', 'POST', { action: 'end_all', business_id: BIZ }));
    expect(await res.json()).toEqual({ ended: 2, auditRecorded: true });
    expect(m.db.tables.bot_sessions.find(s => s.id === 'elsewhere')!.is_active).toBe(true);
    expect(m.audits[0]).toMatchObject({ action: 'kill_all_bot_sessions', entityId: BIZ, details: { sessions_ended: 2 } });
  });

  it('blocks a phone for that business, ends only its sessions there, and audits', async () => {
    as('admin');
    const res = await botSessions.POST(req('/api/admin/bot-sessions', 'POST', { action: 'block', business_id: BIZ, phone: '2348011111111' }));
    expect(await res.json()).toEqual({ blocked: true, ended: 1, auditRecorded: true });
    expect(m.db.tables.blocked_phones).toEqual([expect.objectContaining({ business_id: BIZ, phone: '2348011111111', blocked_by: ADMIN })]);
    expect(m.db.tables.bot_sessions.find(s => s.id === ID)!.is_active).toBe(false);
    expect(m.db.tables.bot_sessions.find(s => s.id === OTHER)!.is_active).toBe(true);
    expect(m.db.tables.bot_sessions.find(s => s.id === 'elsewhere')!.is_active).toBe(true);
    expect(m.audits[0]).toMatchObject({ action: 'block_phone', entityId: BIZ, details: { phone: '2348011111111', sessions_ended: 1 } });
  });

  it('rejects bad input and unknown businesses without writing', async () => {
    as('admin');
    const cases: Array<[unknown, number]> = [
      [{ action: 'end', session_id: 'not-a-uuid' }, 400],
      [{ action: 'block', business_id: BIZ, phone: 'abc' }, 400],
      [{ action: 'end_all', business_id: '44444444-4444-4444-8444-444444444444' }, 404],
      [{ action: 'explode', business_id: BIZ }, 400],
    ];
    for (const [body, status] of cases) {
      expect((await botSessions.POST(req('/api/admin/bot-sessions', 'POST', body))).status).toBe(status);
    }
    expect(m.db.writes).toEqual([]);
    expect(m.audits).toEqual([]);
  });
});

describe('GET /api/admin/team/assignees', () => {
  beforeEach(() => {
    m.authUsers = [
      { id: 'adm', email: 'ada@example.test', app_metadata: { role: 'admin' } },
      { id: 'sup', email: 'sam@example.test', app_metadata: { role: 'support' } },
      { id: 'fin', email: 'fin@example.test', app_metadata: { role: 'finance' } },
      { id: 'cust', email: 'c@example.test', app_metadata: {} },
    ];
    m.db.tables.profiles = [{ id: 'adm', first_name: 'Ada', last_name: 'Admin' }];
  });

  it('lets admin and support see admin and support members, with names only', async () => {
    for (const role of ['admin', 'support'] as Role[]) {
      as(role);
      const res = await assignees.GET(req('/api/admin/team/assignees', 'GET'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ assignees: [{ id: 'adm', name: 'Ada Admin' }, { id: 'sup', name: 'sam' }] });
    }
  });

  it('refuses finance and operations', async () => {
    for (const role of ['finance', 'operations'] as Role[]) {
      as(role);
      expect((await assignees.GET(req('/api/admin/team/assignees', 'GET'))).status).toBe(403);
    }
  });
});

describe('GET /api/admin/surveys (X3)', () => {
  it('admin and operations read surveys with business names; support and finance cannot', async () => {
    as('operations');
    const res = await surveys.GET(req('/api/admin/surveys', 'GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).surveys).toEqual([expect.objectContaining({ id: ID, title: 'Feedback', business_name: 'Grace Church' })]);
    for (const role of ['support', 'finance'] as Role[]) {
      as(role);
      expect((await surveys.GET(req('/api/admin/surveys', 'GET'))).status).toBe(403);
    }
  });

  it('returns only the asked survey\'s responses and validates the ID', async () => {
    as('admin');
    const res = await surveys.GET(req(`/api/admin/surveys?survey_id=${ID}`, 'GET'));
    expect((await res.json()).responses.map((r: { id: string }) => r.id)).toEqual(['r1']);
    expect((await surveys.GET(req('/api/admin/surveys?survey_id=x', 'GET'))).status).toBe(400);
  });

  it('reports a failed read as an error', async () => {
    as('admin');
    m.db.failReads.add('surveys');
    const res = await surveys.GET(req('/api/admin/surveys', 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load surveys' });
  });
});

describe('GET /api/admin/recurring (X3, read only)', () => {
  it('admin and finance read records with names and never ask for card authorization or gateway codes', async () => {
    as('finance');
    const res = await recurring.GET(req('/api/admin/recurring', 'GET'));
    expect(res.status).toBe(200);
    const [record] = (await res.json()).records;
    expect(record).toMatchObject({ id: ID, business_name: 'Grace Church', service_name: 'Monthly tithe', service_billing_type: 'recurring' });
    const columns = m.selects.find(s => s.table === 'customer_subscriptions')!.columns;
    expect(columns).not.toMatch(/authorization_code|gateway_customer_code|gateway_plan_code|\*/);
  });

  it('refuses support and operations, and reports a failed read', async () => {
    for (const role of ['support', 'operations'] as Role[]) {
      as(role);
      expect((await recurring.GET(req('/api/admin/recurring', 'GET'))).status).toBe(403);
    }
    as('admin');
    m.db.failReads.add('customer_subscriptions');
    expect((await recurring.GET(req('/api/admin/recurring', 'GET'))).status).toBe(500);
  });
});

describe('GET /api/admin/channel-changes when M496 is not installed', () => {
  beforeEach(() => { vi.stubEnv('ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'true'); });

  it.each(['42P01', 'PGRST205'])('answers 503 CHANNEL_CHANGES_NOT_INSTALLED for missing-table code %s', async code => {
    as('admin');
    m.tableErrors.channel_change_approvals = { code, message: 'relation "channel_change_approvals" does not exist' };
    const res = await channelChanges.GET(req('/api/admin/channel-changes', 'GET'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'CHANNEL_CHANGES_NOT_INSTALLED', error: 'Channel change requests are not set up on this environment yet.' });
  });

  it('keeps any other read failure a 500', async () => {
    as('admin');
    m.tableErrors.channel_change_approvals = { code: '42501', message: 'permission denied' };
    expect((await channelChanges.GET(req('/api/admin/channel-changes', 'GET'))).status).toBe(500);
  });
});

describe('POST /api/admin/businesses/[id]/profile: phone and email (Impersonation, X2)', () => {
  it('saves a valid phone and email, guarded by the previous value, and audits', async () => {
    as('admin');
    const res = await profile.POST(req(`/api/admin/businesses/${BIZ}/profile`, 'POST', { field: 'phone', value: '+234 801 234 5678' }), params(BIZ));
    expect(res.status).toBe(200);
    expect((await res.json()).business).toEqual({ id: BIZ, phone: '+234 801 234 5678' });
    const email = await profile.POST(req(`/api/admin/businesses/${BIZ}/profile`, 'POST', { field: 'email', value: 'new@example.test' }), params(BIZ));
    expect((await email.json()).business).toEqual({ id: BIZ, email: 'new@example.test' });
    expect(m.audits.map(a => (a.details as Record<string, unknown>).field)).toEqual(['phone', 'email']);
    expect(m.audits[0]).toMatchObject({ actorId: ADMIN, action: 'edit_business_field', details: { previous_value: '+2348000000000' } });
  });

  it('rejects invalid values and fields bot routing depends on', async () => {
    as('admin');
    const bad: Array<Record<string, unknown>> = [
      { field: 'phone', value: '' },
      { field: 'phone', value: 'call me' },
      { field: 'phone', value: '+123456789012345678901' },
      { field: 'email', value: 'not-an-email' },
      { field: 'slug', value: 'new-slug' },
      { field: 'flow_type', value: 'x' },
    ];
    for (const body of bad) {
      expect((await profile.POST(req(`/api/admin/businesses/${BIZ}/profile`, 'POST', body), params(BIZ))).status).toBe(400);
    }
    expect(m.db.tables.businesses[0]).toMatchObject({ phone: '+2348000000000', email: 'old@example.test' });
    expect(m.audits).toEqual([]);
  });

  it('is still admin-only', async () => {
    as('support');
    expect((await profile.POST(req(`/api/admin/businesses/${BIZ}/profile`, 'POST', { field: 'phone', value: '+2348012345678' }), params(BIZ))).status).toBe(403);
  });
});
