/**
 * Admin-staging CORS on routes that kept their own origin list.
 *
 * Owner staging test 2026-11-17: the WhatsApp Templates page on
 * admin-staging.waaiio.com showed "Failed to fetch" because
 * /api/whatsapp/templates and /api/promotions/admin-* answered with
 * Access-Control-Allow-Origin: https://admin.waaiio.com. Impersonation
 * "View Dashboard" failed because /api/admin/impersonate answered with an
 * empty Access-Control-Allow-Origin on every origin.
 *
 * Runs the real route handlers and reads the header the browser checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const m = vi.hoisted(() => ({
  admin: null as null | { id: string; email: string },
  db: null as unknown as MemoryDb,
}));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: async () => m.admin }));
vi.mock('@/lib/admin-step-up', () => ({
  consumeStepUp: async () => undefined,
  StepUpError: class StepUpError extends Error {},
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import * as templates from '@/app/api/whatsapp/templates/route';
import * as promoList from '@/app/api/promotions/admin-list/route';
import * as promoAction from '@/app/api/promotions/admin-action/route';
import * as promoDetail from '@/app/api/promotions/admin-detail/route';
import * as impersonate from '@/app/api/admin/impersonate/route';

const STAGING = 'https://admin-staging.waaiio.com';
const PROD = 'https://admin.waaiio.com';
const EVIL = 'https://evil.example';
const ACAO = 'Access-Control-Allow-Origin';

const req = (url: string, method: string, origin: string, body?: unknown) =>
  new NextRequest(`https://staging.waaiio.com${url}`, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => {
  m.admin = null;
});

const routes = [
  { name: 'GET /api/whatsapp/templates', mod: templates, url: '/api/whatsapp/templates', methods: 'GET, POST, DELETE, OPTIONS' },
  { name: 'GET /api/promotions/admin-list', mod: promoList, url: '/api/promotions/admin-list', methods: 'GET, OPTIONS' },
  { name: 'POST /api/promotions/admin-action', mod: promoAction, url: '/api/promotions/admin-action', methods: 'POST, OPTIONS' },
  { name: 'GET /api/promotions/admin-detail', mod: promoDetail, url: '/api/promotions/admin-detail', methods: 'GET, OPTIONS' },
];

describe('admin routes with their own CORS answer admin-staging', () => {
  for (const r of routes) {
    describe(r.name, () => {
      it('preflight echoes admin-staging and keeps the route methods', async () => {
        const res = await r.mod.OPTIONS(req(r.url, 'OPTIONS', STAGING));
        expect(res.headers.get(ACAO)).toBe(STAGING);
        expect(res.headers.get('Access-Control-Allow-Methods')).toBe(r.methods);
        expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
      });

      it('preflight still echoes production admin', async () => {
        const res = await r.mod.OPTIONS(req(r.url, 'OPTIONS', PROD));
        expect(res.headers.get(ACAO)).toBe(PROD);
      });

      it('preflight gives an unknown origin no usable header (fails closed)', async () => {
        const res = await r.mod.OPTIONS(req(r.url, 'OPTIONS', EVIL));
        expect(res.headers.get(ACAO)).not.toBe(EVIL);
        expect(res.headers.get(ACAO)).not.toBe(PROD);
        expect(res.headers.get(ACAO) ?? '').toBe('');
      });
    });
  }

  it('actual responses (not only preflight) carry the admin-staging origin', async () => {
    const list = await promoList.GET(req('/api/promotions/admin-list', 'GET', STAGING));
    expect(list.status).toBe(403); // no admin session in this test
    expect(list.headers.get(ACAO)).toBe(STAGING);

    const detail = await promoDetail.GET(req('/api/promotions/admin-detail', 'GET', STAGING));
    expect(detail.headers.get(ACAO)).toBe(STAGING);

    const action = await promoAction.POST(req('/api/promotions/admin-action', 'POST', STAGING, {}));
    expect(action.headers.get(ACAO)).toBe(STAGING);
  });
});

describe('POST /api/admin/impersonate echoes the admin origin', () => {
  it('401 response carries admin-staging so the admin page can read the error', async () => {
    const res = await impersonate.POST(req('/api/admin/impersonate', 'POST', STAGING, { business_id: 'b1' }));
    expect(res.status).toBe(401);
    expect(res.headers.get(ACAO)).toBe(STAGING);
  });

  it('success response carries the origin for staging and production admin', async () => {
    for (const origin of [STAGING, PROD]) {
      m.admin = { id: 'admin-1', email: 'a@example.test' };
      m.db = createMemoryDb({ businesses: [{ id: 'b1', name: 'TestBiz' }], admin_impersonation_tokens: [], impersonation_logs: [] });
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.waaiio.com');
      const res = await impersonate.POST(req('/api/admin/impersonate', 'POST', origin, { business_id: 'b1', stepUpId: 's1' }));
      vi.unstubAllEnvs();
      expect(res.status).toBe(200);
      expect(res.headers.get(ACAO)).toBe(origin);
      const { url } = await res.json();
      expect(url).toMatch(/^https:\/\/staging\.waaiio\.com\/dashboard\/impersonate\?token=[0-9a-f]{64}$/);
    }
  });

  it('unknown origin gets no usable header', async () => {
    const res = await impersonate.POST(req('/api/admin/impersonate', 'POST', EVIL, { business_id: 'b1' }));
    expect(res.headers.get(ACAO) ?? '').toBe('');
  });
});
