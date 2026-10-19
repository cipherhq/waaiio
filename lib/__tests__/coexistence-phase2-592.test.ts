/**
 * #592 Phase 2 — Comprehensive executable tests for coexistence infrastructure.
 *
 * Coverage:
 * 1. Nonce lifecycle: generate (with userId), consume, reject expired/consumed/unknown, atomic CAS
 * 2. Initiation state signing: create/verify, expiry, tampering, two-boundary model
 * 3. FINISH handler: signed initiation state verification, nonce binding, user authority, entitlement gate, fail-closed
 * 4. Eligibility service: all checks gated/false, speculative field labeling, full evaluation pipeline
 * 5. Readiness API enhancement: canConnect always false, eligibility sub-results
 * 6. Migration contract: column/table existence assertions (structural)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockAuthClientFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockAuthClientFrom,
  }),
}));

// Track service client operations
let serviceInserts: Array<{ table: string; data: Record<string, unknown> }> = [];
let serviceUpdates: Array<{ table: string; data: Record<string, unknown> }> = [];
let serviceDeletes: Array<{ table: string }> = [];

// Configurable mock responses for nonce operations
let mockNonceUpdateResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockNonceInsertResult: { error: unknown } = { error: null };
let mockNonceDeleteResult: { data: unknown[] | null; error: unknown } = { data: [], error: null };

function makeServiceChain(data: unknown, opts?: { error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['neq', 'in', 'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'is', 'or', 'not', 'filter']) {
    chain[m] = () => chain;
  }
  chain.eq = () => chain;
  chain.select = (cols?: string) => {
    if (cols) return chain;
    return chain;
  };
  chain.single = () => Promise.resolve({ data, error: opts?.error ?? null });
  chain.maybeSingle = () => Promise.resolve({ data, error: opts?.error ?? null });
  return chain;
}

const mockServiceFrom = vi.fn((table: string) => {
  if (table === 'coexistence_signup_nonces') {
    return {
      insert: (data: Record<string, unknown>) => {
        serviceInserts.push({ table, data });
        return Promise.resolve(mockNonceInsertResult);
      },
      update: (data: Record<string, unknown>) => {
        serviceUpdates.push({ table, data });
        // Return a chain that supports .eq().is().gt().select().maybeSingle()
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.gt = () => chain;
        chain.lt = () => chain;
        chain.select = () => chain;
        chain.maybeSingle = () => Promise.resolve(mockNonceUpdateResult);
        return chain;
      },
      delete: () => {
        serviceDeletes.push({ table });
        const chain: Record<string, unknown> = {};
        chain.lt = () => chain;
        chain.select = () => Promise.resolve(mockNonceDeleteResult);
        return chain;
      },
      select: () => makeServiceChain(null),
    };
  }
  return {
    insert: (data: Record<string, unknown>) => {
      serviceInserts.push({ table, data });
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'test-id' }, error: null }) }) };
    },
    select: () => makeServiceChain(null),
    update: () => makeServiceChain(null),
    delete: () => makeServiceChain(null),
  };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockServiceFrom }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)),
  getRateLimitKey: () => 'test',
}));

vi.mock('@/lib/encryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

type EqCall = { column: string; value: unknown };
let eqCalls: EqCall[] = [];

function dc(data: unknown, opts?: { error?: unknown }) {
  const s: Record<string, unknown> = {};
  for (const m of ['neq', 'in', 'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'select', 'update', 'insert', 'delete', 'is', 'or', 'not', 'filter', 'upsert']) s[m] = () => s;
  s.eq = (col: string, val: unknown) => { eqCalls.push({ column: col, value: val }); return s; };
  s.single = () => Promise.resolve({ data, error: opts?.error ?? null });
  s.maybeSingle = () => Promise.resolve({ data, error: opts?.error ?? null });
  return s;
}

const BUSINESS_ID = '00000000-0000-4000-8000-000000000123';
const USER_ID = '00000000-0000-4000-8000-000000000456';
const CONFIG_ID = '1234567891234567';
const APP_SECRET = 'test-app-secret-for-hmac-verification';

function resetAll() {
  vi.clearAllMocks();
  serviceInserts = [];
  serviceUpdates = [];
  serviceDeletes = [];
  eqCalls = [];
  mockNonceUpdateResult = { data: null, error: null };
  mockNonceInsertResult = { error: null };
  mockNonceDeleteResult = { data: [], error: null };
  mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  mockAuthClientFrom.mockImplementation(() => dc({ id: BUSINESS_ID, country_code: 'NG' }));
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED = 'true';
  process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID = CONFIG_ID;
  process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID = '9999999999999999';
}

function makeReadinessReq(businessId?: string) {
  const url = businessId
    ? `http://localhost/api/whatsapp/business-app-connect/readiness?businessId=${businessId}`
    : 'http://localhost/api/whatsapp/business-app-connect/readiness';
  return new NextRequest(url);
}

function computeHmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Create a valid initiation state for testing */
function makeInitiationState(overrides?: Partial<{
  nonce: string;
  businessId: string;
  userId: string;
  configId: string;
  issuedAt: number;
}>) {
  return {
    nonce: 'test-nonce-abc',
    businessId: BUSINESS_ID,
    userId: USER_ID,
    configId: CONFIG_ID,
    issuedAt: Date.now(),
    ...overrides,
  };
}

/** Sign an initiation state and build a complete payload */
function makeSignedPayload(
  stateOverrides?: Parameters<typeof makeInitiationState>[0],
  browserOverrides?: Partial<{ code: string; waba_id: string; phone_number_id: string }>,
) {
  const state = makeInitiationState(stateOverrides);
  const json = JSON.stringify(state);
  const signedState = Buffer.from(json).toString('base64url');
  const signature = computeHmac(signedState, APP_SECRET);

  return {
    payload: {
      signed_state: signedState,
      state_signature: signature,
      code: 'oauth-code-123',
      waba_id: '12345678901234',
      phone_number_id: '98765432109876',
      ...browserOverrides,
    },
    state,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Nonce service tests
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — Nonce service', () => {
  beforeEach(resetAll);

  it('generateSignupNonce stores nonce with userId in DB via service client', async () => {
    const { generateSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await generateSignupNonce('biz-abc', USER_ID);

    expect(result.nonce).toBeTruthy();
    expect(result.nonce.length).toBeGreaterThan(32); // UUID + random bytes
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Verify service client was used to insert
    expect(serviceInserts).toHaveLength(1);
    expect(serviceInserts[0].table).toBe('coexistence_signup_nonces');
    expect(serviceInserts[0].data).toMatchObject({
      business_id: 'biz-abc',
      initiated_by_user_id: USER_ID,
      nonce: result.nonce,
    });
  });

  it('generateSignupNonce creates unique nonces on consecutive calls', async () => {
    const { generateSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const r1 = await generateSignupNonce('biz-1', USER_ID);
    const r2 = await generateSignupNonce('biz-1', USER_ID);
    expect(r1.nonce).not.toBe(r2.nonce);
  });

  it('generateSignupNonce rejects empty businessId', async () => {
    const { generateSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    await expect(generateSignupNonce('', USER_ID)).rejects.toThrow('businessId is required');
  });

  it('generateSignupNonce rejects empty userId (NOT NULL enforcement)', async () => {
    const { generateSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    await expect(generateSignupNonce('biz-1', '')).rejects.toThrow('userId is required');
  });

  it('generateSignupNonce propagates DB insert errors', async () => {
    mockNonceInsertResult = { error: { message: 'unique_violation' } };
    const { generateSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    await expect(generateSignupNonce('biz-1', USER_ID)).rejects.toThrow('Failed to store signup nonce');
  });

  it('consumeSignupNonce returns valid=true with businessId and userId for unconsumed nonce', async () => {
    mockNonceUpdateResult = { data: { business_id: 'biz-abc', initiated_by_user_id: USER_ID }, error: null };
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await consumeSignupNonce('valid-nonce', 'config:test-config');

    expect(result.valid).toBe(true);
    expect(result.businessId).toBe('biz-abc');
    expect(result.userId).toBe(USER_ID);

    // Verify update was called (CAS: consumed_at IS NULL → now())
    expect(serviceUpdates).toHaveLength(1);
    expect(serviceUpdates[0].table).toBe('coexistence_signup_nonces');
    expect(serviceUpdates[0].data).toHaveProperty('consumed_at');
    // consumed_by_session should contain server-known ref, not browser WABA
    expect(serviceUpdates[0].data).toHaveProperty('consumed_by_session', 'config:test-config');
  });

  it('consumeSignupNonce does NOT store browser WABA in consumed_by_session', async () => {
    mockNonceUpdateResult = { data: { business_id: 'biz-abc', initiated_by_user_id: USER_ID }, error: null };
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    // Pass a server-known identifier, not a browser WABA ID
    await consumeSignupNonce('valid-nonce', 'config:my-config-id');

    expect(serviceUpdates).toHaveLength(1);
    // The consumed_by_session should be the server ref, never a raw WABA ID
    const stored = serviceUpdates[0].data.consumed_by_session as string;
    expect(stored).toBe('config:my-config-id');
    expect(stored).not.toMatch(/^[0-9]{10,20}$/); // Not a raw WABA ID
  });

  it('consumeSignupNonce rejects expired nonce (returns valid=false)', async () => {
    // When the nonce is expired, the UPDATE WHERE clause matches zero rows → null data
    mockNonceUpdateResult = { data: null, error: null };
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await consumeSignupNonce('expired-nonce');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('nonce_invalid_or_expired');
  });

  it('consumeSignupNonce rejects already-consumed nonce (no double-consume)', async () => {
    // Already consumed nonce: consumed_at IS NOT NULL → UPDATE matches zero rows
    mockNonceUpdateResult = { data: null, error: null };
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await consumeSignupNonce('already-consumed-nonce');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('nonce_invalid_or_expired');
  });

  it('consumeSignupNonce rejects unknown nonce', async () => {
    mockNonceUpdateResult = { data: null, error: null };
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await consumeSignupNonce('nonexistent-nonce-xyz');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('nonce_invalid_or_expired');
  });

  it('consumeSignupNonce rejects empty nonce string', async () => {
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await consumeSignupNonce('');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('nonce_required');
    // No DB call should be made
    expect(serviceUpdates).toHaveLength(0);
  });

  it('consumeSignupNonce handles DB update error gracefully', async () => {
    mockNonceUpdateResult = { data: null, error: { message: 'connection_timeout' } };
    const { consumeSignupNonce } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await consumeSignupNonce('some-nonce');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('nonce_consumption_failed');
  });

  it('cleanExpiredNonces deletes expired rows via service client', async () => {
    mockNonceDeleteResult = { data: [{ id: 'a' }, { id: 'b' }], error: null };
    const { cleanExpiredNonces } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await cleanExpiredNonces();

    expect(result.deleted).toBe(2);
    expect(serviceDeletes).toHaveLength(1);
    expect(serviceDeletes[0].table).toBe('coexistence_signup_nonces');
  });

  it('cleanExpiredNonces returns 0 when no expired nonces exist', async () => {
    mockNonceDeleteResult = { data: [], error: null };
    const { cleanExpiredNonces } = await import('@/lib/whatsapp/coexistence-nonces');
    const result = await cleanExpiredNonces();
    expect(result.deleted).toBe(0);
  });

  it('cleanExpiredNonces propagates DB errors', async () => {
    mockNonceDeleteResult = { data: null, error: { message: 'disk_full' } };
    const { cleanExpiredNonces } = await import('@/lib/whatsapp/coexistence-nonces');
    await expect(cleanExpiredNonces()).rejects.toThrow('Failed to clean expired nonces');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Initiation state signing tests (R2-C1)
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — Initiation state signing (R2-C1)', () => {
  beforeEach(resetAll);

  it('createSignedInitiationState + verifyInitiationState round-trip succeeds', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    const state = makeInitiationState();
    const { signedState, signature } = createSignedInitiationState(state, APP_SECRET);

    const result = verifyInitiationState(signedState, signature, APP_SECRET);
    expect(result.valid).toBe(true);
    expect(result.state).toMatchObject({
      nonce: state.nonce,
      businessId: state.businessId,
      userId: state.userId,
      configId: state.configId,
    });
  });

  it('tampered signed state fails verification', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    const state = makeInitiationState();
    const { signature } = createSignedInitiationState(state, APP_SECRET);

    // Tamper: use a different state but the original signature
    const tamperedState = makeInitiationState({ nonce: 'tampered-nonce' });
    const tamperedEncoded = Buffer.from(JSON.stringify(tamperedState)).toString('base64url');

    const result = verifyInitiationState(tamperedEncoded, signature, APP_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('signature_mismatch');
  });

  it('state with modified businessId after signing fails verification', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    const state = makeInitiationState();
    const { signature } = createSignedInitiationState(state, APP_SECRET);

    const tampered = makeInitiationState({ businessId: 'attacker-business-id' });
    const tamperedEncoded = Buffer.from(JSON.stringify(tampered)).toString('base64url');

    const result = verifyInitiationState(tamperedEncoded, signature, APP_SECRET);
    expect(result.valid).toBe(false);
  });

  it('state with modified userId after signing fails verification', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    const state = makeInitiationState();
    const { signature } = createSignedInitiationState(state, APP_SECRET);

    const tampered = makeInitiationState({ userId: 'attacker-user-id' });
    const tamperedEncoded = Buffer.from(JSON.stringify(tampered)).toString('base64url');

    const result = verifyInitiationState(tamperedEncoded, signature, APP_SECRET);
    expect(result.valid).toBe(false);
  });

  it('initiation state with old issuedAt (>15 min) is rejected as expired', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    // issuedAt 20 minutes ago
    const state = makeInitiationState({ issuedAt: Date.now() - 20 * 60 * 1000 });
    const { signedState, signature } = createSignedInitiationState(state, APP_SECRET);

    const result = verifyInitiationState(signedState, signature, APP_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('state_expired');
  });

  it('initiation state with future issuedAt is rejected', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    // issuedAt 5 minutes in the future
    const state = makeInitiationState({ issuedAt: Date.now() + 5 * 60 * 1000 });
    const { signedState, signature } = createSignedInitiationState(state, APP_SECRET);

    const result = verifyInitiationState(signedState, signature, APP_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('state_expired');
  });

  it('verifyInitiationState rejects empty parameters', async () => {
    const { verifyInitiationState } = await import('@/lib/whatsapp/coexistence-finish-handler');
    expect(verifyInitiationState('', 'sig', 'secret').valid).toBe(false);
    expect(verifyInitiationState('state', '', 'secret').valid).toBe(false);
    expect(verifyInitiationState('state', 'sig', '').valid).toBe(false);
  });

  it('verifyInitiationState rejects malformed base64', async () => {
    const { verifyInitiationState } = await import('@/lib/whatsapp/coexistence-finish-handler');
    // Valid HMAC of garbage — but decode will fail
    const garbage = 'not-valid-base64!!!';
    const sig = computeHmac(garbage, APP_SECRET);
    const result = verifyInitiationState(garbage, sig, APP_SECRET);
    // It should either fail HMAC or fail JSON parse — either way not valid
    expect(result.valid).toBe(false);
  });

  it('wrong secret produces different signature → verification fails', async () => {
    const { createSignedInitiationState, verifyInitiationState } = await import(
      '@/lib/whatsapp/coexistence-finish-handler'
    );
    const state = makeInitiationState();
    const { signedState } = createSignedInitiationState(state, APP_SECRET);
    const wrongSig = computeHmac(signedState, 'wrong-secret');

    const result = verifyInitiationState(signedState, wrongSig, APP_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('signature_mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. FINISH handler tests — two-boundary model
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — FINISH handler (two-boundary model)', () => {
  beforeEach(resetAll);

  describe('processCoexistenceFinish', () => {
    it('rejects when META_APP_SECRET is not configured', async () => {
      delete process.env.META_APP_SECRET;
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('server_configuration_error');
    });

    it('rejects tampered initiation state (invalid signature)', async () => {
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      // Forge the signature
      payload.state_signature = 'a'.repeat(64);
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });

    it('rejects expired initiation state', async () => {
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload({ issuedAt: Date.now() - 20 * 60 * 1000 });
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('state_expired');
    });

    it('rejects invalid waba_id format', async () => {
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload(undefined, { waba_id: 'not-numeric' });
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid_waba_id_format');
    });

    it('rejects invalid phone_number_id format', async () => {
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload(undefined, { phone_number_id: 'abc' });
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid_phone_number_id_format');
    });

    it('rejects missing code', async () => {
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload(undefined, { code: '' });
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('missing_or_empty_code');
    });

    it('rejects unknown nonce after valid initiation state', async () => {
      mockNonceUpdateResult = { data: null, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('nonce_invalid_or_expired');
    });

    it('rejects consumed nonce (replay attack)', async () => {
      mockNonceUpdateResult = { data: null, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('nonce_invalid_or_expired');
    });

    it('rejects cross-user nonce consumption (user_nonce_mismatch)', async () => {
      // Nonce was issued for a DIFFERENT user than the one in initiation state
      const differentUserId = '00000000-0000-4000-8000-000000000999';
      mockNonceUpdateResult = {
        data: { business_id: BUSINESS_ID, initiated_by_user_id: differentUserId },
        error: null,
      };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload(); // state has USER_ID
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('user_nonce_mismatch');
    });

    it('valid payload with gated entitlement still fails (expected)', async () => {
      mockNonceUpdateResult = { data: { business_id: BUSINESS_ID, initiated_by_user_id: USER_ID }, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('partner_entitlement_failed');
      expect(result.reason).toContain('partner_entitlement_check_not_authorized');
    });

    it('handler does NOT verify HMAC of code/waba_id/phone_number_id (untrusted browser data not signed)', async () => {
      // The HMAC only covers signed_state, NOT code/waba_id/phone_number_id.
      // Changing browser values with valid initiation state should not trigger signature failure.
      mockNonceUpdateResult = { data: { business_id: BUSINESS_ID, initiated_by_user_id: USER_ID }, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');

      // Create payload with one set of browser values
      const { payload } = makeSignedPayload();
      // Swap the code AFTER signing — this should NOT break signature verification
      // because the signature only covers signed_state, not browser data
      payload.code = 'completely-different-code';

      const result = await processCoexistenceFinish(payload);

      // Should NOT fail with signature error — browser data is not signed
      expect(result.reason).not.toBe('signature_mismatch');
      expect(result.reason).not.toBe('invalid_initiation_state');
      // It should reach entitlement check and fail there (since all gates pass except entitlement)
      expect(result.reason).toContain('partner_entitlement_failed');
    });

    it('FINISH handler NEVER makes Meta API calls', async () => {
      mockNonceUpdateResult = { data: { business_id: BUSINESS_ID, initiated_by_user_id: USER_ID }, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      await processCoexistenceFinish(payload);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('FINISH handler NEVER creates active whatsapp_channels', async () => {
      mockNonceUpdateResult = { data: { business_id: BUSINESS_ID, initiated_by_user_id: USER_ID }, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      await processCoexistenceFinish(payload);

      const channelInserts = serviceInserts.filter(i => i.table === 'whatsapp_channels');
      expect(channelInserts).toHaveLength(0);
    });

    it('valid FINISH event cannot authorize anything — browser-relayed values remain untrusted', async () => {
      mockNonceUpdateResult = { data: { business_id: BUSINESS_ID, initiated_by_user_id: USER_ID }, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const { payload } = makeSignedPayload();
      const result = await processCoexistenceFinish(payload);

      expect(result.accepted).toBe(false);
      const allInserts = serviceInserts.filter(i =>
        i.table === 'whatsapp_channels' || i.table === 'whatsapp_channel_candidates'
      );
      expect(allInserts).toHaveLength(0);
    });

    it('nonce consumed from signed state, not from browser data', async () => {
      mockNonceUpdateResult = { data: { business_id: BUSINESS_ID, initiated_by_user_id: USER_ID }, error: null };
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const testNonce = 'specific-nonce-from-state';
      const { payload } = makeSignedPayload({ nonce: testNonce });
      await processCoexistenceFinish(payload);

      // The nonce used for consumption should be from signed state
      // We can verify via the service update mock — the nonce arg is what was passed
      // to consumeSignupNonce, which then calls the update chain with .eq('nonce', nonce)
      expect(serviceUpdates).toHaveLength(1);
    });
  });

  describe('fail-closed even with entitled partner (C2-2)', () => {
    it('handler returns candidate_creation_not_implemented even when entitlement passes', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const handlerPath = path.resolve(__dirname, '../whatsapp/coexistence-finish-handler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8');

      // The handler must contain the fail-closed return
      expect(source).toContain("reason: 'candidate_creation_not_implemented'");

      // The handler must NOT contain accepted: true anywhere
      expect(source).not.toContain('accepted: true');

      // The type must be a single variant (always false)
      expect(source).toContain('type CoexistenceFinishResult = { accepted: false; reason: string }');
    });
  });

  describe('two-boundary model structural checks', () => {
    it('handler exports CoexistenceInitiationState type', async () => {
      const handler = await import('@/lib/whatsapp/coexistence-finish-handler');
      // Type exports are checked by verifying the signing functions exist and work
      expect(typeof handler.createSignedInitiationState).toBe('function');
      expect(typeof handler.verifyInitiationState).toBe('function');
    });

    it('CoexistenceSessionPayload has signed_state and state_signature fields', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const handlerPath = path.resolve(__dirname, '../whatsapp/coexistence-finish-handler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8');

      expect(source).toContain('signed_state: string');
      expect(source).toContain('state_signature: string');
      // Verify old session_nonce field is gone
      expect(source).not.toContain('session_nonce:');
    });

    it('processCoexistenceFinish takes single payload arg (no separate signature param)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const handlerPath = path.resolve(__dirname, '../whatsapp/coexistence-finish-handler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8');

      // New signature: single payload argument
      expect(source).toContain('processCoexistenceFinish(\n  payload: CoexistenceSessionPayload,\n): Promise<CoexistenceFinishResult>');
    });

    it('verifySessionEnvelopeSignature is removed (replaced by verifyInitiationState)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const handlerPath = path.resolve(__dirname, '../whatsapp/coexistence-finish-handler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8');

      expect(source).not.toContain('verifySessionEnvelopeSignature');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Eligibility service tests
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — Eligibility verification service', () => {
  it('checkPartnerEntitlement always returns gated/false', async () => {
    const { checkPartnerEntitlement } = await import('@/lib/whatsapp/coexistence-verification');
    const result = await checkPartnerEntitlement('any-token');
    expect(result.entitled).toBe(false);
    expect(result.reason).toBe('partner_entitlement_check_not_authorized');
  });

  it('checkPhoneEligibility always returns gated/false', async () => {
    const { checkPhoneEligibility } = await import('@/lib/whatsapp/coexistence-verification');
    const result = await checkPhoneEligibility('+2349001234567', 'any-token');
    expect(result.hasBusinessApp).toBe(false);
    expect(result.reason).toBe('phone_eligibility_check_not_authorized');
  });

  it('checkCountryEligibility always returns gated/false even for placeholder markets', async () => {
    const { checkCountryEligibility, getPlaceholderMarkets } = await import('@/lib/whatsapp/coexistence-verification');

    // Even India (a placeholder market) should return false
    const markets = getPlaceholderMarkets();
    expect(markets.has('IN')).toBe(true);

    const result = await checkCountryEligibility('IN');
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('country_eligibility_requires_meta_confirmation');
  });

  it('checkCountryEligibility returns gated/false for non-placeholder countries', async () => {
    const { checkCountryEligibility } = await import('@/lib/whatsapp/coexistence-verification');
    const result = await checkCountryEligibility('NG');
    expect(result.supported).toBe(false);
  });

  it('evaluateFullEligibility returns eligible: false with all reasons', async () => {
    const { evaluateFullEligibility } = await import('@/lib/whatsapp/coexistence-verification');
    const result = await evaluateFullEligibility({
      metaAccessToken: 'any-token',
      phoneNumber: '+2349001234567',
      countryCode: 'NG',
    });

    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toContain('partner');
      expect(result.reason).toContain('phone');
      expect(result.reason).toContain('country');

      // Details include individual check results
      expect(result.details.partnerEntitled).toBe(false);
      expect(result.details.phoneEligible).toBe(false);
      expect(result.details.countrySupported).toBe(false);

      // Reasons are preserved
      expect(result.details.partnerReason).toBe('partner_entitlement_check_not_authorized');
      expect(result.details.phoneReason).toBe('phone_eligibility_check_not_authorized');
      expect(result.details.countryReason).toBe('country_eligibility_requires_meta_confirmation');
    }
  });

  it('evaluateFullEligibility never makes Meta API calls (fetch not invoked)', async () => {
    vi.clearAllMocks();
    const { evaluateFullEligibility } = await import('@/lib/whatsapp/coexistence-verification');
    await evaluateFullEligibility({
      metaAccessToken: 'any-token',
      phoneNumber: '+2349001234567',
      countryCode: 'IN',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('placeholder markets list contains expected countries', async () => {
    const { getPlaceholderMarkets } = await import('@/lib/whatsapp/coexistence-verification');
    const markets = getPlaceholderMarkets();
    expect(markets.has('IN')).toBe(true);
    expect(markets.has('BR')).toBe(true);
    expect(markets.has('ID')).toBe(true);
    // Not an exhaustive list — these are placeholders only
    expect(markets.size).toBeLessThanOrEqual(10);
  });

  it('Meta Graph API field references are labeled as SPECULATIVE (C2-5)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../whatsapp/coexistence-verification.ts');
    const source = fs.readFileSync(filePath, 'utf-8');

    // Verify SPECULATIVE labels exist near the Meta Graph API field references
    expect(source).toContain('SPECULATIVE Meta Graph API fields');
    expect(source).toContain('NOT confirmed against official Meta API documentation');
    expect(source).toContain('Do NOT ungate');

    // Count: should appear at least twice (partner entitlement + phone eligibility)
    const speculativeCount = (source.match(/SPECULATIVE Meta Graph API fields/g) || []).length;
    expect(speculativeCount).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Readiness API enhancement tests
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — Readiness API with eligibility sub-results', () => {
  beforeEach(resetAll);

  it('canConnect is ALWAYS false and eligibility sub-results are present', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.canConnect).toBe(false);

    // Phase 2: eligibility sub-results
    expect(body.eligibility).toBeDefined();
    expect(body.eligibility.partnerEntitled).toBe(false);
    expect(body.eligibility.phoneEligible).toBe(false);
    expect(body.eligibility.countrySupported).toBe(false);
    expect(body.eligibility.allGatesMet).toBe(false);
  });

  it('canConnect false when config disabled — eligibility still present', async () => {
    process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED = 'false';
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();

    expect(body.canConnect).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.eligibility).toBeDefined();
    expect(body.eligibility.allGatesMet).toBe(false);
  });

  it('auth required — 401 without user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.status).toBe(401);
  });

  it('ownership verified — 403 for non-owner', async () => {
    mockAuthClientFrom.mockImplementation(() => dc(null));
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.status).toBe(403);
  });

  it('DB error returns 503', async () => {
    mockAuthClientFrom.mockImplementation(() => dc(null, { error: { message: 'timeout' } }));
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.status).toBe(503);
  });

  it('response includes existing gate fields alongside new eligibility', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();

    // Existing Phase 1 fields
    expect(body.configured).toBe(true);
    expect(body.country).toBe('NG');
    expect(body.countryEligibility).toBe('requires_meta_confirmation');
    expect(body.appEligibility).toBe('requires_meta_confirmation');
    expect(body.warning).toContain('standard transfer');

    // New Phase 2 fields
    expect(body.eligibility).toBeDefined();
  });

  it('response sets Cache-Control: no-store', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('readiness API never makes Meta API calls', async () => {
    vi.clearAllMocks();
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    await GET(makeReadinessReq(BUSINESS_ID));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Migration contract tests (structural assertions)
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — Migration 438 contract', () => {
  it('migration file exists', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration does NOT add duplicate connection_type column (uses canonical connection_method)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    const sqlWithoutComments = sql
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(sqlWithoutComments).not.toContain('connection_type');
    expect(sql).toContain('connection_method');
  });

  it('migration adds coexist_meta_business_app_id column', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('coexist_meta_business_app_id');
    expect(sql).toContain('VARCHAR(64)');
  });

  it('migration adds coexist_verified_at column', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('coexist_verified_at');
    expect(sql).toContain('TIMESTAMPTZ');
  });

  it('migration creates coexistence_signup_nonces table with NOT NULL initiated_by_user_id and FK', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('coexistence_signup_nonces');
    expect(sql).toContain('business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE');
    // R2-C2: NOT NULL with FK constraint
    expect(sql).toContain('initiated_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(sql).toContain('nonce VARCHAR(128) NOT NULL UNIQUE');
    expect(sql).toContain('expires_at TIMESTAMPTZ NOT NULL');
    expect(sql).toContain('consumed_at TIMESTAMPTZ');
    expect(sql).toContain('consumed_by_session');
    expect(sql).toContain('nonce_not_empty');
  });

  it('migration enforces service_role-only access on nonces table', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON coexistence_signup_nonces FROM PUBLIC');
    expect(sql).toContain('REVOKE ALL ON coexistence_signup_nonces FROM anon');
    expect(sql).toContain('REVOKE ALL ON coexistence_signup_nonces FROM authenticated');
    expect(sql).toContain('GRANT ALL ON coexistence_signup_nonces TO service_role');
  });

  it('migration creates indexes for nonce lookup', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('idx_coexist_nonces_business');
    expect(sql).toContain('idx_coexist_nonces_lookup');
    expect(sql).toContain('WHERE consumed_at IS NULL');
  });

  it('migration has NO SECURITY DEFINER functions', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    const sqlWithoutComments = sql
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(sqlWithoutComments.toUpperCase()).not.toContain('SECURITY DEFINER');
  });

  it('migration uses IF NOT EXISTS for idempotent re-runs', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('IF NOT EXISTS');
  });

  it('handler references canonical connection_method, not duplicate connection_type (C2-4)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const handlerPath = path.resolve(__dirname, '../whatsapp/coexistence-finish-handler.ts');
    const source = fs.readFileSync(handlerPath, 'utf-8');

    expect(source).toContain("connection_method='coexist'");
    expect(source).not.toContain("connection_type='coexist'");
  });
});
