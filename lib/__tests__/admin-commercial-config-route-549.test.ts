/**
 * M549 — GET /api/admin/countries/messaging-config replaces the dropped browser
 * RPC get_effective_commercial_config(). Runs the real route handler.
 *
 * Proves: only a full admin (requirePlatformAdmin with requiredRole 'admin',
 * which also requires aal2) gets the config; the version comes from the
 * DB-clock helper get_effective_config_version_id() (service role) and is then
 * read by that id; read failures are reported, not shown as an empty config;
 * the CORS preflight allows GET; and POST still requires step-up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Role = 'admin' | 'support' | 'finance' | 'operations';
const m = vi.hoisted(() => ({
  admin: null as null | { userId: string; role: Role },
  requiredRoles: [] as unknown[],
  rpcCalls: [] as Array<{ name: string; args?: unknown }>,
  versionId: 'synthetic-version' as string | null,
  rpcError: null as null | { message: string },
  row: { id: 'synthetic-version', config_snapshot: { trial_credit_minor_by_currency: { NGN: 600000 } } } as unknown,
  readError: null as null | { message: string },
  reads: [] as Array<{ table: string; columns: string; filters: Array<[string, unknown]> }>,
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: async (_req: unknown, opts?: { requiredRole?: Role | Role[] }) => {
    m.requiredRoles.push(opts?.requiredRole);
    if (!m.admin) return null;
    const required = opts?.requiredRole ? ([] as Role[]).concat(opts.requiredRole) : null;
    return required && !required.includes(m.admin.role) ? null : { ...m.admin, id: m.admin.userId, email: 'a@example.test' };
  },
}));
vi.mock('@/lib/admin-step-up', () => ({
  consumeStepUp: async () => { throw new (class StepUpError extends Error {})('Step-up authorization required'); },
  StepUpError: class StepUpError extends Error {},
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: async (name: string, args?: unknown) => {
      m.rpcCalls.push({ name, args });
      return m.rpcError ? { data: null, error: m.rpcError } : { data: m.versionId, error: null };
    },
    from: (table: string) => {
      const q = { table, columns: '', filters: [] as Array<[string, unknown]> };
      m.reads.push(q);
      const chain: any = {
        select: (columns: string) => { q.columns = columns; return chain; },
        eq: (key: string, value: unknown) => { q.filters.push([key, value]); return chain; },
        maybeSingle: async () => (m.readError ? { data: null, error: m.readError } : { data: m.row, error: null }),
      };
      return chain;
    },
  }),
}));

import { GET, OPTIONS, POST } from '@/app/api/admin/countries/messaging-config/route';

const ORIGIN = 'https://admin-staging.waaiio.com';
const req = (method: string, body?: unknown) => new NextRequest('https://staging.waaiio.com/api/admin/countries/messaging-config', {
  method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  m.admin = { userId: 'synthetic-admin', role: 'admin' };
  m.requiredRoles.length = 0; m.rpcCalls.length = 0; m.reads.length = 0;
  m.versionId = 'synthetic-version'; m.rpcError = null; m.readError = null;
  m.row = { id: 'synthetic-version', config_snapshot: { trial_credit_minor_by_currency: { NGN: 600000 } } };
});

describe('GET /api/admin/countries/messaging-config (M549)', () => {
  it('returns the effective version, picked by the DB clock and read by id', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: m.row });
    expect(m.requiredRoles).toEqual(['admin']);
    expect(m.rpcCalls).toEqual([{ name: 'get_effective_config_version_id', args: undefined }]);
    expect(m.reads).toEqual([{ table: 'platform_config_versions', columns: 'id, config_snapshot', filters: [['id', 'synthetic-version']] }]);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it.each(['support', 'finance', 'operations'] as const)('refuses %s staff and reads nothing', async role => {
    m.admin = { userId: 'synthetic-staff', role };
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(m.rpcCalls).toEqual([]); expect(m.reads).toEqual([]);
  });

  it('refuses a caller who is not a verified platform admin (no aal2 session or no role)', async () => {
    m.admin = null;
    expect((await GET(req('GET'))).status).toBe(403);
    expect(m.rpcCalls).toEqual([]); expect(m.reads).toEqual([]);
  });

  it('reports a failed version lookup or read as an error, never as an empty config', async () => {
    m.rpcError = { message: 'synthetic' };
    const a = await GET(req('GET'));
    expect(a.status).toBe(500); expect(await a.json()).toEqual({ error: 'Could not load the messaging configuration' });
    m.rpcError = null; m.readError = { message: 'synthetic' };
    const b = await GET(req('GET'));
    expect(b.status).toBe(500); expect(await b.json()).toEqual({ error: 'Could not load the messaging configuration' });
  });

  it('no effective version yet: version null (the page then refuses to edit)', async () => {
    m.versionId = null;
    const res = await GET(req('GET'));
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ version: null });
    expect(m.reads).toEqual([]);
  });

  it('the CORS preflight allows GET for the admin origin', async () => {
    const res = await OPTIONS(req('OPTIONS'));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('saving is unchanged: POST without a valid step-up is refused before any write', async () => {
    const res = await POST(req('POST', { messagingPricing: {}, stepUpId: 'synthetic-step' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('step_up_required');
    expect(m.rpcCalls).toEqual([]);
  });
});
