/**
 * Phone OTP login: only an account whose own confirmed auth phone matches the
 * verified phone may be signed in (Owner decision 2026-11-06).
 *
 * Runs the real route handler with Supabase and OTP dependencies mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Profile = { id: string; phone: string | null; first_name: string | null };
type AuthUser = { id: string; phone: string; email: string };

let profiles: Profile[] = [];
let authUsers: AuthUser[] = [];
let signupOpen = true;

const updateUserById = vi.fn(async (_id: string, _attrs: Record<string, unknown>) => ({ data: {}, error: null }));
const createUser = vi.fn(async (attrs: Record<string, unknown>) => ({
  data: { user: { id: 'new-user', email: attrs.email } },
  error: null,
}));
const signInWithPassword = vi.fn(async (_creds: { email: string; password: string }) => ({ error: null }));

function profilesTable() {
  const filters: Array<[string, unknown]> = [];
  const rows = () => profiles.filter((p) => filters.every(([k, v]) => (p as Record<string, unknown>)[k] === v));
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
    limit: async (n: number) => ({ data: rows().slice(0, n), error: null }),
    maybeSingle: async () => {
      const r = rows();
      if (r.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: r[0] ?? null, error: null };
    },
  };
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      return profilesTable();
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const u = authUsers.find((a) => a.id === id);
          return { data: { user: u ?? null }, error: null };
        },
        updateUserById,
        createUser,
      },
    },
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signInWithPassword } }),
}));

vi.mock('@/lib/otp-phone-token', () => ({
  verifyPhoneOtp: vi.fn(async () => ({ valid: true })),
  generatePhonePassword: vi.fn(() => 'temp-password'),
}));

vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: vi.fn(async () => null) }));
vi.mock('@/lib/brute-force', () => ({
  checkBruteForce: () => ({ blocked: false }),
  recordFailure: () => ({ locked: false, failures: 1 }),
  clearFailures: () => {},
}));
vi.mock('@/lib/security/session-bind', () => ({ bindSession: vi.fn(async () => {}) }));
vi.mock('@/lib/security/create-security-event', () => ({ createSecurityEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/signup-gate', () => ({ isSignupOpen: async () => signupOpen }));

import { POST } from '@/app/api/auth/otp/verify/route';

const PHONE = '+2348011112222';

function request() {
  return new Request('http://localhost/api/auth/otp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, otp: '123456', pin_id: 'challenge-1' }),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  profiles = [];
  authUsers = [];
  signupOpen = true;
  updateUserById.mockClear();
  createUser.mockClear();
  signInWithPassword.mockClear();
});

describe('phone OTP login uses the confirmed auth phone', () => {
  it('denies an account whose profile phone was set but whose auth phone differs', async () => {
    profiles = [{ id: 'victim', phone: PHONE, first_name: 'Ada' }];
    authUsers = [{ id: 'victim', phone: '', email: 'owner@example.com' }];

    const res = await POST(request());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toMatch(/log in with your email/i);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('denies when the auth phone is a different confirmed number', async () => {
    profiles = [{ id: 'victim', phone: PHONE, first_name: 'Ada' }];
    authUsers = [{ id: 'victim', phone: '447700900123', email: 'owner@example.com' }];

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('signs in the account whose confirmed auth phone matches (auth stores digits without +)', async () => {
    profiles = [{ id: 'owner', phone: PHONE, first_name: 'Ada' }];
    authUsers = [{ id: 'owner', phone: '2348011112222', email: 'owner@example.com' }];

    const res = await POST(request());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe('owner');
    expect(body.is_new_user).toBe(false);
    expect(updateUserById).toHaveBeenCalledWith('owner', expect.objectContaining({ password: 'temp-password' }));
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.com', password: 'temp-password' });
  });

  it('picks the confirmed account when another profile also claims the phone', async () => {
    profiles = [
      { id: 'squatter', phone: PHONE, first_name: 'Eve' },
      { id: 'owner', phone: PHONE, first_name: 'Ada' },
    ];
    authUsers = [
      { id: 'squatter', phone: '', email: 'eve@example.com' },
      { id: 'owner', phone: '2348011112222', email: 'owner@example.com' },
    ];

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect((await res.json()).user_id).toBe('owner');
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(updateUserById.mock.calls[0][0]).toBe('owner');
  });

  it('still creates a new account when no profile has the phone', async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe('new-user');
    expect(body.is_new_user).toBe(true);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE, phone_confirm: true }));
  });

  it('still respects the sign-up gate for a brand-new phone', async () => {
    signupOpen = false;
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });
});
