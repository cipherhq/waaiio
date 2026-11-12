/**
 * Claim the free messaging credit by verifying a phone number
 * (Owner decision 2026-11-07). Route handler + helper behavior with mocked
 * Supabase; the trial rules themselves (M465) are covered by the real-PG
 * suites trial-lifecycle-db / trial-one-per-owner-db.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const BIZ = '22222222-2222-4222-8222-222222222222';
const PHONE = '+2348012345678';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimit: vi.fn(),
  verify: vi.fn(),
  bruteBlocked: new Set<string>(),
  failures: [] as string[],
  cleared: [] as string[],
  channels: [] as Array<{ phone_number: string | null }>,
  channelError: null as { message: string } | null,
  user: { phone: '', phone_confirmed_at: null as string | null },
  updateError: null as { code?: string; message: string } | null,
  updates: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
  rpc: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ authenticateRequest: m.auth }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: m.rateLimit }));
vi.mock('@/lib/otp-phone-token', () => ({ verifyPhoneOtp: m.verify }));
vi.mock('@/lib/brute-force', () => ({
  checkBruteForce: (key: string) => ({ blocked: m.bruteBlocked.has(key) }),
  recordFailure: (key: string) => { m.failures.push(key); },
  clearFailures: (key: string) => { m.cleared.push(key); },
}));

function service() {
  return {
    from: (table: string) => {
      expect(table).toBe('whatsapp_channels');
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { expect([col, val]).toEqual(['is_active', true]); return q; },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: m.channels, error: m.channelError }),
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, ...m.user } }, error: null }),
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          m.updates.push({ id, attrs });
          return { data: {}, error: m.updateError };
        },
      },
    },
    rpc: m.rpc,
  };
}

import { POST } from '@/app/api/trial-credit/claim/route';
import { attachVerifiedPhone, isConnectedWaaiioNumber, isPhoneInUseError } from '@/lib/trial-credit/verified-phone';

const req = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/trial-credit/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const claim = (extra: Record<string, unknown> = {}) => POST(req({ business_id: BIZ, phone: PHONE, otp: '123456', pin_id: 'pin', ...extra }));

beforeEach(() => {
  vi.clearAllMocks();
  m.bruteBlocked.clear();
  m.failures = []; m.cleared = []; m.updates = [];
  m.channels = [{ phone_number: '+1 (571) 274-6425' }, { phone_number: null }];
  m.channelError = null;
  m.user = { phone: '', phone_confirmed_at: null };
  m.updateError = null;
  m.auth.mockImplementation(async () => ({ user: { id: 'owner' }, businessId: BIZ, service: service() }));
  m.rateLimit.mockResolvedValue(null);
  m.verify.mockResolvedValue({ valid: true });
  m.rpc.mockResolvedValue({ data: { activated: true, trial_ends_at: '2026-12-07' }, error: null });
});

describe('POST /api/trial-credit/claim', () => {
  it('passes through the auth/ownership refusal and does nothing else', async () => {
    m.auth.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden: you do not own this business' }, { status: 403 }));
    const r = await claim();
    expect(r.status).toBe(403);
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('checks ownership of the business in the body', async () => {
    await claim();
    expect(m.auth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requireBusinessOwnership: true, businessIdKey: 'business_id' }));
  });

  it.each([
    [{ phone: '08012345678' }], [{ phone: '+0123' }], [{ otp: '12345' }], [{ otp: 'abcdef' }], [{ pin_id: '' }],
  ])('rejects bad input %j with 400 before any code check', async (extra) => {
    const r = await claim(extra);
    expect(r.status).toBe(400);
    expect(m.verify).not.toHaveBeenCalled();
  });

  it('pre-check refuses a number connected to Waaiio (digits compared, formatting ignored)', async () => {
    const r = await POST(req({ business_id: BIZ, phone: '+15712746425', check: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('connected_number');
    expect(m.verify).not.toHaveBeenCalled();
  });

  it('pre-check accepts any other number and verifies nothing', async () => {
    const r = await POST(req({ business_id: BIZ, phone: PHONE, check: true }));
    expect(r.status).toBe(200);
    expect(m.rateLimit).toHaveBeenCalledWith('claim-check:owner', 10, 10 * 60 * 1000);
    expect(await r.json()).toEqual({ ok: true });
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.updates).toEqual([]);
  });

  it('pre-check is rate limited per login', async () => {
    m.rateLimit.mockResolvedValueOnce(NextResponse.json({ error: 'slow down' }, { status: 429 }));
    expect((await POST(req({ business_id: BIZ, phone: PHONE, check: true }))).status).toBe(429);
  });

  it('pre-check fails closed when the channel lookup fails', async () => {
    m.channelError = { message: 'down' };
    const r = await POST(req({ business_id: BIZ, phone: PHONE, check: true }));
    expect(r.status).toBe(500);
  });

  it('refuses a connected Waaiio number on submit too, without consuming the code', async () => {
    const r = await claim({ phone: '+15712746425' });
    expect(r.status).toBe(400);
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.updates).toEqual([]);
  });

  it('a wrong code is 401, counts a failure, and attaches nothing', async () => {
    m.verify.mockResolvedValueOnce({ valid: false, reason: 'wrong_otp' });
    const r = await claim();
    expect(r.status).toBe(401);
    expect(m.failures).toEqual([`otp-phone:${PHONE}`, 'claim-user:owner']);
    expect(m.updates).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('is rate limited per phone and blocked after repeated failures', async () => {
    m.rateLimit.mockResolvedValueOnce(NextResponse.json({ error: 'slow down' }, { status: 429 }));
    expect((await claim()).status).toBe(429);
    expect(m.rateLimit).toHaveBeenCalledWith(`otp-verify:${PHONE}`, 5, 15 * 60 * 1000);
    m.bruteBlocked.add('claim-user:owner');
    expect((await claim()).status).toBe(429);
    expect(m.verify).not.toHaveBeenCalled();
  });

  it('a valid code saves the number as the confirmed phone, then runs the normal trial check', async () => {
    const r = await claim();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ verified: true, credited: true });
    expect(m.verify).toHaveBeenCalledWith(PHONE, '123456', 'pin');
    expect(m.updates).toEqual([{ id: 'owner', attrs: { phone: PHONE, phone_confirm: true } }]);
    expect(m.rpc).toHaveBeenCalledWith('activate_trial_if_eligible', { p_business_id: BIZ });
    expect(m.cleared).toEqual([`otp-phone:${PHONE}`, 'claim-user:owner']);
  });

  it('reports the trial reason when no credit is added (billing not on yet)', async () => {
    m.rpc.mockResolvedValueOnce({ data: { activated: false, reason: 'financial_gate_off' }, error: null });
    expect(await (await claim()).json()).toEqual({ verified: true, credited: false, reason: 'financial_gate_off' });
  });

  it('a number already on another login is refused with 409 and no trial check', async () => {
    m.updateError = { code: 'phone_exists', message: 'Phone number already registered by another user' };
    const r = await claim();
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('phone_in_use');
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('never replaces a different phone already confirmed on this login', async () => {
    m.user = { phone: '2348099999999', phone_confirmed_at: '2026-11-01T00:00:00Z' };
    const r = await claim();
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('other_phone_already_verified');
    expect(m.updates).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('the same phone already confirmed is fine and still runs the trial check', async () => {
    m.user = { phone: '2348012345678', phone_confirmed_at: '2026-11-01T00:00:00Z' };
    const r = await claim();
    expect(r.status).toBe(200);
    expect(m.updates).toEqual([]);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it('an RPC error still reports the number as verified, not credited', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await (await claim()).json()).toEqual({ verified: true, credited: false, reason: 'activation_error' });
  });
});

describe('verified-phone helpers', () => {
  it('isPhoneInUseError recognises the auth error by code or message only', () => {
    expect(isPhoneInUseError({ code: 'phone_exists', message: '' })).toBe(true);
    expect(isPhoneInUseError({ message: 'Phone number already registered' })).toBe(true);
    expect(isPhoneInUseError({ message: 'A user with this email address has already been registered' })).toBe(false);
    expect(isPhoneInUseError({ code: 'unexpected_failure', message: 'Database error' })).toBe(false);
    expect(isPhoneInUseError(null)).toBe(false);
  });

  it('isConnectedWaaiioNumber matches digits and throws on a lookup error', async () => {
    const s = service() as never;
    expect(await isConnectedWaaiioNumber(s, '+15712746425')).toBe(true);
    expect(await isConnectedWaaiioNumber(s, PHONE)).toBe(false);
    expect(await isConnectedWaaiioNumber(s, '')).toBe(false);
    m.channelError = { message: 'down' };
    await expect(isConnectedWaaiioNumber(s, PHONE)).rejects.toThrow();
  });

  it('attachVerifiedPhone reports a non-phone update failure as failed', async () => {
    m.updateError = { message: 'Database error updating user' };
    expect(await attachVerifiedPhone(service() as never, 'owner', PHONE)).toEqual({ ok: false, reason: 'failed' });
  });
});
