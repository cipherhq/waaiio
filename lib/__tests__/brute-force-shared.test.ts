/**
 * #1175 slice 1 (F14, S8, C3 A, Q10 A): code-attempt limits are counted in the
 * shared store when it is configured, separately per scope, with the same
 * numbers as before; an unreachable store falls back per server and alerts.
 *
 * Unit tests run the real lib/brute-force.ts against an in-memory fake of the
 * Upstash client shared by two separately imported module instances (two
 * "servers"). Handler tests run the real route handlers of all five callers
 * (otp/verify, otp/send, email-otp, contracts/otp/verify, trial-credit/claim)
 * with that same fake store. The unit test "customer, contract and merchant
 * counts never affect each other" checks the new API; the handler test for
 * customers' and contract signers' codes is the one that fails on old code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Fake Upstash store, shared across module instances ──

const h = vi.hoisted(() => {
  type Entry = { value: string; expiresAt: number | null };
  const data = new Map<string, Entry>();
  let down = false;
  let writesDown = false;
  const live = (k: string): Entry | undefined => {
    const e = data.get(k);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { data.delete(k); return undefined; }
    return e;
  };
  const guard = () => { if (down) throw new Error('store unreachable'); };
  const guardWrite = () => { guard(); if (writesDown) throw new Error('store refused write'); };
  const redis = {
    async pttl(k: string) { guard(); const e = live(k); if (!e) return -2; return e.expiresAt === null ? -1 : e.expiresAt - Date.now(); },
    async get(k: string) { guard(); const e = live(k); return e ? Number(e.value) : null; },
    async set(k: string, v: string, opts?: { px?: number }) { guardWrite(); data.set(k, { value: v, expiresAt: opts?.px ? Date.now() + opts.px : null }); return 'OK'; },
    async del(...ks: string[]) { guardWrite(); let n = 0; for (const k of ks) if (data.delete(k)) n++; return n; },
    multi() {
      const ops: Array<() => number> = [];
      const tx = {
        incr(k: string) { ops.push(() => { const e = live(k); const n = (e ? Number(e.value) : 0) + 1; data.set(k, { value: String(n), expiresAt: e?.expiresAt ?? null }); return n; }); return tx; },
        pexpire(k: string, ms: number) { ops.push(() => { const e = live(k); if (!e) return 0; e.expiresAt = Date.now() + ms; return 1; }); return tx; },
        async exec() { guardWrite(); return ops.map((op) => op()); },
      };
      return tx;
    },
  };
  return {
    data, redis,
    enabled: true,
    setDown(v: boolean) { down = v; },
    setWritesDown(v: boolean) { writesDown = v; },
    reset() { data.clear(); down = false; writesDown = false; },
  };
});

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureMessage }));

vi.mock('@/lib/rate-limit', () => ({
  getSharedRedis: () => (h.enabled ? h.redis : null),
  // Reaching an otp-send limit check means the brute-force check let the request through.
  rateLimitResponseAsync: async (key: string) => (key.startsWith('otp-send:') ? new Response(null, { status: 418 }) : null),
  getRateLimitKey: (_req: Request, prefix: string) => `${prefix}:test`,
}));

type BF = typeof import('@/lib/brute-force');
async function freshInstance(): Promise<BF> {
  vi.resetModules();
  return import('@/lib/brute-force');
}

const PHONE = '+2348011112222';

beforeEach(() => {
  h.reset();
  h.enabled = true;
  captureMessage.mockClear();
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

describe('shared counting (unit)', () => {
  it('two server instances share one count and lock at 5 failures', async () => {
    const a = await freshInstance();
    const b = await freshInstance();
    expect(a).not.toBe(b);
    for (let i = 0; i < 2; i++) await a.recordFailure('merchant', `otp-phone:${PHONE}`);
    for (let i = 0; i < 2; i++) await b.recordFailure('merchant', `otp-phone:${PHONE}`);
    expect((await a.checkBruteForce('merchant', `otp-phone:${PHONE}`)).blocked).toBe(false);
    const fifth = await a.recordFailure('merchant', `otp-phone:${PHONE}`);
    expect(fifth).toMatchObject({ locked: true, failures: 5, lockDurationMs: 15 * 60_000 });
    const onB = await b.checkBruteForce('merchant', `otp-phone:${PHONE}`);
    expect(onB.blocked).toBe(true);
    expect(onB.retryAfterMs).toBeGreaterThan(14 * 60_000);
  });

  it('parallel failures are each counted once (atomic increment)', async () => {
    const a = await freshInstance();
    const b = await freshInstance();
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => a.recordFailure('merchant', `otp-phone:${PHONE}`)),
      ...Array.from({ length: 2 }, () => b.recordFailure('merchant', `otp-phone:${PHONE}`)),
    ]);
    expect(results.map((r) => r.failures).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((r) => r.locked)).toHaveLength(1);
  });

  it('address keys keep their own numbers: 20 failures, 30 minutes', async () => {
    const a = await freshInstance();
    for (let i = 0; i < 19; i++) expect((await a.recordFailure('merchant', 'ip:1.2.3.4')).locked).toBe(false);
    expect(await a.recordFailure('merchant', 'ip:1.2.3.4')).toMatchObject({ locked: true, failures: 20, lockDurationMs: 30 * 60_000 });
  });

  it('customer, contract and merchant counts never affect each other', async () => {
    const a = await freshInstance();
    for (let i = 0; i < 20; i++) await a.recordFailure('customer', 'ip:1.2.3.4');
    for (let i = 0; i < 20; i++) await a.recordFailure('contract', 'ip:1.2.3.4');
    expect((await a.checkBruteForce('customer', 'ip:1.2.3.4')).blocked).toBe(true);
    expect((await a.checkBruteForce('contract', 'ip:1.2.3.4')).blocked).toBe(true);
    expect(await a.checkBruteForce('merchant', 'ip:1.2.3.4')).toMatchObject({ blocked: false, failures: 0 });
    // A customer's success does not clear the merchant's count either.
    await a.recordFailure('merchant', 'ip:1.2.3.4');
    await a.clearFailures('customer', 'ip:1.2.3.4');
    expect((await a.checkBruteForce('merchant', 'ip:1.2.3.4')).failures).toBe(1);
  });

  it('clearFailures removes the count and the lock on every server', async () => {
    const a = await freshInstance();
    const b = await freshInstance();
    for (let i = 0; i < 5; i++) await a.recordFailure('merchant', `otp-phone:${PHONE}`);
    await b.clearFailures('merchant', `otp-phone:${PHONE}`);
    expect(await a.checkBruteForce('merchant', `otp-phone:${PHONE}`)).toMatchObject({ blocked: false, failures: 0 });
  });

  it('a lock ends after 15 minutes and the count resets after 30 minutes without failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    const a = await freshInstance();
    for (let i = 0; i < 5; i++) await a.recordFailure('merchant', `otp-phone:${PHONE}`);
    vi.setSystemTime(new Date('2026-11-27T10:15:01Z'));
    expect(await a.checkBruteForce('merchant', `otp-phone:${PHONE}`)).toMatchObject({ blocked: false, failures: 5 });
    vi.setSystemTime(new Date('2026-11-27T10:30:01Z'));
    expect(await a.checkBruteForce('merchant', `otp-phone:${PHONE}`)).toMatchObject({ blocked: false, failures: 0 });
  });

  it('store keys hold a hash, never the raw phone, email or contract token', async () => {
    const a = await freshInstance();
    await a.recordFailure('merchant', `otp-phone:${PHONE}`);
    await a.recordFailure('customer', 'otp:ada@example.com');
    await a.recordFailure('contract', 'contract-otp:secret-token-123');
    for (let i = 0; i < 5; i++) await a.recordFailure('merchant', 'claim-user:user-1');
    const keys = [...h.data.keys()];
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const k of keys) {
      expect(k).toMatch(/^bf:(merchant|customer|contract):[cl]:[0-9a-f]{64}$/);
      expect(k).not.toContain('2348011112222');
      expect(k).not.toContain('ada@example.com');
      expect(k).not.toContain('secret-token-123');
      expect(k).not.toContain('user-1');
    }
  });

  it('without the store, counting is per server instance as before', async () => {
    h.enabled = false;
    const a = await freshInstance();
    const b = await freshInstance();
    for (let i = 0; i < 5; i++) await a.recordFailure('merchant', `otp-phone:${PHONE}`);
    expect((await a.checkBruteForce('merchant', `otp-phone:${PHONE}`)).blocked).toBe(true);
    expect((await b.checkBruteForce('merchant', `otp-phone:${PHONE}`)).blocked).toBe(false);
    expect(h.data.size).toBe(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('store unreachable: falls back per server, still enforces the limit, and alerts Sentry', async () => {
    const a = await freshInstance();
    h.setDown(true);
    for (let i = 0; i < 4; i++) expect((await a.recordFailure('merchant', `otp-phone:${PHONE}`)).locked).toBe(false);
    expect((await a.recordFailure('merchant', `otp-phone:${PHONE}`)).locked).toBe(true);
    expect((await a.checkBruteForce('merchant', `otp-phone:${PHONE}`)).blocked).toBe(true);
    await expect(a.clearFailures('merchant', `otp-phone:${PHONE}`)).resolves.toBeUndefined();
    expect(captureMessage).toHaveBeenCalled();
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ level: 'error', tags: { component: 'brute-force' } });
    for (const call of captureMessage.mock.calls) expect(JSON.stringify(call)).not.toContain('2348011112222');
  });

  it('store serves reads but refuses writes: the per-server lock is still enforced, with an alert', async () => {
    const a = await freshInstance();
    h.setWritesDown(true);
    for (let i = 0; i < 4; i++) expect((await a.recordFailure('merchant', `otp-phone:${PHONE}`)).locked).toBe(false);
    expect((await a.recordFailure('merchant', `otp-phone:${PHONE}`)).locked).toBe(true);
    const check = await a.checkBruteForce('merchant', `otp-phone:${PHONE}`);
    expect(check.blocked).toBe(true);
    expect(check.retryAfterMs).toBeGreaterThan(14 * 60_000);
    expect(captureMessage).toHaveBeenCalled();
    // Other keys and scopes are not affected by this server's fallback lock.
    expect((await a.checkBruteForce('customer', `otp-phone:${PHONE}`)).blocked).toBe(false);
  });
});

// ── Handler tests: the five callers, real handlers, real brute-force ──

const verifyPhoneOtp = vi.hoisted(() => vi.fn(async () => ({ valid: false })));
const verifyOtpChallenge = vi.hoisted(() => vi.fn(async () => ({ valid: false, reason: 'wrong_otp' })));

vi.mock('@/lib/otp-phone-token', () => ({
  verifyPhoneOtp,
  generatePhonePassword: () => 'temp',
  generatePhoneOtp: vi.fn(),
}));
vi.mock('@/lib/otp-challenge', () => ({ verifyOtpChallenge, generateOtpChallenge: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/customer-block', () => ({ webCheckoutBlocked: async () => false, customerBlockedResponse: () => new Response(null, { status: 403 }) }));
vi.mock('@/lib/security/session-bind', () => ({ bindSession: vi.fn() }));
vi.mock('@/lib/security/create-security-event', () => ({ createSecurityEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/signup-gate', () => ({ isSignupOpen: async () => true }));
vi.mock('@/lib/channels/meta-cloud', () => ({ MetaCloudService: class {} }));
vi.mock('@/lib/channels/staging-whatsapp-routing', () => ({ isStagingWhatsAppRouting: () => false, loadStagingDesignatedChannel: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: async () => ({ user: { id: 'user-1' }, businessId: 'biz-1', service: {} }),
}));
vi.mock('@/lib/trial-credit/verified-phone', () => ({
  isConnectedWaaiioNumber: async () => false,
  attachVerifiedPhone: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { signInWithPassword: vi.fn(), getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }) }));

function contractChain() {
  const record = { id: 'c1', status: 'pending', otp_code: '111111', otp_expires_at: '2999-01-01T00:00:00Z', otp_attempts: 0, otp_verified: false };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.update = () => chain;
  chain.single = async () => ({ data: record, error: null });
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
  return chain;
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: () => contractChain() }) }));

function post(url: string, body: unknown, ip = '9.9.9.9') {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

async function routes() {
  vi.resetModules();
  return {
    otpVerify: (await import('@/app/api/auth/otp/verify/route')).POST,
    otpSend: (await import('@/app/api/auth/otp/send/route')).POST,
    emailOtp: (await import('@/app/api/auth/email-otp/route')).POST,
    contractVerify: (await import('@/app/api/contracts/otp/verify/route')).POST,
    claim: (await import('@/app/api/trial-credit/claim/route')).POST,
  };
}

describe('the callers keep their numbers and their own scope', () => {
  it('merchant otp/verify: 5 wrong codes on a phone, then 429, counted across two servers', async () => {
    const s1 = await routes();
    const s2 = await routes();
    for (let i = 0; i < 5; i++) {
      const srv = i % 2 === 0 ? s1 : s2;
      const res = await srv.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: PHONE, otp: '000000', pin_id: 'p' }, `10.0.0.${i}`));
      expect(res.status).toBe(401);
    }
    const res = await s2.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: PHONE, otp: '000000', pin_id: 'p' }, '10.0.0.99'));
    expect(res.status).toBe(429);
  });

  it('merchant address lock (20 failures) blocks otp/send from that address; another address is unaffected', async () => {
    const s = await routes();
    for (let i = 0; i < 20; i++) {
      await s.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: `+23480111100${String(i).padStart(2, '0')}`, otp: '000000', pin_id: 'p' }, '7.7.7.7'));
    }
    expect((await s.otpSend(post('http://localhost/api/auth/otp/send', { phone: PHONE }, '7.7.7.7'))).status).toBe(429);
    expect((await s.otpSend(post('http://localhost/api/auth/otp/send', { phone: PHONE }, '8.8.8.8'))).status).toBe(418);
  });

  it("customers' and contract signers' wrong codes from one address never lock merchant sign-in codes there", async () => {
    const s = await routes();
    for (let i = 0; i < 20; i++) {
      await s.emailOtp(post('http://localhost/api/auth/email-otp?action=verify', { email: `c${i}@example.com`, code: '000000', challengeId: 'ch' }, '6.6.6.6'));
      await s.contractVerify(post('http://localhost/api/contracts/otp/verify', { token: `tok-${i}`, otp: '000000' }, '6.6.6.6'));
    }
    // Customer and contract address counts are locked...
    expect((await s.emailOtp(post('http://localhost/api/auth/email-otp?action=verify', { email: 'z@example.com', code: '1', challengeId: 'ch' }, '6.6.6.6'))).status).toBe(429);
    expect((await s.contractVerify(post('http://localhost/api/contracts/otp/verify', { token: 'tok-z', otp: '1' }, '6.6.6.6'))).status).toBe(429);
    // ...but merchant sign-in codes from the same address are not.
    expect((await s.otpSend(post('http://localhost/api/auth/otp/send', { phone: PHONE }, '6.6.6.6'))).status).toBe(418);
    expect((await s.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: PHONE, otp: '000000', pin_id: 'p' }, '6.6.6.6'))).status).toBe(401);
  });

  it('claim-credit shares the merchant phone count with otp/verify: 3 + 2 wrong codes, then 429 on both', async () => {
    const s = await routes();
    for (let i = 0; i < 3; i++) {
      expect((await s.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: PHONE, otp: '000000', pin_id: 'p' }, `12.0.0.${i}`))).status).toBe(401);
    }
    for (let i = 0; i < 2; i++) {
      expect((await s.claim(post('http://localhost/api/trial-credit/claim', { business_id: 'biz-1', phone: PHONE, otp: '000000', pin_id: 'p' }))).status).toBe(401);
    }
    expect((await s.claim(post('http://localhost/api/trial-credit/claim', { business_id: 'biz-1', phone: PHONE, otp: '000000', pin_id: 'p' }))).status).toBe(429);
    expect((await s.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: PHONE, otp: '000000', pin_id: 'p' }, '12.0.0.99'))).status).toBe(429);
  });

  it('claim-credit: 5 wrong codes by one user lock that user across numbers', async () => {
    const s = await routes();
    for (let i = 0; i < 5; i++) {
      const phone = `+23480222200${i}0`;
      expect((await s.claim(post('http://localhost/api/trial-credit/claim', { business_id: 'biz-1', phone, otp: '000000', pin_id: 'p' }))).status).toBe(401);
    }
    expect((await s.claim(post('http://localhost/api/trial-credit/claim', { business_id: 'biz-1', phone: '+2348022220099', otp: '000000', pin_id: 'p' }))).status).toBe(429);
  });

  it('customer email-otp: 5 wrong codes on one email, then 429', async () => {
    const s = await routes();
    for (let i = 0; i < 5; i++) {
      expect((await s.emailOtp(post('http://localhost/api/auth/email-otp?action=verify', { email: 'ada@example.com', code: '000000', challengeId: 'ch' }, `11.0.0.${i}`))).status).toBe(401);
    }
    expect((await s.emailOtp(post('http://localhost/api/auth/email-otp?action=verify', { email: 'ada@example.com', code: '000000', challengeId: 'ch' }, '11.0.0.99'))).status).toBe(429);
  });

  it('store unreachable: merchant otp/verify still answers (falls back) and Sentry is alerted', async () => {
    const s = await routes();
    h.setDown(true);
    const res = await s.otpVerify(post('http://localhost/api/auth/otp/verify', { phone: PHONE, otp: '000000', pin_id: 'p' }));
    expect(res.status).toBe(401);
    expect(captureMessage).toHaveBeenCalled();
  });
});

describe('the real rate-limit module exposes the shared store only when configured', () => {
  it('returns null without Upstash env', async () => {
    vi.resetModules();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    const real = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
    expect(real.getSharedRedis()).toBeNull();
    vi.unstubAllEnvs();
  });

  it('returns the Upstash client when the env is set', async () => {
    vi.resetModules();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');
    const real = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
    const { Redis } = await vi.importActual<typeof import('@upstash/redis')>('@upstash/redis');
    expect(real.getSharedRedis()).toBeInstanceOf(Redis);
    vi.unstubAllEnvs();
  });
});
