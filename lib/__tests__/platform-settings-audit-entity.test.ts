/**
 * Non-commercial platform setting saves (PUT/POST/DELETE /api/admin/platform-settings)
 * must write their audit row with entity_id null and the setting key in details.
 * admin_audit_logs.entity_id is a UUID column (M010), so passing the key there
 * made every save return 500 after the value was already written.
 *
 * Runs the real route handlers and the real logAdminAudit against an in-memory
 * service client that rejects non-UUID entity_id like PostgreSQL does.
 * The real-PostgreSQL proof is platform-settings-audit-entity.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { state } = vi.hoisted(() => ({
  state: {
    audits: [] as Array<Record<string, unknown>>,
    settingWrites: [] as Array<{ op: string; key: string }>,
    failAudit: false,
  },
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: async () => ({ id: 'a', userId: '00000000-0000-4000-8000-0000000000a1', role: 'admin', aal: 'aal2', email: '', bearerToken: 't', sessionId: 's' }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'admin_audit_logs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (state.failAudit) return { error: { message: 'audit unavailable' } };
            if (row.entity_id !== null && !UUID_RE.test(String(row.entity_id))) {
              return { error: { message: `invalid input syntax for type uuid: "${row.entity_id}"` } };
            }
            state.audits.push(row);
            return { error: null };
          },
        };
      }
      if (table !== 'platform_settings') throw new Error(`Unexpected table ${table}`);
      return {
        update: () => ({ eq: async (_c: string, key: string) => { state.settingWrites.push({ op: 'update', key }); return { error: null }; } }),
        insert: async (row: { key: string }) => { state.settingWrites.push({ op: 'insert', key: row.key }); return { error: null }; },
        delete: () => ({ eq: async (_c: string, key: string) => { state.settingWrites.push({ op: 'delete', key }); return { error: null }; } }),
      };
    },
  }),
}));

import { PUT, POST, DELETE } from '@/app/api/admin/platform-settings/route';

const KEY = 'customer_daily_reply_limit';
const req = (method: string, body: unknown) =>
  new NextRequest('http://localhost/api/admin/platform-settings', { method, body: JSON.stringify(body) });

describe('platform-settings audit entity_id', () => {
  beforeEach(() => { state.audits = []; state.settingWrites = []; state.failAudit = false; });

  it('PUT saves and audits with entity_id null and the key in details', async () => {
    const res = await PUT(req('PUT', { key: KEY, value: 200 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(state.settingWrites).toEqual([{ op: 'update', key: KEY }]);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: 'update_platform_setting', entity_type: 'platform_setting', entity_id: null,
      details: { key: KEY, new_value: 200 },
    });
  });

  it('POST creates and audits with entity_id null and the key in details', async () => {
    const res = await POST(req('POST', { key: KEY, value: 50, description: 'Daily replies' }));
    expect(res.status).toBe(200);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: 'create_platform_setting', entity_type: 'platform_setting', entity_id: null,
      details: { key: KEY, value: 50, description: 'Daily replies' },
    });
  });

  it('DELETE removes and audits with entity_id null and the key in details', async () => {
    const res = await DELETE(req('DELETE', { key: KEY }));
    expect(res.status).toBe(200);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: 'delete_platform_setting', entity_type: 'platform_setting', entity_id: null,
      details: { key: KEY },
    });
  });

  it('a failed audit write still fails the request', async () => {
    state.failAudit = true;
    for (const [handler, method] of [[PUT, 'PUT'], [POST, 'POST'], [DELETE, 'DELETE']] as const) {
      const res = await handler(req(method, { key: KEY, value: 1 }));
      expect(res.status).toBe(500);
    }
  });

  it('commercial and fee-bank keys are still refused before any write or audit', async () => {
    for (const key of ['trial_days', 'platform_bank_ng']) {
      for (const [handler, method] of [[PUT, 'PUT'], [POST, 'POST'], [DELETE, 'DELETE']] as const) {
        const res = await handler(req(method, { key, value: 1 }));
        expect(res.status).toBe(403);
      }
    }
    expect(state.settingWrites).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});
