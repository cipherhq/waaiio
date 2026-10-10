/**
 * #592 Phase 2 — Comprehensive executable tests for coexistence infrastructure.
 *
 * Coverage:
 * 1. Nonce lifecycle: generate (with userId), consume, reject expired/consumed/unknown, atomic CAS
 * 2. FINISH handler: Waaiio session envelope verification, nonce binding, entitlement gate, format validation, fail-closed
 * 3. Eligibility service: all checks gated/false, speculative field labeling, full evaluation pipeline
 * 4. Readiness API enhancement: canConnect always false, eligibility sub-results
 * 5. Migration contract: column/table existence assertions (structural)
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
  process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID = '1234567891234567';
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

  it('generateSignupNonce rejects empty userId', async () => {
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
    const result = await consumeSignupNonce('valid-nonce', 'session-123');

    expect(result.valid).toBe(true);
    expect(result.businessId).toBe('biz-abc');
    expect(result.userId).toBe(USER_ID);

    // Verify update was called (CAS: consumed_at IS NULL → now())
    expect(serviceUpdates).toHaveLength(1);
    expect(serviceUpdates[0].table).toBe('coexistence_signup_nonces');
    expect(serviceUpdates[0].data).toHaveProperty('consumed_at');
    expect(serviceUpdates[0].data).toHaveProperty('consumed_by_session', 'session-123');
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
// 2. FINISH handler tests — Waaiio session envelope (NOT Meta attestation)
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Phase 2 — FINISH handler (Waaiio session envelope)', () => {
  beforeEach(resetAll);

  describe('Waaiio session envelope signature verification', () => {
    it('valid HMAC-SHA256 Waaiio session envelope passes verification', async () => {
      const { verifySessionEnvelopeSignature } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const payload = JSON.stringify({ test: 'data' });
      const signature = computeHmac(payload, APP_SECRET);

      expect(verifySessionEnvelopeSignature(payload, signature, APP_SECRET)).toBe(true);
    });

    it('forged signature is rejected', async () => {
      const { verifySessionEnvelopeSignature } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const payload = JSON.stringify({ test: 'data' });
      const forgedSignature = computeHmac('tampered-payload', APP_SECRET);

      expect(verifySessionEnvelopeSignature(payload, forgedSignature, APP_SECRET)).toBe(false);
    });

    it('signature with sha256= prefix is accepted', async () => {
      const { verifySessionEnvelopeSignature } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const payload = JSON.stringify({ test: 'data' });
      const rawSig = computeHmac(payload, APP_SECRET);

      expect(verifySessionEnvelopeSignature(payload, `sha256=${rawSig}`, APP_SECRET)).toBe(true);
    });

    it('empty payload/signature/secret returns false (not throws)', async () => {
      const { verifySessionEnvelopeSignature } = await import('@/lib/whatsapp/coexistence-finish-handler');
      expect(verifySessionEnvelopeSignature('', 'sig', 'secret')).toBe(false);
      expect(verifySessionEnvelopeSignature('payload', '', 'secret')).toBe(false);
      expect(verifySessionEnvelopeSignature('payload', 'sig', '')).toBe(false);
    });

    it('malformed hex signature returns false (not throws)', async () => {
      const { verifySessionEnvelopeSignature } = await import('@/lib/whatsapp/coexistence-finish-handler');
      expect(verifySessionEnvelopeSignature('payload', 'not-hex!@#$', APP_SECRET)).toBe(false);
    });

    it('wrong secret produces wrong signature', async () => {
      const { verifySessionEnvelopeSignature } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const payload = JSON.stringify({ test: 'data' });
      const wrongSig = computeHmac(payload, 'wrong-secret');

      expect(verifySessionEnvelopeSignature(payload, wrongSig, APP_SECRET)).toBe(false);
    });
  });

  describe('processCoexistenceFinish', () => {
    const validPayload = {
      code: 'oauth-code-123',
      waba_id: '12345678901234',
      phone_number_id: '98765432109876',
      session_nonce: 'valid-nonce-abc',
    };

    function signPayload(payload: Record<string, string>): string {
      return computeHmac(JSON.stringify(payload), APP_SECRET);
    }

    it('rejects tampered session envelope (invalid signature)', async () => {
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(validPayload, 'forged-signature-hex');

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid_signature');
    });

    it('rejects when META_APP_SECRET is not configured', async () => {
      delete process.env.META_APP_SECRET;
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(validPayload, 'any-sig');

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('server_configuration_error');
    });

    it('rejects invalid waba_id format', async () => {
      const badPayload = { ...validPayload, waba_id: 'not-numeric' };
      const sig = signPayload(badPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(badPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid_waba_id_format');
    });

    it('rejects invalid phone_number_id format', async () => {
      const badPayload = { ...validPayload, phone_number_id: 'abc' };
      const sig = signPayload(badPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(badPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid_phone_number_id_format');
    });

    it('rejects missing code', async () => {
      const badPayload = { ...validPayload, code: '' };
      const sig = signPayload(badPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(badPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('missing_or_empty_code');
    });

    it('rejects missing session_nonce', async () => {
      const badPayload = { ...validPayload, session_nonce: '' };
      const sig = signPayload(badPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(badPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('missing_session_nonce');
    });

    it('rejects unknown nonce after valid envelope signature', async () => {
      // Nonce not found → consumeSignupNonce returns valid=false
      mockNonceUpdateResult = { data: null, error: null };
      const sig = signPayload(validPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(validPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('nonce_invalid_or_expired');
    });

    it('rejects consumed nonce (replay attack)', async () => {
      // Already consumed → UPDATE matches zero rows → null
      mockNonceUpdateResult = { data: null, error: null };
      const sig = signPayload(validPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(validPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('nonce_invalid_or_expired');
    });

    it('valid payload with gated entitlement still fails (expected)', async () => {
      // Nonce is valid — but partner entitlement is gated → fails
      mockNonceUpdateResult = { data: { business_id: 'biz-abc', initiated_by_user_id: USER_ID }, error: null };
      const sig = signPayload(validPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(validPayload, sig);

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('partner_entitlement_failed');
      expect(result.reason).toContain('partner_entitlement_check_not_authorized');
    });

    it('FINISH handler NEVER makes Meta API calls', async () => {
      mockNonceUpdateResult = { data: { business_id: 'biz-abc', initiated_by_user_id: USER_ID }, error: null };
      const sig = signPayload(validPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      await processCoexistenceFinish(validPayload, sig);

      // No fetch calls to Meta Graph API
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('FINISH handler NEVER creates active whatsapp_channels', async () => {
      mockNonceUpdateResult = { data: { business_id: 'biz-abc', initiated_by_user_id: USER_ID }, error: null };
      const sig = signPayload(validPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      await processCoexistenceFinish(validPayload, sig);

      // No inserts to whatsapp_channels
      const channelInserts = serviceInserts.filter(i => i.table === 'whatsapp_channels');
      expect(channelInserts).toHaveLength(0);
    });

    it('valid FINISH event cannot authorize anything — browser-relayed values remain untrusted', async () => {
      // Even with valid envelope signature and valid nonce, the handler
      // does NOT claim Meta attestation and does NOT create candidates.
      // This proves the handler is a session integrity check, not a provider verification.
      mockNonceUpdateResult = { data: { business_id: 'biz-abc', initiated_by_user_id: USER_ID }, error: null };
      const sig = signPayload(validPayload);
      const { processCoexistenceFinish } = await import('@/lib/whatsapp/coexistence-finish-handler');
      const result = await processCoexistenceFinish(validPayload, sig);

      // Handler always rejects — it cannot authorize browser-relayed values
      expect(result.accepted).toBe(false);
      // No channel candidates created
      const allInserts = serviceInserts.filter(i =>
        i.table === 'whatsapp_channels' || i.table === 'whatsapp_channel_candidates'
      );
      expect(allInserts).toHaveLength(0);
    });
  });

  describe('fail-closed even with entitled partner (C2-2)', () => {
    it('handler returns candidate_creation_not_implemented even when entitlement passes', async () => {
      // The handler's CoexistenceFinishResult type is { accepted: false; reason: string }
      // which means it CANNOT return accepted:true. We verify this structurally:
      // after the entitlement check passes, the code reaches the fail-closed return.
      //
      // We verify by reading the handler source to confirm the unreachable success
      // path was replaced with the fail-closed return.
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
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Eligibility service tests
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
// 4. Readiness API enhancement tests
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
// 5. Migration contract tests (structural assertions)
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

    // Must NOT contain connection_type as a column addition
    // (comments referencing connection_method are fine)
    const sqlWithoutComments = sql
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(sqlWithoutComments).not.toContain('connection_type');
    // Should reference connection_method in comments explaining the relationship
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

  it('migration creates coexistence_signup_nonces table with initiated_by_user_id', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(__dirname, '../../supabase/migrations/438_business_app_coexistence.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('coexistence_signup_nonces');
    expect(sql).toContain('business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE');
    expect(sql).toContain('initiated_by_user_id UUID');
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

    // Strip SQL comments (-- ...) before checking for SECURITY DEFINER
    // because the comment "No SECURITY DEFINER functions" is documentation, not code.
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

    // Handler should reference connection_method (the canonical column) when
    // discussing candidate creation, not connection_type
    expect(source).toContain("connection_method='coexist'");
    // Should NOT reference connection_type='coexist' as a column to use
    expect(source).not.toContain("connection_type='coexist'");
  });
});
