/**
 * Real-PostgreSQL proof that non-commercial platform setting saves write an
 * audit row the real admin_audit_logs schema accepts: entity_id null, setting
 * key in details.
 *
 * Fixture: public.profiles (minimal, for the FK), admin_audit_logs exactly as
 * created by M010 from disk (entity_id UUID; never altered by a later
 * migration), and platform_settings exactly as created by M012 from disk.
 * The real route handlers and the real logAdminAudit run; only auth and the
 * PostgREST transport are replaced (the service client is backed by this
 * database).
 *
 * Skips only when no database is configured outside CI; with
 * REQUIRE_PG_TESTS=true (the security-acl-tests job, "Run .pg.test.ts files in
 * parallel with isolated databases") a missing database fails the run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { NextRequest } from 'next/server';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL required');
const suite = url ? describe : describe.skip;

const ADMIN = '00000000-0000-4000-8000-0000000011a1';
const f = vi.hoisted(() => ({ pool: null as pg.Pool | null }));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: async () => ({ id: 'admin', userId: '00000000-0000-4000-8000-0000000011a1', role: 'admin', aal: 'aal2', email: '', bearerToken: 'synthetic', sessionId: 'session' }),
}));

// Real PostgreSQL transport for the supabase-js calls these handlers make.
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (!['platform_settings', 'admin_audit_logs'].includes(table)) throw new Error(`Unexpected table ${table}`);
      const col = (name: string) => { if (!/^[a-z_]+$/.test(name)) throw new Error('Bad column'); return `"${name}"`; };
      const exec = async (text: string, values: unknown[]) => {
        try { await f.pool!.query(text, values); return { error: null }; } catch (error) { return { error: { message: (error as Error).message } }; }
      };
      return {
        insert: (row: Record<string, unknown>) => {
          const keys = Object.keys(row);
          return exec(
            `INSERT INTO public.${table} (${keys.map(col).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
            keys.map(k => (k === 'value' || k === 'details') && row[k] !== null ? JSON.stringify(row[k]) : row[k]),
          );
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (c: string, v: unknown) => {
            const keys = Object.keys(patch);
            const values = keys.map(k => (k === 'value' ? JSON.stringify(patch[k]) : patch[k]));
            return exec(`UPDATE public.${table} SET ${keys.map((k, i) => `${col(k)} = $${i + 1}`).join(', ')} WHERE ${col(c)} = $${keys.length + 1}`, [...values, v]);
          },
        }),
        delete: () => ({ eq: (c: string, v: unknown) => exec(`DELETE FROM public.${table} WHERE ${col(c)} = $1`, [v]) }),
      };
    },
  }),
}));

import { PUT, POST, DELETE } from '@/app/api/admin/platform-settings/route';

const KEY = 'customer_daily_reply_limit';
const req = (method: string, body: unknown) =>
  new NextRequest('http://localhost/api/admin/platform-settings', { method, body: JSON.stringify(body) });

/** One CREATE TABLE statement from a migration file on disk. */
function createTable(file: string, table: string): string {
  const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  const end = sql.indexOf(');', start);
  if (start < 0 || end < 0) throw new Error(`${file}: ${table} definition not found`);
  return sql.slice(start, end + 2);
}

const auditRows = async () =>
  (await f.pool!.query('SELECT action, entity_type, entity_id, details FROM public.admin_audit_logs ORDER BY created_at, action')).rows;

suite('platform-settings audit rows against real admin_audit_logs (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(url!);
    const isolatedCi = process.env.GITHUB_ACTIONS === 'true' && target.username === 'test_runner' && /^\/pg_test_\d+$/.test(target.pathname);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || (target.pathname !== '/platform_settings_audit_test' && !isolatedCi)) {
      throw new Error('Disposable local database only');
    }
    f.pool = new pg.Pool({ connectionString: url });
    await f.pool.query('DROP TABLE IF EXISTS public.admin_audit_logs, public.platform_settings, public.profiles CASCADE');
    await f.pool.query('CREATE TABLE public.profiles (id uuid PRIMARY KEY)');
    await f.pool.query(createTable('010_payout_system.sql', 'admin_audit_logs'));
    await f.pool.query(createTable('012_admin_expansion.sql', 'platform_settings'));
    await f.pool.query('INSERT INTO public.profiles (id) VALUES ($1)', [ADMIN]);
    const type = await f.pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_audit_logs' AND column_name='entity_id'`);
    expect(type.rows[0].data_type).toBe('uuid');
  });

  afterAll(async () => {
    await f.pool?.query('DROP TABLE IF EXISTS public.admin_audit_logs, public.platform_settings, public.profiles CASCADE');
    await f.pool?.end();
  });

  beforeEach(async () => { await f.pool!.query('TRUNCATE public.admin_audit_logs, public.platform_settings'); });

  it('a string key in entity_id is rejected by the real schema (the original failure)', async () => {
    await expect(f.pool!.query(
      `INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details) VALUES ($1, 'x', 'platform_setting', $2, '{}')`,
      [ADMIN, KEY],
    )).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it('POST, PUT, DELETE succeed and each writes one audit row with entity_id null and the key in details', async () => {
    const created = await POST(req('POST', { key: KEY, value: 50, description: 'Daily replies' }));
    expect(created.status).toBe(200);
    const updated = await PUT(req('PUT', { key: KEY, value: 200 }));
    expect(updated.status).toBe(200);
    expect((await f.pool!.query('SELECT value FROM public.platform_settings WHERE key = $1', [KEY])).rows[0].value).toBe(200);
    const deleted = await DELETE(req('DELETE', { key: KEY }));
    expect(deleted.status).toBe(200);
    expect((await f.pool!.query('SELECT 1 FROM public.platform_settings WHERE key = $1', [KEY])).rowCount).toBe(0);

    const rows = await auditRows();
    expect(rows).toHaveLength(3);
    const byAction = Object.fromEntries(rows.map(r => [r.action, r]));
    expect(byAction.create_platform_setting).toEqual({ action: 'create_platform_setting', entity_type: 'platform_setting', entity_id: null, details: { key: KEY, value: 50, description: 'Daily replies' } });
    expect(byAction.update_platform_setting).toEqual({ action: 'update_platform_setting', entity_type: 'platform_setting', entity_id: null, details: { key: KEY, new_value: 200 } });
    expect(byAction.delete_platform_setting).toEqual({ action: 'delete_platform_setting', entity_type: 'platform_setting', entity_id: null, details: { key: KEY } });
  });
});
