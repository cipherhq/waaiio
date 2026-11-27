/**
 * POST /api/account/password confirms the current password before changing it.
 *
 * Runs the real route handler with Supabase and the rate limiter mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type User = { id: string; email?: string | null; phone?: string | null };

let getUserResult: { data: { user: User | null }; error: { message: string } | null };
let signInResult: { error: { message: string } | null };
let updateResult: { error: { message: string } | null };
let limitedResponse: Response | null;

const getUser = vi.fn(async () => getUserResult);
const updateUser = vi.fn(async (_attrs: { password: string }) => updateResult);
const signInWithPassword = vi.fn(async (_creds: Record<string, string>) => signInResult);
const signOut = vi.fn(async (_opts?: unknown) => ({ error: null }));
const throwawayClient = vi.fn((_url: string, _key: string, _opts: unknown) => ({
  auth: { signInWithPassword, signOut },
}));
const rateLimit = vi.fn(async (_key: string, _max: number, _win: number) => limitedResponse);

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser, updateUser } }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, opts: unknown) => throwawayClient(url, key, opts),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: (key: string, max: number, win: number) => rateLimit(key, max, win),
}));
vi.mock('@/lib/logger', () => {
  const ctx = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { logger: { ...ctx, withContext: () => ctx } };
});

import { POST } from '@/app/api/account/password/route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserResult = { data: { user: { id: 'user-1', email: 'owner@example.com' } }, error: null };
  signInResult = { error: null };
  updateResult = { error: null };
  limitedResponse = null;
});

describe('POST /api/account/password', () => {
  it('correct current password: confirms it, then updates the password', async () => {
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.com', password: 'old-secret' });
    expect(updateUser).toHaveBeenCalledWith({ password: 'new-secret' });
    // The check uses a throwaway client that never stores a session.
    expect(throwawayClient.mock.calls[0][2]).toEqual({ auth: { persistSession: false, autoRefreshToken: false } });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('wrong current password: refused with 403 and the password is NOT changed', async () => {
    signInResult = { error: { message: 'Invalid login credentials' } };
    const res = await POST(req({ currentPassword: 'wrong', newPassword: 'new-secret' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Current password is incorrect.' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('empty current password: refused with 400, nothing checked or changed', async () => {
    const res = await POST(req({ currentPassword: '', newPassword: 'new-secret' }));
    expect(res.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('missing current password field: refused with 400, nothing changed', async () => {
    const res = await POST(req({ newPassword: 'new-secret' }));
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('new password too short: refused with 400 before any check', async () => {
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: '12345' }));
    expect(res.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('not signed in: 401, nothing checked or changed', async () => {
    getUserResult = { data: { user: null }, error: null };
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
    expect(res.status).toBe(401);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('getUser error: 401, nothing changed', async () => {
    getUserResult = { data: { user: null }, error: { message: 'jwt expired' } };
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
    expect(res.status).toBe(401);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('rate limited: the limiter response is returned, nothing checked or changed', async () => {
    limitedResponse = new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), { status: 429 });
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
    expect(res.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith('account-password:user-1', 5, 15 * 60 * 1000);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('phone-only account: confirms with the phone', async () => {
    getUserResult = { data: { user: { id: 'user-2', email: null, phone: '2348031234567' } }, error: null };
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
    expect(res.status).toBe(200);
    expect(signInWithPassword).toHaveBeenCalledWith({ phone: '2348031234567', password: 'old-secret' });
  });

  it('account with no email or phone: refused, nothing changed', async () => {
    getUserResult = { data: { user: { id: 'user-3', email: null, phone: null } }, error: null };
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('invalid JSON body: 400, nothing changed', async () => {
    const res = await POST(req('not json'));
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('Supabase refuses the new password: its message is returned', async () => {
    updateResult = { error: { message: 'Password should be different from the old password.' } };
    const res = await POST(req({ currentPassword: 'old-secret', newPassword: 'old-secret' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Password should be different from the old password.' });
  });
});
