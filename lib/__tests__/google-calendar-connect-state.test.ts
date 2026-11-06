/**
 * Google Calendar connect: the OAuth state is signed and bound to the user who
 * started the connect, the business they own, and an httpOnly cookie nonce.
 *
 * Runs the real start and callback route handlers and the real
 * exchangeGoogleCode. Supabase is stubbed; fetch to Google is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-secret-for-gcal-state';
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'test-google-client-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
});

const OWNER = 'user-owner-1';
const OTHER_USER = 'user-other-2';
const BIZ = 'biz-owned-1';
const OTHER_BIZ = 'biz-other-2';
const APP = 'https://app.example.test';
const SETTINGS = `${APP}/dashboard/integrations`;
const COOKIE = 'gcal_oauth_nonce';

let currentUserId: string | null = OWNER;
let businesses: Array<{ id: string; owner_id: string }> = [];
let updates: Array<{ table: string; values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];

function businessesTable() {
  const filters: Array<[string, unknown]> = [];
  const match = () =>
    businesses.filter((b) => filters.every(([k, v]) => (b as Record<string, unknown>)[k] === v));
  const selectChain = {
    eq: (col: string, val: unknown) => { filters.push([col, val]); return selectChain; },
    single: async () => {
      const rows = match();
      return rows.length === 1
        ? { data: { id: rows[0].id }, error: null }
        : { data: null, error: { message: 'not found' } };
    },
  };
  return {
    select: () => selectChain,
    update: (values: Record<string, unknown>) => {
      const updFilters: Array<[string, unknown]> = [];
      const record = { table: 'businesses', values, filters: updFilters };
      updates.push(record);
      const chain = {
        eq: (col: string, val: unknown) => { updFilters.push([col, val]); return Object.assign(Promise.resolve({ error: null }), chain); },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null }, error: null }),
    },
    from: (table: string) => {
      if (table !== 'businesses') throw new Error(`unexpected table ${table}`);
      return businessesTable();
    },
  }),
}));

import { POST as startConnect } from '@/app/api/integrations/google-calendar/route';
import { GET as callback } from '@/app/api/integrations/google-calendar/callback/route';
import { createGoogleCalendarState } from '@/lib/integrations/google-calendar-oauth-state';

const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
  new Response(JSON.stringify({ access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
);

beforeEach(() => {
  currentUserId = OWNER;
  businesses = [
    { id: BIZ, owner_id: OWNER },
    { id: OTHER_BIZ, owner_id: OTHER_USER },
  ];
  updates = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function startRequest(businessId: string) {
  return new NextRequest(`${APP}/api/integrations/google-calendar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ business_id: businessId }),
  });
}

function callbackRequest(params: Record<string, string>, nonce?: string) {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {};
  if (nonce !== undefined) headers.cookie = `${COOKIE}=${nonce}`;
  return new NextRequest(`${APP}/api/integrations/google-calendar/callback?${qs}`, { headers });
}

/** Run the real start route as the owner and return the issued state and cookie nonce. */
async function startAsOwner(): Promise<{ state: string; nonce: string }> {
  const res = await startConnect(startRequest(BIZ));
  expect(res.status).toBe(200);
  const { url } = await res.json();
  const state = new URL(url).searchParams.get('state')!;
  const nonce = res.cookies.get(COOKIE)!.value;
  return { state, nonce };
}

function expectRejected(res: Response) {
  expect(res.status).toBe(307);
  expect(res.headers.get('location')).toBe(`${SETTINGS}?error=callback_failed`);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(updates).toHaveLength(0);
}

function expectCookieCleared(res: Response) {
  const setCookie = res.headers.get('set-cookie') || '';
  expect(setCookie).toContain(`${COOKIE}=;`);
  expect(setCookie).toMatch(/Max-Age=0/i);
  expect(setCookie).toContain('Path=/api/integrations/google-calendar/callback');
}

describe('Google Calendar connect: start route', () => {
  it('issues a signed state (not the business id) and an httpOnly nonce cookie scoped to the callback', async () => {
    const res = await startConnect(startRequest(BIZ));
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const state = new URL(url).searchParams.get('state')!;
    expect(state).not.toBe(BIZ);
    expect(state.split('.')).toHaveLength(2);

    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain(`${COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toContain('Path=/api/integrations/google-calendar/callback');
    expect(setCookie).toMatch(/Max-Age=600/);
    // Not production in tests, so no Secure flag; production sets it.
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it('keeps the ownership check: another business returns 404 and sets no cookie', async () => {
    const res = await startConnect(startRequest(OTHER_BIZ));
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('requires a session', async () => {
    currentUserId = null;
    const res = await startConnect(startRequest(BIZ));
    expect(res.status).toBe(401);
  });
});

describe('Google Calendar connect: callback route', () => {
  it('rejects the old state shape (state = business id): no code exchange, no write', async () => {
    // Independent of the start route, so this also runs against the old callback.
    const { nonce } = createGoogleCalendarState(OWNER, BIZ)!;
    const res = await callback(callbackRequest({ code: 'auth-code', state: BIZ }, nonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects a tampered signature', async () => {
    const { state, nonce } = await startAsOwner();
    const [payload, sig] = state.split('.');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const res = await callback(callbackRequest({ code: 'auth-code', state: `${payload}.${flipped}` }, nonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects a payload edited to point at another business (signature no longer matches)', async () => {
    const { state, nonce } = await startAsOwner();
    const [payload, sig] = state.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    body.b = OTHER_BIZ;
    const forged = Buffer.from(JSON.stringify(body)).toString('base64url');
    const res = await callback(callbackRequest({ code: 'auth-code', state: `${forged}.${sig}` }, nonce));
    expectRejected(res);
  });

  it('rejects an expired state', async () => {
    const expired = createGoogleCalendarState(OWNER, BIZ, Date.now() - 11 * 60 * 1000)!;
    const res = await callback(callbackRequest({ code: 'auth-code', state: expired.state }, expired.nonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects when a different user is logged in at the callback', async () => {
    const { state, nonce } = await startAsOwner();
    currentUserId = OTHER_USER;
    const res = await callback(callbackRequest({ code: 'auth-code', state }, nonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects when the nonce cookie is missing', async () => {
    const { state } = await startAsOwner();
    const res = await callback(callbackRequest({ code: 'auth-code', state }));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects when the nonce cookie does not match the state', async () => {
    const { state } = await startAsOwner();
    const { nonce: otherNonce } = await startAsOwner();
    const res = await callback(callbackRequest({ code: 'auth-code', state }, otherNonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects when there is no session', async () => {
    const { state, nonce } = await startAsOwner();
    currentUserId = null;
    const res = await callback(callbackRequest({ code: 'auth-code', state }, nonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('rejects when the user no longer owns the business in the state', async () => {
    const { state, nonce } = await startAsOwner();
    businesses = businesses.map((b) => (b.id === BIZ ? { ...b, owner_id: OTHER_USER } : b));
    const res = await callback(callbackRequest({ code: 'auth-code', state }, nonce));
    expectRejected(res);
    expectCookieCleared(res);
  });

  it('valid owner flow: exchanges the code, writes tokens to the business in the state, clears the cookie', async () => {
    const { state, nonce } = await startAsOwner();
    const res = await callback(callbackRequest({ code: 'auth-code', state }, nonce));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?google_calendar=connected`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe(`${APP}/api/integrations/google-calendar/callback`);

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({
      google_calendar_token: 'at-123',
      google_calendar_refresh_token: 'rt-456',
      google_calendar_id: 'primary',
    });
    expect(updates[0].filters).toEqual([['id', BIZ]]);

    expectCookieCleared(res);
  });

  it('keeps the existing denied and missing-params redirects', async () => {
    const denied = await callback(callbackRequest({ error: 'access_denied' }));
    expect(denied.headers.get('location')).toBe(`${SETTINGS}?error=google_denied`);
    const missing = await callback(callbackRequest({ code: 'auth-code' }));
    expect(missing.headers.get('location')).toBe(`${SETTINGS}?error=missing_params`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
