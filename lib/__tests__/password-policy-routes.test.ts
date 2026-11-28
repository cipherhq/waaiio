/**
 * #1175 F6 (W3, W4) on the server routes where a merchant chooses a new
 * password: staging sign-up and Settings > change password. Real route
 * handlers; Supabase and the rate limiter are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthWeakPasswordError, AuthApiError } from '@supabase/auth-js';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';
import {
  PASSWORD_BREACHED_TEXT,
  PASSWORD_RULE_TEXT,
  newPasswordProblem,
  weakPasswordMessage,
} from '@/lib/password-policy';

const W3 = 'Use at least 8 characters.';
const W4 = "This password has appeared in a data breach elsewhere, so it isn't safe. Please choose a different one.";

const m = vi.hoisted(() => ({
  createUser: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signInWithPassword: vi.fn(async () => ({ error: null })),
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ auth: { admin: { createUser: m.createUser } } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: m.getUser, updateUser: m.updateUser } }) }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword: m.signInWithPassword, signOut: vi.fn(async () => ({ error: null })) } }),
}));
vi.mock('@/lib/rate-limit', () => ({ getRateLimitKey: () => 'k', rateLimitResponseAsync: vi.fn(async () => null) }));
vi.mock('@/lib/otp-phone-token', () => ({ verifyPhoneOtp: vi.fn(async () => ({ valid: true })) }));
vi.mock('@/lib/logger', () => {
  const ctx = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return { logger: { ...ctx, withContext: () => ctx } };
});

const INVITE = 'c0ffee-staging-invite-2026';
function json(url: string, body: unknown) {
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.createUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  m.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'owner@example.com' } }, error: null });
  m.updateUser.mockResolvedValue({ error: null });
  vi.stubEnv('VERCEL_PROJECT_ID', STAGING_APP_PROJECT_ID);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STAGING_SUPABASE_URL);
  vi.stubEnv('STAGING_SIGNUP_INVITE_CODE', INVITE);
});
afterEach(() => vi.unstubAllEnvs());

describe('wording and rule', () => {
  it('W3 and W4 are the approved wording', () => {
    expect(PASSWORD_RULE_TEXT).toBe(W3);
    expect(PASSWORD_BREACHED_TEXT).toBe(W4);
  });
  it('7 characters are refused, 8 are accepted', () => {
    expect(newPasswordProblem('1234567')).toBe(W3);
    expect(newPasswordProblem('12345678')).toBeNull();
  });
  it('maps Supabase refusals: breach list → W4, other weak reasons → W3, other errors → null', () => {
    expect(weakPasswordMessage(new AuthWeakPasswordError('Password is known to be weak', 422, ['pwned']))).toBe(W4);
    expect(weakPasswordMessage(new AuthWeakPasswordError('Password should be at least 8 characters', 422, ['length']))).toBe(W3);
    expect(weakPasswordMessage(new AuthApiError('weak', 422, 'weak_password'))).toBe(W3);
    expect(weakPasswordMessage(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'))).toBeNull();
    expect(weakPasswordMessage(null)).toBeNull();
  });
});

describe('staging sign-up route', () => {
  async function post(password: string) {
    const { POST } = await import('@/app/api/auth/staging-signup/route');
    return POST(json('http://localhost/api/auth/staging-signup', { email: 'tester@example.com', password, inviteCode: INVITE }));
  }

  it('refuses a 7-character password with W3 before creating anything', async () => {
    const res = await post('seven77');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: W3 });
    expect(m.createUser).not.toHaveBeenCalled();
  });

  it('creates the account with an 8-character password', async () => {
    const res = await post('eight888');
    expect(res.status).toBe(201);
    expect(m.createUser).toHaveBeenCalledTimes(1);
  });

  it('a breach-list refusal from Supabase is shown as W4, not a raw error', async () => {
    m.createUser.mockResolvedValue({ data: { user: null }, error: new AuthWeakPasswordError('Password is known to be weak and easy to guess', 422, ['pwned']) });
    const res = await post('password1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: W4 });
  });

  it('an existing email is still reported as before', async () => {
    m.createUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('A user with this email address has already been registered', 422, 'email_exists') });
    const res = await post('eight888');
    expect(res.status).toBe(409);
  });
});

describe('Settings change-password route', () => {
  async function post(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/account/password/route');
    return POST(json('http://localhost/api/account/password', body));
  }

  it('refuses a 7-character new password with W3 before checking the current password', async () => {
    const res = await post({ currentPassword: 'old-secret', newPassword: 'seven77' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: W3 });
    expect(m.signInWithPassword).not.toHaveBeenCalled();
    expect(m.updateUser).not.toHaveBeenCalled();
  });

  it('accepts an 8-character new password', async () => {
    const res = await post({ currentPassword: 'old-secret', newPassword: 'eight888' });
    expect(res.status).toBe(200);
    expect(m.updateUser).toHaveBeenCalledWith({ password: 'eight888' });
  });

  it('a breach-list refusal is returned as W4', async () => {
    m.updateUser.mockResolvedValue({ error: new AuthWeakPasswordError('Password is known to be weak', 422, ['pwned']) });
    const res = await post({ currentPassword: 'old-secret', newPassword: 'password1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: W4 });
  });

  it('other update errors keep their message', async () => {
    m.updateUser.mockResolvedValue({ error: new AuthApiError('New password should be different from the old password.', 422, 'same_password') });
    const res = await post({ currentPassword: 'old-secret', newPassword: 'eight888' });
    expect(await res.json()).toEqual({ error: 'New password should be different from the old password.' });
  });
});
