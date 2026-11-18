/**
 * Bot check (Cloudflare Turnstile) on the white-label "Book a Demo" route.
 *
 * Runs the real POST /api/demo-request and POST /api/contact handlers side by
 * side. Cloudflare's siteverify is the only network call and is stubbed; any
 * other URL fails the test. Proves the demo route refuses a missing or invalid
 * token the same way the contact route does (403, nothing saved), passes a
 * good token, and, like the contact route, does not demand a token when
 * TURNSTILE_SECRET_KEY is not set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const m = vi.hoisted(() => ({ db: null as unknown as MemoryDb, emails: [] as unknown[] }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t) }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: async (e: unknown) => { m.emails.push(e); return { ok: true }; } }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST as demo } from '@/app/api/demo-request/route';
import { POST as contact } from '@/app/api/contact/route';
import { TURNSTILE_SITEVERIFY_URL } from '@/lib/security/turnstile';

const SECRET = 'unit-test-turnstile-secret';
const GOOD = 'good-token';
const siteverifyCalls: Array<Record<string, unknown>> = [];

const originalFetch = globalThis.fetch;
beforeEach(() => {
  siteverifyCalls.length = 0;
  m.emails = [];
  m.db = createMemoryDb({ demo_requests: [] });
  vi.stubEnv('TURNSTILE_SECRET_KEY', SECRET);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== TURNSTILE_SITEVERIFY_URL) throw new Error(`unexpected network call: ${url}`);
    const body = JSON.parse(String(init?.body));
    siteverifyCalls.push(body);
    const pass = body.response === GOOD && body.secret === SECRET;
    return new Response(JSON.stringify(pass ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

const post = (handler: (r: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) =>
  handler(new NextRequest(`https://example.test${path}`, { method: 'POST', body: JSON.stringify(body) }));

const demoBody = (extra: Record<string, unknown> = {}) => ({
  business_name: 'Acme', contact_name: 'Ada Lovelace', work_email: 'ada@acme.test', phone: '+15551234567',
  industry: 'Hospitality', ...extra,
});
const contactBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Ada', email: 'ada@acme.test', message: 'Hello', ...extra,
});

const postDemo = (extra?: Record<string, unknown>) => post(demo, '/api/demo-request', demoBody(extra));
const postContact = (extra?: Record<string, unknown>) => post(contact, '/api/contact', contactBody(extra));

describe('POST /api/demo-request — Turnstile, same as /api/contact', () => {
  it('missing token: both routes refuse with 403 and nothing is saved or sent', async () => {
    const [d, c] = await Promise.all([postDemo(), postContact()]);
    expect(d.status).toBe(403);
    expect(c.status).toBe(403);
    expect((await d.json()).error).toMatch(/security check/i);
    expect(m.db.tables.demo_requests).toEqual([]);
    expect(m.emails).toEqual([]);
    expect(siteverifyCalls).toEqual([]);
  });

  it('invalid token: both routes refuse with 403 after asking Cloudflare, nothing saved or sent', async () => {
    const d = await postDemo({ turnstileToken: 'forged' });
    const c = await postContact({ turnstileToken: 'forged' });
    expect(d.status).toBe(403);
    expect(c.status).toBe(403);
    expect(siteverifyCalls).toEqual([
      { secret: SECRET, response: 'forged' },
      { secret: SECRET, response: 'forged' },
    ]);
    expect(m.db.tables.demo_requests).toEqual([]);
    expect(m.emails).toEqual([]);
  });

  it('good token: the demo request is saved and the team is emailed', async () => {
    const res = await postDemo({ turnstileToken: GOOD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(m.db.tables.demo_requests).toHaveLength(1);
    expect(m.db.tables.demo_requests[0]).toMatchObject({ business_name: 'Acme', work_email: 'ada@acme.test' });
    expect(m.emails.length).toBeGreaterThanOrEqual(1);
  });

  it('honeypot still short-circuits before the bot check (unchanged)', async () => {
    const res = await postDemo({ website: 'spam.example' });
    expect(res.status).toBe(200);
    expect(m.db.tables.demo_requests).toEqual([]);
    expect(siteverifyCalls).toEqual([]);
  });

  it('no TURNSTILE_SECRET_KEY: both routes accept without a token, as before', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const d = await postDemo();
    const c = await postContact();
    expect(d.status).toBe(200);
    expect(c.status).toBe(200);
    expect(m.db.tables.demo_requests).toHaveLength(1);
    expect(siteverifyCalls).toEqual([]);
  });
});
