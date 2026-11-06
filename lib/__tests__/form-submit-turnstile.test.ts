/**
 * Bot check (Cloudflare Turnstile) on the public form submit route.
 *
 * Runs the real POST /api/forms/submit handler and the real verifier
 * (lib/security/turnstile.ts) against an in-memory table store. The only network
 * call, Cloudflare's siteverify, is replaced by a fetch stub; any other URL fails
 * the test. Proves the check fails closed: no token, a bad token, an unreachable
 * siteverify or a missing production secret all save nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const m = vi.hoisted(() => ({ db: null as unknown as MemoryDb, serviceClients: 0, rpc: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => { m.serviceClients++; return { from: (t: string) => m.db.from(t), rpc: m.rpc }; },
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST as submit } from '@/app/api/forms/submit/route';
import { TURNSTILE_SITEVERIFY_URL, TURNSTILE_TEST_SECRET_KEY } from '@/lib/security/turnstile';

const SECRET = 'unit-test-turnstile-secret';
const GOOD = 'good-token';

type Verdict = { success: boolean; 'error-codes'?: string[] } | 'network-error' | 'http-500';
const siteverify = { verdict: { success: true } as Verdict, calls: [] as Array<{ url: string; body: Record<string, unknown> }> };

const originalFetch = globalThis.fetch;
beforeEach(() => {
  siteverify.verdict = { success: true };
  siteverify.calls = [];
  m.serviceClients = 0;
  m.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  vi.stubEnv('TURNSTILE_SECRET_KEY', SECRET);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== TURNSTILE_SITEVERIFY_URL) throw new Error(`unexpected network call: ${url}`);
    const body = JSON.parse(String(init?.body));
    siteverify.calls.push({ url, body });
    const v = siteverify.verdict;
    if (v === 'network-error') throw new Error('ECONNRESET');
    if (v === 'http-500') return new Response('oops', { status: 500 });
    // Mirrors Cloudflare: only the right secret plus the good token passes.
    const pass = v.success && body.response === GOOD && (body.secret === SECRET || body.secret === TURNSTILE_TEST_SECRET_KEY);
    return new Response(JSON.stringify(pass ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 });
  }) as typeof fetch;
  m.db = createMemoryDb({
    forms: [{ id: 'form-a', business_id: 'biz-a', token: 'tokA', is_active: true, settings: {}, fields: [{ id: 'name', label: 'Name', type: 'text', required: true }] }],
    form_responses: [],
    businesses: [{ id: 'biz-a', country_code: 'NG' }],
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

const post = (body: Record<string, unknown>) =>
  submit(new NextRequest('https://example.test/api/forms/submit', { method: 'POST', body: JSON.stringify(body) }));
const body = (extra: Record<string, unknown> = {}) => ({ token: 'tokA', answers: { name: 'Ada' }, customer_name: 'Ada', ...extra });
const saved = () => m.db.tables.form_responses;

describe('POST /api/forms/submit — bot check', () => {
  it('rejects a submission with no token, without calling siteverify or touching the database', async () => {
    const res = await post(body());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/security check/i);
    expect(siteverify.calls).toEqual([]);
    expect(m.serviceClients).toBe(0);
    expect(saved()).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty string', ''],
    ['a number', 12345],
    ['an object', { token: GOOD }],
    ['an oversized string', 'x'.repeat(2049)],
  ])('rejects %s as the token without calling siteverify', async (_label, turnstileToken) => {
    const res = await post(body({ turnstileToken }));
    expect(res.status).toBe(403);
    expect(siteverify.calls).toEqual([]);
    expect(saved()).toEqual([]);
  });

  it('rejects a token Cloudflare says is bad, saving nothing', async () => {
    const res = await post(body({ turnstileToken: 'forged-token' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Security check failed. Please try again.');
    expect(siteverify.calls).toEqual([{ url: TURNSTILE_SITEVERIFY_URL, body: { secret: SECRET, response: 'forged-token' } }]);
    expect(m.serviceClients).toBe(0);
    expect(saved()).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('accepts a good token and saves the response', async () => {
    const res = await post(body({ turnstileToken: GOOD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(siteverify.calls).toEqual([{ url: TURNSTILE_SITEVERIFY_URL, body: { secret: SECRET, response: GOOD } }]);
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ form_id: 'form-a', business_id: 'biz-a', answers: { name: 'Ada' }, status: 'submitted', channel: 'web' });
    // The token is not stored with the answers.
    expect(JSON.stringify(saved()[0])).not.toContain(GOOD);
    expect(m.rpc).toHaveBeenCalledWith('increment_form_response_count', { p_form_id: 'form-a' });
  });

  it('fails closed when siteverify cannot be reached', async () => {
    siteverify.verdict = 'network-error';
    const res = await post(body({ turnstileToken: GOOD }));
    expect(res.status).toBe(503);
    expect(saved()).toEqual([]);
  });

  it('fails closed when siteverify returns an HTTP error', async () => {
    siteverify.verdict = 'http-500';
    const res = await post(body({ turnstileToken: GOOD }));
    expect(res.status).toBe(503);
    expect(saved()).toEqual([]);
  });

  it('in production, refuses every submission when the secret is not set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const res = await post(body({ turnstileToken: GOOD }));
    expect(res.status).toBe(503);
    expect(siteverify.calls).toEqual([]);
    expect(m.serviceClients).toBe(0);
    expect(saved()).toEqual([]);
  });

  it('outside production, uses Cloudflare\'s documented test secret when no secret is set', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const res = await post(body({ turnstileToken: GOOD }));
    expect(res.status).toBe(200);
    expect(siteverify.calls[0].body).toEqual({ secret: TURNSTILE_TEST_SECRET_KEY, response: GOOD });
    expect(saved()).toHaveLength(1);
  });
});
