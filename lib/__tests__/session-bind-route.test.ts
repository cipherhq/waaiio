/**
 * POST /api/auth/session-bind identifies the user with supabase.auth.getUser().
 *
 * Runs the real route handler with Supabase, bindSession and email mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type User = { id: string; email?: string };

let getUserResult: { data: { user: User | null }; error: { message: string } | null };
let sessionResult: { data: { session: { access_token: string; user: User } | null } };

const getUser = vi.fn(async () => getUserResult);
const getSession = vi.fn(async () => sessionResult);
const bindSession = vi.fn(async (_p: Record<string, unknown>) => {});
const sendEmail = vi.fn(async (_p: { to: string }) => ({}));
const profileEq = vi.fn((_col: string, _val: string) => ({
  single: async () => ({ data: { first_name: 'Ada' }, error: null }),
}));
const from = vi.fn((_table: string) => ({ select: () => ({ eq: profileEq }) }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser, getSession } }),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from }) }));
vi.mock('@/lib/security/session-bind', () => ({ bindSession: (p: Record<string, unknown>) => bindSession(p) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: (p: { to: string }) => sendEmail(p) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { POST } from '@/app/api/auth/session-bind/route';

const TOKEN = 'a'.repeat(20) + 'b'.repeat(32);

function req() {
  return new NextRequest('http://localhost/api/auth/session-bind', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5', 'user-agent': 'Mozilla Mobile', 'x-vercel-ip-country': 'NG' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const verified = { id: 'user-verified', email: 'verified@example.com' };
  getUserResult = { data: { user: verified }, error: null };
  sessionResult = { data: { session: { access_token: TOKEN, user: verified } } };
});

describe('POST /api/auth/session-bind', () => {
  it('valid user: records the session and sends the login email (unchanged behaviour)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(bindSession).toHaveBeenCalledWith({
      userId: 'user-verified',
      sessionId: TOKEN.slice(-32),
      ip: '203.0.113.5',
      userAgent: 'Mozilla Mobile',
      country: 'NG',
    });
    expect(profileEq).toHaveBeenCalledWith('id', 'user-verified');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('verified@example.com');
  });

  it('getUser() returns no user: 401, no write, no email', async () => {
    getUserResult = { data: { user: null }, error: null };
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(bindSession).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('getUser() returns an error: 401, no write, no email', async () => {
    getUserResult = { data: { user: { id: 'user-verified', email: 'verified@example.com' } }, error: { message: 'invalid JWT' } };
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(bindSession).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('cookie session user differs from getUser(): only the getUser() user is used', async () => {
    sessionResult = { data: { session: { access_token: TOKEN, user: { id: 'cookie-user', email: 'cookie@example.com' } } } };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(bindSession).toHaveBeenCalledTimes(1);
    expect(bindSession.mock.calls[0][0].userId).toBe('user-verified');
    expect(profileEq).toHaveBeenCalledWith('id', 'user-verified');
    expect(sendEmail.mock.calls[0][0].to).toBe('verified@example.com');
    const allArgs = JSON.stringify([bindSession.mock.calls, profileEq.mock.calls, sendEmail.mock.calls]);
    expect(allArgs).not.toContain('cookie-user');
    expect(allArgs).not.toContain('cookie@example.com');
  });

  it('verified user but no access token: 401, no write, no email', async () => {
    sessionResult = { data: { session: null } };
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(bindSession).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
