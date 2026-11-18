/**
 * #1108 X1–X3 server routes: the admin panel's writes and hidden reads.
 *
 * Runs the real route handlers against an in-memory table store. Each write
 * route must: refuse a caller without the right platform role (403), report a
 * zero-row result as 404/409 instead of success, change only what it should,
 * and write an audit entry with the verified admin as actor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

type Role = 'admin' | 'support' | 'finance' | 'operations';
const m = vi.hoisted(() => ({
  admin: null as null | { userId: string; role: Role },
  db: null as unknown as MemoryDb,
  audits: [] as Array<Record<string, unknown>>,
  auditError: null as null | string,
  authUsers: {} as Record<string, { id: string; email: string; banned_until?: string | null; app_metadata?: Record<string, unknown> }>,
  banCalls: [] as Array<{ id: string; ban_duration: string }>,
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: async (_req: unknown, opts?: { requiredRole?: Role | Role[] }) => {
    if (!m.admin) return null;
    const required = opts?.requiredRole ? ([] as Role[]).concat(opts.requiredRole) : null;
    return required && !required.includes(m.admin.role) ? null : { ...m.admin, id: m.admin.userId, email: 'a@example.test' };
  },
}));
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: async (entry: Record<string, unknown>) => {
    if (m.auditError) return { error: m.auditError };
    m.audits.push(entry);
    return {};
  },
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => m.db.from(t),
    auth: { admin: {
      getUserById: async (id: string) => m.authUsers[id]
        ? { data: { user: { ...m.authUsers[id] } }, error: null }
        : { data: { user: null }, error: { status: 404, message: 'not found' } },
      updateUserById: async (id: string, attrs: { ban_duration: string }) => {
        m.banCalls.push({ id, ...attrs });
        const u = m.authUsers[id];
        u.banned_until = attrs.ban_duration === 'none' ? null : new Date(Date.now() + 3_600_000).toISOString();
        return { data: { user: { ...u } }, error: null };
      },
      listUsers: async () => ({ data: { users: Object.values(m.authUsers) }, error: null }),
    } },
  }),
}));

import * as audit from '@/app/api/admin/audit/route';
import * as campaign from '@/app/api/admin/campaigns/[id]/route';
import * as marketplace from '@/app/api/admin/businesses/[id]/marketplace/route';
import * as ticketCancel from '@/app/api/admin/tickets/[id]/cancel/route';
import * as alerts from '@/app/api/admin/alerts/route';
import * as keywords from '@/app/api/admin/bot-keywords/route';
import * as userRoute from '@/app/api/admin/users/[id]/route';
import * as usersList from '@/app/api/admin/users/route';
import * as chat from '@/app/api/admin/chat-history/route';
import * as reports from '@/app/api/admin/customer-reports/route';
import * as queue from '@/app/api/admin/queue-entries/route';

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
  m.admin = null; m.audits = []; m.auditError = null; m.authUsers = {}; m.banCalls = [];
  m.db = createMemoryDb({
    businesses: [{ id: BIZ, name: 'Grace Church', is_verified: false, discovery_enabled: true }],
    campaigns: [{ id: ID, business_id: BIZ, title: 'Roof', goal_amount: 1000, raised_amount: 250, start_date: null, end_date: null, status: 'active' }],
    event_tickets: [
      { id: ID, business_id: BIZ, event_id: 'ev', ticket_code: 'TK-1', status: 'valid' },
      { id: OTHER, business_id: BIZ, event_id: 'ev', ticket_code: 'TK-2', status: 'used' },
    ],
    alerts: [
      { id: ID, business_id: BIZ, type: 't', title: 'A', is_read: false },
      { id: OTHER, business_id: BIZ, type: 't', title: 'B', is_read: false },
    ],
    bot_keywords: [
      { id: ID, keyword: 'hello', match_type: 'exact', action_type: 'reply', payload: 'Hi', is_active: true, priority: 50, scope: 'system', category: null, description: null, business_id: null },
      { id: OTHER, keyword: 'menu', match_type: 'exact', action_type: 'reply', payload: 'M', is_active: true, priority: 10, scope: 'business', category: null, description: null, business_id: BIZ },
    ],
    profiles: [{ id: ID, role: 'restaurant_owner' }],
  });
});

describe('POST /api/admin/audit (X1)', () => {
  it('refuses a caller who is not a platform admin', async () => {
    const res = await audit.POST(req('/api/admin/audit', 'POST', { action: 'edit_campaign', entity_id: ID }));
    expect(res.status).toBe(403);
    expect(m.audits).toEqual([]);
  });

  it('records the verified admin as actor, never a body value, and keeps non-UUID ids in details', async () => {
    as('support');
    const res = await audit.POST(req('/api/admin/audit', 'POST', {
      action: 'update_country', entity_type: 'country', entity_id: 'NG', details: { name: 'Nigeria' }, actor_id: OTHER,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(m.audits).toEqual([{
      actorId: ADMIN, action: 'update_country', entityType: 'country', entityId: null,
      details: { name: 'Nigeria', entity_ref: 'NG', source: 'admin_panel' }, ipAddress: '203.0.113.7',
    }]);
  });

  it.each([
    [{ action: 'Bad Action', entity_id: ID }],
    [{ action: 'x'.repeat(51), entity_id: ID }],
    [{ action: 'ok', entity_id: ID, details: ['not', 'an', 'object'] }],
    [{ action: 'ok', entity_id: ID, details: { big: 'x'.repeat(9000) } }],
  ])('rejects invalid input %#', async body => {
    as('admin');
    expect((await audit.POST(req('/api/admin/audit', 'POST', body))).status).toBe(400);
    expect(m.audits).toEqual([]);
  });

  it('reports a failed audit write as an error', async () => {
    as('admin'); m.auditError = 'insert failed';
    const res = await audit.POST(req('/api/admin/audit', 'POST', { action: 'edit_campaign', entity_id: ID }));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/campaigns/[id] (X2)', () => {
  const edit = { title: 'New roof', goal_amount: 5000, start_date: '2026-12-01', end_date: '2026-12-31', status: 'paused' };

  it.each(['support', 'operations', 'finance'] as Role[])('refuses %s', async role => {
    as(role);
    expect((await campaign.POST(req(`/api/admin/campaigns/${ID}`, 'POST', edit), params(ID))).status).toBe(403);
    expect(m.db.writes).toEqual([]);
  });

  it('saves only the editable fields and audits before/after', async () => {
    as('admin');
    const res = await campaign.POST(req(`/api/admin/campaigns/${ID}`, 'POST', edit), params(ID));
    expect(res.status).toBe(200);
    const row = m.db.tables.campaigns[0];
    expect(row).toMatchObject({ title: 'New roof', goal_amount: 5000, status: 'paused', raised_amount: 250 });
    expect(m.audits[0]).toMatchObject({ actorId: ADMIN, action: 'edit_campaign', entityId: ID });
  });

  it('reports a missing campaign as 404, not success', async () => {
    as('admin');
    const res = await campaign.POST(req(`/api/admin/campaigns/${OTHER}`, 'POST', edit), params(OTHER));
    expect(res.status).toBe(404);
    expect(m.audits).toEqual([]);
  });

  it.each([
    [{ ...edit, status: 'archived' }], [{ ...edit, goal_amount: -1 }], [{ ...edit, title: ' ' }],
    [{ ...edit, end_date: '2026-11-01' }], [{ ...edit, raised_amount: 0 }],
  ])('rejects invalid input %#', async body => {
    as('admin');
    expect((await campaign.POST(req(`/api/admin/campaigns/${ID}`, 'POST', body), params(ID))).status).toBe(400);
    expect(m.db.writes).toEqual([]);
  });
});

describe('POST /api/admin/businesses/[id]/marketplace (X2)', () => {
  it('refuses non-admin roles', async () => {
    as('operations');
    expect((await marketplace.POST(req(`/api/admin/businesses/${BIZ}/marketplace`, 'POST', { is_verified: true }), params(BIZ))).status).toBe(403);
  });

  it('updates only the requested flag and audits', async () => {
    as('admin');
    const res = await marketplace.POST(req(`/api/admin/businesses/${BIZ}/marketplace`, 'POST', { is_verified: true }), params(BIZ));
    expect(res.status).toBe(200);
    expect((await res.json()).business).toMatchObject({ is_verified: true, discovery_enabled: true });
    expect(m.audits[0]).toMatchObject({ action: 'update_marketplace_flags', entityId: BIZ });
  });

  it.each([[{}], [{ is_verified: 'yes' }], [{ status: 'active' }]])('rejects %j', async body => {
    as('admin');
    expect((await marketplace.POST(req(`/api/admin/businesses/${BIZ}/marketplace`, 'POST', body), params(BIZ))).status).toBe(400);
  });

  it('reports an unknown business as 404', async () => {
    as('admin');
    expect((await marketplace.POST(req(`/api/admin/businesses/${ID}/marketplace`, 'POST', { is_verified: true }), params(ID))).status).toBe(404);
  });
});

describe('POST /api/admin/tickets/[id]/cancel (X2)', () => {
  it('refuses finance', async () => {
    as('finance');
    expect((await ticketCancel.POST(req(`/api/admin/tickets/${ID}/cancel`), params(ID))).status).toBe(403);
    expect(m.db.tables.event_tickets[0].status).toBe('valid');
  });

  it('cancels a valid ticket, status only, and audits', async () => {
    as('support');
    const res = await ticketCancel.POST(req(`/api/admin/tickets/${ID}/cancel`), params(ID));
    expect(res.status).toBe(200);
    expect(m.db.tables.event_tickets[0].status).toBe('cancelled');
    expect(m.db.writes.map(w => w.table)).toEqual(['event_tickets']);
    expect(m.audits[0]).toMatchObject({ action: 'cancel_ticket', entityId: ID });
  });

  it('reports a ticket that is not valid as 409 (zero rows changed)', async () => {
    as('admin');
    const res = await ticketCancel.POST(req(`/api/admin/tickets/${OTHER}/cancel`), params(OTHER));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/used/);
    expect(m.db.tables.event_tickets[1].status).toBe('used');
    expect(m.audits).toEqual([]);
  });

  it('reports a missing ticket as 404', async () => {
    as('admin');
    const missing = '44444444-4444-4444-8444-444444444444';
    expect((await ticketCancel.POST(req(`/api/admin/tickets/${missing}/cancel`), params(missing))).status).toBe(404);
  });
});

describe('POST /api/admin/alerts (X2)', () => {
  it('refuses finance and callers with no role', async () => {
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_read', id: ID }))).status).toBe(403);
    as('finance');
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_read', id: ID }))).status).toBe(403);
  });

  it('lets support mark one read but not dismiss or mark all', async () => {
    as('support');
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_read', id: ID }))).status).toBe(200);
    expect(m.db.tables.alerts[0].is_read).toBe(true);
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'dismiss', id: ID }))).status).toBe(403);
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_all_read', ids: [OTHER] }))).status).toBe(403);
    expect(m.db.tables.alerts).toHaveLength(2);
  });

  it('reports zero-row results instead of success', async () => {
    as('admin');
    const missing = '44444444-4444-4444-8444-444444444444';
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_read', id: missing }))).status).toBe(404);
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'dismiss', id: missing }))).status).toBe(404);
    expect((await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_all_read', ids: [missing] }))).status).toBe(409);
    expect(m.audits).toEqual([]);
  });

  it('mark all read returns the IDs actually updated; dismiss deletes and audits', async () => {
    as('admin');
    const all = await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'mark_all_read', ids: [ID, OTHER] }));
    expect(await all.json()).toMatchObject({ updated: 2, ids: [ID, OTHER] });
    const dismissed = await alerts.POST(req('/api/admin/alerts', 'POST', { action: 'dismiss', id: ID }));
    expect(dismissed.status).toBe(200);
    expect(m.db.tables.alerts.map(a => a.id)).toEqual([OTHER]);
    expect(m.audits.map(a => a.action)).toEqual(['mark_all_alerts_read', 'dismiss_alert']);
  });
});

describe('/api/admin/bot-keywords (X2/X3)', () => {
  const full = { keyword: 'hours', match_type: 'contains', scope: 'category', category: 'church', action_type: 'reply', payload: 'Sunday 9am', description: '', is_active: true, priority: 60 };

  it('refuses support and finance for reads and writes', async () => {
    for (const role of ['support', 'finance'] as Role[]) {
      as(role);
      expect((await keywords.GET(req('/api/admin/bot-keywords', 'GET'))).status).toBe(403);
      expect((await keywords.POST(req('/api/admin/bot-keywords', 'POST', full))).status).toBe(403);
    }
  });

  it('lists every scope for operations (the X3 read)', async () => {
    as('operations');
    const res = await keywords.GET(req('/api/admin/bot-keywords', 'GET'));
    expect((await res.json()).keywords.map((k: { scope: string }) => k.scope).sort()).toEqual(['business', 'system']);
  });

  it('creates a category keyword with business_id null and audits', async () => {
    as('admin');
    const res = await keywords.POST(req('/api/admin/bot-keywords', 'POST', full));
    expect(res.status).toBe(201);
    expect(m.db.tables.bot_keywords[2]).toMatchObject({ keyword: 'hours', scope: 'category', category: 'church', business_id: null, description: null });
    expect(m.audits[0]).toMatchObject({ action: 'create_bot_keyword' });
  });

  it.each([
    [{ ...full, scope: 'business' }], [{ ...full, category: '' }], [{ ...full, match_type: 'fuzzy' }],
    [{ ...full, match_type: 'regex', keyword: '([' }], [{ ...full, business_id: BIZ }],
  ])('rejects invalid keywords %#', async body => {
    as('admin');
    expect((await keywords.POST(req('/api/admin/bot-keywords', 'POST', body))).status).toBe(400);
    expect(m.db.writes).toEqual([]);
  });

  it('toggles any scope but refuses editing or deleting a business keyword', async () => {
    as('admin');
    const toggle = await keywords.PATCH(req('/api/admin/bot-keywords', 'PATCH', { id: OTHER, is_active: false }));
    expect(toggle.status).toBe(200);
    expect(m.db.tables.bot_keywords[1].is_active).toBe(false);
    expect((await keywords.PATCH(req('/api/admin/bot-keywords', 'PATCH', { id: OTHER, ...full, scope: 'system' }))).status).toBe(403);
    expect((await keywords.DELETE(req('/api/admin/bot-keywords', 'DELETE', { id: OTHER }))).status).toBe(403);
    expect(m.db.tables.bot_keywords).toHaveLength(2);
  });

  it('reports a missing keyword as 404 for edit and delete', async () => {
    as('admin');
    const missing = '44444444-4444-4444-8444-444444444444';
    expect((await keywords.PATCH(req('/api/admin/bot-keywords', 'PATCH', { id: missing, is_active: false }))).status).toBe(404);
    expect((await keywords.DELETE(req('/api/admin/bot-keywords', 'DELETE', { id: missing }))).status).toBe(404);
  });

  it('deletes a system keyword and audits', async () => {
    as('operations');
    expect((await keywords.DELETE(req('/api/admin/bot-keywords', 'DELETE', { id: ID }))).status).toBe(200);
    expect(m.db.tables.bot_keywords.map(k => k.id)).toEqual([OTHER]);
    expect(m.audits[0]).toMatchObject({ action: 'delete_bot_keyword', entityId: ID });
  });
});

describe('/api/admin/users (X2)', () => {
  beforeEach(() => {
    m.authUsers = {
      [ID]: { id: ID, email: 'owner@example.test', banned_until: null, app_metadata: {} },
      [OTHER]: { id: OTHER, email: 'staff@example.test', banned_until: null, app_metadata: { role: 'support' } },
      [ADMIN]: { id: ADMIN, email: 'a@example.test', banned_until: null, app_metadata: { role: 'admin' } },
    };
  });

  it.each(['support', 'finance', 'operations'] as Role[])('refuses %s', async role => {
    as(role);
    expect((await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'suspend' }), params(ID))).status).toBe(403);
    expect((await usersList.GET(req('/api/admin/users', 'GET'))).status).toBe(403);
    expect(m.banCalls).toEqual([]);
  });

  it('suspends with an Auth ban, then reactivates, and audits both', async () => {
    as('admin');
    const res = await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'suspend' }), params(ID));
    expect(res.status).toBe(200);
    expect(m.banCalls).toEqual([{ id: ID, ban_duration: '876000h' }]);
    const list = await (await usersList.GET(req('/api/admin/users', 'GET'))).json();
    expect(list).toEqual({ suspendedIds: [ID], platformRoles: { [OTHER]: 'support', [ADMIN]: 'admin' } });
    expect((await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'suspend' }), params(ID))).status).toBe(409);
    expect((await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'reactivate' }), params(ID))).status).toBe(200);
    expect(m.audits.map(a => a.action)).toEqual(['suspend_user', 'reactivate_user']);
  });

  it('refuses platform team members and the admin themself', async () => {
    as('admin');
    expect((await userRoute.POST(req(`/api/admin/users/${OTHER}`, 'POST', { action: 'suspend' }), params(OTHER))).status).toBe(409);
    expect((await userRoute.POST(req(`/api/admin/users/${ADMIN}`, 'POST', { action: 'suspend' }), params(ADMIN))).status).toBe(409);
    expect(m.banCalls).toEqual([]);
  });

  it('changes the account role only to a user_role account value, guarded by the previous role', async () => {
    as('admin');
    for (const role of ['admin', 'support', 'customer', 'business_owner']) {
      expect((await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'set_role', role, previous_role: 'restaurant_owner' }), params(ID))).status).toBe(400);
    }
    const stale = await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'set_role', role: 'restaurant_staff', previous_role: 'restaurant_staff' }), params(ID));
    expect(stale.status).toBe(409);
    expect(m.db.tables.profiles[0].role).toBe('restaurant_owner');
    const ok = await userRoute.POST(req(`/api/admin/users/${ID}`, 'POST', { action: 'set_role', role: 'restaurant_staff', previous_role: 'restaurant_owner' }), params(ID));
    expect(ok.status).toBe(200);
    expect(m.db.tables.profiles[0].role).toBe('restaurant_staff');
    expect(m.audits[0]).toMatchObject({ action: 'change_user_role', details: expect.objectContaining({ previous_role: 'restaurant_owner', new_role: 'restaurant_staff' }) });
  });

  it('reports an unknown user as 404', async () => {
    as('admin');
    const missing = '44444444-4444-4444-8444-444444444444';
    expect((await userRoute.POST(req(`/api/admin/users/${missing}`, 'POST', { action: 'suspend' }), params(missing))).status).toBe(404);
  });
});

describe('X3 read routes', () => {
  beforeEach(() => {
    m.db.tables.chat_conversations = [{ id: ID, business_id: BIZ, customer_phone: '234', customer_name: 'Ada', status: 'open', last_message_at: '2026-11-01', created_at: '2026-11-01', session_context: { secret: true } }];
    m.db.tables.chat_messages = [
      { id: 'm1', conversation_id: ID, direction: 'inbound', message_text: 'hi', media_type: null, created_at: '2026-11-01T00:00:00Z' },
      { id: 'm2', conversation_id: OTHER, direction: 'inbound', message_text: 'other chat', media_type: null, created_at: '2026-11-01T00:00:00Z' },
    ];
    m.db.tables.customer_reports = [{ id: ID, business_id: BIZ, customer_phone: '234', customer_name: 'Ada', title: 'Lab', file_path: 'p', access_token: 'tok', status: 'sent', sent_at: null, created_at: '2026-11-01' }];
    m.db.tables.queue_entries = [
      { id: ID, business_id: BIZ, queue_number: 2, queue_date: '2026-11-17', status: 'waiting' },
      { id: OTHER, business_id: BIZ, queue_number: 1, queue_date: '2026-11-16', status: 'waiting' },
    ];
  });

  it('chat history: support can read conversations with business names, finance cannot', async () => {
    as('finance');
    expect((await chat.GET(req('/api/admin/chat-history', 'GET'))).status).toBe(403);
    as('support');
    const body = await (await chat.GET(req('/api/admin/chat-history', 'GET'))).json();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].business_name).toBe('Grace Church');
    const msgs = await (await chat.GET(req(`/api/admin/chat-history?conversationId=${ID}`, 'GET'))).json();
    expect(msgs.messages.map((x: { id: string }) => x.id)).toEqual(['m1']);
    expect((await chat.GET(req('/api/admin/chat-history?conversationId=nope', 'GET'))).status).toBe(400);
  });

  it('chat history: a failed read is an error, not an empty list', async () => {
    as('admin'); m.db.failReads.add('chat_conversations');
    expect((await chat.GET(req('/api/admin/chat-history', 'GET'))).status).toBe(500);
  });

  it('reports: admin and operations only; failure is an error', async () => {
    as('support');
    expect((await reports.GET(req('/api/admin/customer-reports', 'GET'))).status).toBe(403);
    as('operations');
    const body = await (await reports.GET(req('/api/admin/customer-reports', 'GET'))).json();
    expect(body.reports[0]).toMatchObject({ title: 'Lab', business_name: 'Grace Church' });
    m.db.failReads.add('customer_reports');
    expect((await reports.GET(req('/api/admin/customer-reports', 'GET'))).status).toBe(500);
  });

  it('queue: filters by date, validates input, refuses support', async () => {
    as('support');
    expect((await queue.GET(req('/api/admin/queue-entries?date=2026-11-17', 'GET'))).status).toBe(403);
    as('operations');
    const body = await (await queue.GET(req('/api/admin/queue-entries?date=2026-11-17', 'GET'))).json();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual([ID]);
    expect((await queue.GET(req('/api/admin/queue-entries', 'GET'))).status).toBe(400);
    expect((await queue.GET(req('/api/admin/queue-entries?date=2026-11-17&status=gone', 'GET'))).status).toBe(400);
    m.db.failReads.add('queue_entries');
    expect((await queue.GET(req('/api/admin/queue-entries?date=2026-11-17', 'GET'))).status).toBe(500);
  });
});
