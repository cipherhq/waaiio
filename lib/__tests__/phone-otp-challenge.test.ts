/**
 * Phone OTP Challenge Security Tests
 *
 * Tests the server-side, single-use, opaque challenge system using a
 * behaviorally accurate stateful mock that simulates the database's
 * atomic operations faithfully.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════
// Stateful mock repository — simulates database state transitions
// ═══════════════════════════════════════════════════════════

interface MockChallenge {
  id: string;
  challenge_id: string;
  phone_hash: string;
  otp_hash: string;
  expires_at: string;
  consumed_at: string | null;
  failed_attempts: number;
  created_at: string;
  last_attempt_at: string | null;
}

let challengeStore: MockChallenge[] = [];
let nextId = 1;

function resetStore() {
  challengeStore = [];
  nextId = 1;
}

/** Build a Supabase-compatible chainable query mock that respects challenge state. */
function buildServiceMock() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'phone_otp_challenges') {
        return makeNoopChain({ data: null, error: null });
      }
      return {
        insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
          const record: MockChallenge = {
            id: `uuid-${nextId++}`,
            challenge_id: data.challenge_id as string,
            phone_hash: data.phone_hash as string,
            otp_hash: data.otp_hash as string,
            expires_at: data.expires_at as string,
            consumed_at: null,
            failed_attempts: 0,
            created_at: new Date().toISOString(),
            last_attempt_at: null,
          };
          challengeStore.push(record);
          return Promise.resolve({ error: null });
        }),
        select: vi.fn().mockImplementation(() => {
          return {
            eq: vi.fn().mockImplementation((_col: string, val: string) => ({
              maybeSingle: vi.fn().mockImplementation(() => {
                const found = challengeStore.find(c => c.challenge_id === val);
                return Promise.resolve({ data: found ? { ...found } : null, error: null });
              }),
            })),
          };
        }),
        update: vi.fn().mockReturnValue(makeNoopChain({ data: null, error: null })),
      };
    }),
    rpc: vi.fn().mockImplementation((fn: string, params?: Record<string, unknown>) => {
      if (fn === 'cleanup_expired_otp_challenges') {
        return { then: (_ok: () => void, _err: () => void) => {} };
      }
      if (fn === 'otp_record_failed_attempt' && params) {
        const cId = params.p_challenge_id as string;
        const challenge = challengeStore.find(c => c.id === cId);
        if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) < new Date() || challenge.failed_attempts >= 5) {
          return Promise.resolve({ data: -1, error: null });
        }
        challenge.failed_attempts += 1;
        challenge.last_attempt_at = new Date().toISOString();
        return Promise.resolve({ data: challenge.failed_attempts, error: null });
      }
      if (fn === 'otp_consume_challenge' && params) {
        const cId = params.p_challenge_id as string;
        const challenge = challengeStore.find(c => c.id === cId);
        if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) < new Date() || challenge.failed_attempts >= 5) {
          return Promise.resolve({ data: null, error: null });
        }
        challenge.consumed_at = new Date().toISOString();
        return Promise.resolve({ data: challenge.id, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
  };
}

function makeNoopChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'maybeSingle' || prop === 'single') return vi.fn().mockResolvedValue(result);
      return vi.fn().mockReturnValue(new Proxy(chain, handler));
    },
  };
  return new Proxy(chain, handler);
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockImplementation(() => buildServiceMock()),
}));

import {
  generatePhoneOtp,
  verifyPhoneOtp,
  generatePhonePassword,
  _hmacHash,
  MAX_FAILED_ATTEMPTS,
} from '@/lib/otp-phone-token';

// ═══════════════════════════════════════════════════════════
// Setup / teardown
// ═══════════════════════════════════════════════════════════

beforeEach(() => {
  resetStore();
  process.env.PHONE_OTP_HMAC_SECRET = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
});

afterEach(() => {
  delete process.env.PHONE_OTP_HMAC_SECRET;
});

// ═══════════════════════════════════════════════════════════
// 1–4. Challenge generation: opacity, entropy, no plaintext
// ═══════════════════════════════════════════════════════════

describe('Challenge generation', () => {
  it('returns 6-digit code and 64-hex-char challengeId', async () => {
    const { code, challengeId } = await generatePhoneOtp('+2348012345678');
    expect(code).toMatch(/^\d{6}$/);
    expect(challengeId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('challengeId does not contain OTP, phone, or colons', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);
    expect(challengeId).not.toContain(code);
    expect(challengeId).not.toContain(phone.replace('+', ''));
    expect(challengeId).not.toContain(':');
  });

  it('stores HMAC hashes, never plaintext', async () => {
    const phone = '+2348012345678';
    await generatePhoneOtp(phone);
    const stored = challengeStore[0];
    expect(stored.phone_hash).not.toBe(phone);
    expect(stored.phone_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.otp_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('each generation produces a unique challengeId', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add((await generatePhoneOtp('+2348012345678')).challengeId);
    }
    expect(ids.size).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════
// 5–14. Verification with stateful challenge repository
// ═══════════════════════════════════════════════════════════

describe('Challenge verification — stateful', () => {
  it('correct OTP with matching phone succeeds', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);
    const result = await verifyPhoneOtp(phone, code, challengeId);
    expect(result).toEqual({ valid: true });
  });

  it('correct OTP with wrong phone fails', async () => {
    const { code, challengeId } = await generatePhoneOtp('+2348012345678');
    const result = await verifyPhoneOtp('+1555999888', code, challengeId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('wrong_phone');
  });

  it('incorrect OTP fails', async () => {
    const { challengeId } = await generatePhoneOtp('+2348012345678');
    const result = await verifyPhoneOtp('+2348012345678', '000000', challengeId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('wrong_otp');
  });

  it('expired challenge fails', async () => {
    const { code, challengeId } = await generatePhoneOtp('+2348012345678');
    // Manually expire the stored challenge
    challengeStore[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const result = await verifyPhoneOtp('+2348012345678', code, challengeId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('consumed challenge fails (replay protection)', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);

    // First verification succeeds
    const first = await verifyPhoneOtp(phone, code, challengeId);
    expect(first.valid).toBe(true);

    // Second attempt fails
    const second = await verifyPhoneOtp(phone, code, challengeId);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('consumed');
  });

  it('challenge at failed-attempt limit fails', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);

    // Manually set failed_attempts to MAX
    challengeStore[0].failed_attempts = MAX_FAILED_ATTEMPTS;

    const result = await verifyPhoneOtp(phone, code, challengeId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('max_attempts');
  });

  it('successful verification sets consumed_at', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);
    expect(challengeStore[0].consumed_at).toBeNull();

    await verifyPhoneOtp(phone, code, challengeId);
    expect(challengeStore[0].consumed_at).not.toBeNull();
  });

  it('sequential invalid attempts increment the counter', async () => {
    const phone = '+2348012345678';
    const { challengeId } = await generatePhoneOtp(phone);

    // 3 wrong OTPs
    await verifyPhoneOtp(phone, '111111', challengeId);
    expect(challengeStore[0].failed_attempts).toBe(1);
    await verifyPhoneOtp(phone, '222222', challengeId);
    expect(challengeStore[0].failed_attempts).toBe(2);
    await verifyPhoneOtp(phone, '333333', challengeId);
    expect(challengeStore[0].failed_attempts).toBe(3);
  });

  it('fifth invalid attempt locks the challenge', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);

    // Exhaust all attempts
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await verifyPhoneOtp(phone, '000000', challengeId);
    }
    expect(challengeStore[0].failed_attempts).toBe(MAX_FAILED_ATTEMPTS);

    // Correct OTP now fails because challenge is locked
    const result = await verifyPhoneOtp(phone, code, challengeId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('max_attempts');
  });

  it('concurrent correct attempts permit at most one success', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);

    // Launch both concurrently
    const [a, b] = await Promise.all([
      verifyPhoneOtp(phone, code, challengeId),
      verifyPhoneOtp(phone, code, challengeId),
    ]);

    const successes = [a, b].filter(r => r.valid);
    const failures = [a, b].filter(r => !r.valid);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe('concurrent');
  });

  it('locked challenge rejects correct OTP', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);

    // Set the challenge to the failed-attempt limit before verification.
    // The initial application-level lock check rejects the challenge.
    // This unit test does not simulate a lock transition between the initial
    // SELECT and the consume RPC. Real PostgreSQL testing independently proves
    // the RPC's consume-time failed_attempts guard.
    challengeStore[0].failed_attempts = MAX_FAILED_ATTEMPTS;

    const result = await verifyPhoneOtp(phone, code, challengeId);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('max_attempts');
  });

  it('expired-before-verify challenge is rejected', async () => {
    const phone = '+2348012345678';
    const { code, challengeId } = await generatePhoneOtp(phone);

    // Set expiry in the past before calling verifyPhoneOtp.
    // This verifies that the initial application-level expiry check rejects
    // an already-expired challenge.
    // Consume-time expiry revalidation is covered independently by real
    // PostgreSQL testing of otp_consume_challenge.
    challengeStore[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const result = await verifyPhoneOtp(phone, code, challengeId);
    expect(result.valid).toBe(false);
    expect(['expired', 'concurrent']).toContain(result.reason);
  });
});

// ═══════════════════════════════════════════════════════════
// 15. Old plaintext token format rejection
// ═══════════════════════════════════════════════════════════

describe('Old plaintext token rejection', () => {
  it('rejects tokens containing colons', async () => {
    const result = await verifyPhoneOtp('+2348012345678', '123456', '+2348012345678:123456:1700000000000:abc123');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_challenge');
  });

  it('rejects empty and missing inputs', async () => {
    expect((await verifyPhoneOtp('', '123456', 'a'.repeat(64))).valid).toBe(false);
    expect((await verifyPhoneOtp('+234', '', 'a'.repeat(64))).valid).toBe(false);
    expect((await verifyPhoneOtp('+234', '123456', '')).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 16. Production secret validation
// ═══════════════════════════════════════════════════════════

describe('Production secret validation', () => {
  it('fails closed when secret is missing in production', async () => {
    delete process.env.PHONE_OTP_HMAC_SECRET;
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await expect(generatePhoneOtp('+2348012345678')).rejects.toThrow('required in production');
    process.env.NODE_ENV = origEnv;
  });

  it('fails closed when secret is too short in production', async () => {
    process.env.PHONE_OTP_HMAC_SECRET = 'abcdef';
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await expect(generatePhoneOtp('+2348012345678')).rejects.toThrow('at least 64 hexadecimal');
    process.env.NODE_ENV = origEnv;
  });

  it('fails closed when secret has non-hex chars in production', async () => {
    process.env.PHONE_OTP_HMAC_SECRET = 'g'.repeat(64);
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await expect(generatePhoneOtp('+2348012345678')).rejects.toThrow('hexadecimal characters');
    process.env.NODE_ENV = origEnv;
  });

  it('uses fallback in non-production when secret is missing', async () => {
    delete process.env.PHONE_OTP_HMAC_SECRET;
    const { code, challengeId } = await generatePhoneOtp('+2348012345678');
    expect(code).toMatch(/^\d{6}$/);
    expect(challengeId).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════
// 17. generatePhonePassword
// ═══════════════════════════════════════════════════════════

describe('generatePhonePassword', () => {
  it('generates unique 64-char hex passwords', () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const pwd = generatePhonePassword('+2348012345678');
      expect(pwd).toMatch(/^[a-f0-9]{64}$/);
      passwords.add(pwd);
    }
    expect(passwords.size).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════
// 18. Send route response contract
// ═══════════════════════════════════════════════════════════

describe('Send route response contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    resetStore();
    process.env.PHONE_OTP_HMAC_SECRET = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
    process.env.META_CLOUD_PHONE_NUMBER_ID = 'env-phone-id';
    process.env.META_CLOUD_ACCESS_TOKEN = 'env-access-token';
  });

  afterEach(() => {
    delete process.env.PHONE_OTP_HMAC_SECRET;
    delete process.env.META_CLOUD_PHONE_NUMBER_ID;
    delete process.env.META_CLOUD_ACCESS_TOKEN;
    vi.unstubAllGlobals();
  });

  it('response contains opaque pin_id, no OTP or decodable payload', async () => {
    vi.doMock('@/lib/brute-force', () => ({
      checkBruteForce: vi.fn().mockReturnValue({ blocked: false }),
    }));
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('test-key'),
    }));
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class { async sendText() {} },
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockImplementation(() => buildServiceMock()),
    }));

    const { POST } = await import('@/app/api/auth/otp/send/route');
    const req = new Request('https://test.waaiio.com/api/auth/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ phone: '+2348012345678' }),
    });
    const res = await POST(req as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe('OTP sent via WhatsApp');
    expect(body.pin_id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.pin_id).not.toContain(':');

    // Verify no 6-digit number appears anywhere in the response except inside pin_id
    const bodyWithoutPinId = JSON.stringify(body).replace(body.pin_id, '');
    expect(bodyWithoutPinId).not.toMatch(/\d{6}/);
  });
});
