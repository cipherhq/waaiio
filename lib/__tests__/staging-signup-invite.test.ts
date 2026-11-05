import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';

// Staging sign-up needs an invite code that only the Owner and testers have.
// The real route runs; only the Supabase admin client and rate limiter are faked.

const createUser = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ auth: { admin: { createUser } } }) }));
vi.mock('@/lib/rate-limit', () => ({ getRateLimitKey: () => 'test-key', rateLimitResponseAsync: rateLimit }));

const { POST } = await import('@/app/api/auth/staging-signup/route');

const CODE = 'c0ffee-staging-invite-2026';

function signup(body: Record<string, unknown>) {
  return POST(new NextRequest('https://staging.waaiio.com/api/auth/staging-signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  createUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  rateLimit.mockResolvedValue(null);
  vi.stubEnv('VERCEL_PROJECT_ID', STAGING_APP_PROJECT_ID);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STAGING_SUPABASE_URL);
  vi.stubEnv('STAGING_SIGNUP_INVITE_CODE', CODE);
});
afterEach(() => vi.unstubAllEnvs());

describe('staging sign-up invite code', () => {
  it('creates the account when the invite code matches', async () => {
    const response = await signup({ email: ' Tester@Example.com ', password: 'secret123', inviteCode: CODE });
    expect(response.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith({ email: 'tester@example.com', password: 'secret123', email_confirm: true });
  });

  it.each([
    ['a wrong code', { inviteCode: 'not-the-code-at-all-123' }],
    ['the code with a different case', { inviteCode: CODE.toUpperCase() }],
    ['no code', {}],
    ['a non-string code', { inviteCode: 12345 }],
  ])('refuses %s and creates nothing', async (_label, extra) => {
    const response = await signup({ email: 'tester@example.com', password: 'secret123', ...extra });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ message: 'That invite code is not valid.' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it.each([
    ['is not set', undefined],
    ['is empty', ''],
    ['is shorter than 16 characters', 'short-code'],
  ])('stays closed when the staging code %s', async (_label, configured) => {
    if (configured === undefined) vi.stubEnv('STAGING_SIGNUP_INVITE_CODE', undefined as unknown as string);
    else vi.stubEnv('STAGING_SIGNUP_INVITE_CODE', configured);
    const response = await signup({ email: 'tester@example.com', password: 'secret123', inviteCode: configured || CODE });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ message: 'Staging sign-up is closed. Ask the Waaiio team for access.' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('counts wrong guesses against the rate limit before checking the code', async () => {
    rateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const response = await signup({ email: 'tester@example.com', password: 'secret123', inviteCode: 'wrong-guess-0000000' });
    expect(response.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith('test-key', 20, 60 * 60 * 1000);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('is still hidden outside staging, even with the right code', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_QkvBTiDA905GHTwX5DQCJVyZzd9d');
    const response = await signup({ email: 'tester@example.com', password: 'secret123', inviteCode: CODE });
    expect(response.status).toBe(404);
    expect(createUser).not.toHaveBeenCalled();
  });
});
