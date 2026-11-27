/**
 * Internal template routes: the service token is accepted in the
 * `Authorization: Bearer <INTERNAL_API_TOKEN>` header only.
 *
 * Handler-level tests for:
 *   - GET /api/whatsapp/templates/check
 *   - GET /api/admin/template-status
 *   - GET /api/admin/provision-templates
 *
 * Each route: header token accepted; `?token=` query value ignored; wrong or
 * missing token rejected; INTERNAL_API_TOKEN unset fails closed. For
 * templates/check, CRON_SECRET is no longer accepted as a `?token=` value
 * (the existing `Authorization: Bearer <CRON_SECRET>` cron path is unchanged).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const INTERNAL = 'test-internal-token-abc';
const CRON = 'test-cron-secret-xyz';

let metaCalls: number;
let provisionCalls: number;
let fetchCalls: number;
let adminCalls: number;

function makeReq(path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const url = new URL(`https://t.waaiio.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString(), { method: 'GET', headers });
}

beforeEach(() => {
  vi.resetModules();
  metaCalls = 0;
  provisionCalls = 0;
  fetchCalls = 0;
  adminCalls = 0;
  vi.stubEnv('META_CLOUD_WABA_ID', 'test-waba');
  vi.stubEnv('META_CLOUD_ACCESS_TOKEN', 'test-meta-token');
  vi.stubEnv('META_CLOUD_PHONE_NUMBER_ID', 'test-phone-id');
  vi.stubEnv('CRON_SECRET', CRON);
  vi.stubEnv('INTERNAL_API_TOKEN', INTERNAL);

  vi.doMock('@/lib/channels/meta-cloud', () => ({
    MetaCloudService: class {
      constructor() { metaCalls++; }
      async getTemplates() { return { data: [] }; }
      async createTemplate() { return { id: 't1' }; }
      async deleteTemplate() {}
      async sendTemplate() { return { messageId: 'm1' }; }
    },
  }));
  vi.doMock('@/lib/channels/provision-templates', () => ({
    provisionTemplates: vi.fn(async () => { provisionCalls++; return { created: [], skipped: [] }; }),
  }));
  // No admin session in these tests: the admin fallback always refuses.
  vi.doMock('@/lib/admin-auth', () => ({
    requirePlatformAdmin: vi.fn(async () => { adminCalls++; return null; }),
  }));
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls++;
    return { json: async () => ({ data: [] }) };
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Route table: how to load each handler and detect that it ran ──

const ROUTES = [
  {
    name: 'GET /api/whatsapp/templates/check',
    path: '/api/whatsapp/templates/check',
    load: () => import('@/app/api/whatsapp/templates/check/route'),
    ran: () => metaCalls > 0,
  },
  {
    name: 'GET /api/admin/template-status',
    path: '/api/admin/template-status',
    load: () => import('@/app/api/admin/template-status/route'),
    ran: () => fetchCalls > 0,
  },
  {
    name: 'GET /api/admin/provision-templates',
    path: '/api/admin/provision-templates',
    load: () => import('@/app/api/admin/provision-templates/route'),
    ran: () => provisionCalls > 0,
  },
] as const;

for (const route of ROUTES) {
  describe(route.name, () => {
    it('accepts the internal token in the Authorization header', async () => {
      const { GET } = await route.load();
      const res = await GET(makeReq(route.path, {}, { Authorization: `Bearer ${INTERNAL}` }));
      expect(res.status).toBe(200);
      expect(route.ran()).toBe(true);
      expect(adminCalls).toBe(0);
    });

    it('ignores a correct internal token sent as ?token= (rejected, handler does not run)', async () => {
      const { GET } = await route.load();
      const res = await GET(makeReq(route.path, { token: INTERNAL }));
      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThan(500);
      expect(route.ran()).toBe(false);
    });

    it('rejects a wrong token in the header', async () => {
      const { GET } = await route.load();
      const res = await GET(makeReq(route.path, {}, { Authorization: 'Bearer not-the-token' }));
      expect([401, 403]).toContain(res.status);
      expect(route.ran()).toBe(false);
    });

    it('rejects the token without the Bearer scheme', async () => {
      const { GET } = await route.load();
      const res = await GET(makeReq(route.path, {}, { Authorization: INTERNAL }));
      expect([401, 403]).toContain(res.status);
      expect(route.ran()).toBe(false);
    });

    it('rejects a missing token', async () => {
      const { GET } = await route.load();
      const res = await GET(makeReq(route.path));
      expect([401, 403]).toContain(res.status);
      expect(route.ran()).toBe(false);
    });

    for (const mode of ['unset', 'empty'] as const) {
      it(`fails closed when INTERNAL_API_TOKEN is ${mode}`, async () => {
        if (mode === 'unset') delete process.env.INTERNAL_API_TOKEN;
        else vi.stubEnv('INTERNAL_API_TOKEN', '');
        const { GET } = await route.load();
        for (const req of [
          makeReq(route.path, {}, { Authorization: 'Bearer ' }),
          makeReq(route.path, {}, { Authorization: 'Bearer undefined' }),
          makeReq(route.path, { token: '' }),
          makeReq(route.path, { token: 'undefined' }),
        ]) {
          const res = await GET(req);
          expect([401, 403]).toContain(res.status);
        }
        expect(route.ran()).toBe(false);
      });
    }

    it('keeps the existing cron header path (Authorization: Bearer <CRON_SECRET>)', async () => {
      const { GET } = await route.load();
      const res = await GET(makeReq(route.path, {}, { Authorization: `Bearer ${CRON}` }));
      expect(res.status).toBe(200);
      expect(route.ran()).toBe(true);
    });
  });
}

describe('GET /api/whatsapp/templates/check — CRON_SECRET as ?token=', () => {
  it('is no longer accepted', async () => {
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const res = await GET(makeReq('/api/whatsapp/templates/check', { token: CRON }));
    expect(res.status).toBe(401);
    expect(metaCalls).toBe(0);
  });

  it('does not unlock ?fix=true or ?test=PHONE', async () => {
    const { GET } = await import('@/app/api/whatsapp/templates/check/route');
    const extras: Record<string, string>[] = [{ fix: 'true' }, { test: '15551234567' }];
    for (const extra of extras) {
      for (const token of [CRON, INTERNAL]) {
        const res = await GET(makeReq('/api/whatsapp/templates/check', { token, ...extra }));
        expect(res.status).toBe(401);
      }
    }
    expect(metaCalls).toBe(0);
  });
});

describe('hasBearerSecret', () => {
  it('matches only the exact Bearer value and fails closed on an empty secret', async () => {
    const { hasBearerSecret } = await import('@/lib/cron-auth');
    const req = (h?: string) => makeReq('/x', {}, h === undefined ? {} : { Authorization: h });
    expect(hasBearerSecret(req(`Bearer ${INTERNAL}`), INTERNAL)).toBe(true);
    expect(hasBearerSecret(req(`Bearer ${INTERNAL}x`), INTERNAL)).toBe(false);
    expect(hasBearerSecret(req(`bearer ${INTERNAL}`), INTERNAL)).toBe(false);
    expect(hasBearerSecret(req(), INTERNAL)).toBe(false);
    expect(hasBearerSecret(req('Bearer '), '')).toBe(false);
    expect(hasBearerSecret(req('Bearer undefined'), undefined)).toBe(false);
  });
});
