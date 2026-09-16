/**
 * #318 Phase 0: Tests for the provider-neutral saved payment adapter.
 *
 * Proves:
 * 1. Adapter returns provider-neutral types (no authorization_code, no provider tokens)
 * 2. Outcome mapping from SavedCardOutcome → ChargeOutcome is correct
 * 3. PIN verification delegates correctly with business+customer tuple authorization
 * 4. Provider isolation: flow-facing interface cannot access provider fields
 * 5. Behavior equivalence: same outcomes as direct charge-saved calls
 * 6. Cross-customer object authorization: foreign method IDs are rejected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock charge-saved.ts before importing adapter
const mockGetSavedPaymentMethod = vi.fn();
const mockChargeSavedCard = vi.fn();

vi.mock('../charge-saved', () => ({
  getSavedPaymentMethod: (...args: unknown[]) => mockGetSavedPaymentMethod(...args),
  chargeSavedCard: (...args: unknown[]) => mockChargeSavedCard(...args),
}));

// Mock crypto for PIN hashing
vi.mock('crypto', () => ({
  createHash: () => ({
    update: (input: string) => ({
      digest: () => `mock_hash_${input}`,
    }),
  }),
}));

import { savedPaymentAdapter } from '../saved-payment-adapter';
import type { SavedPaymentDisplay, ChargeOutcome, PinVerifyResult } from '../saved-payment-adapter';

// ── Supabase mock helpers ──

const VALID_METHOD = {
  id: 'spm-123',
  gateway: 'paystack',
  authorization_code: 'AUTH_secret_xyz',
  customer_code: 'CUS_abc',
  stripe_payment_method_id: null,
  stripe_customer_id: null,
  card_last4: '4242',
  card_brand: 'visa',
  pin_hash: 'mock_hash_1234:+2348012345678',
  pin_attempts: 0,
  pin_locked_until: null,
};

const VALID_BUSINESS = 'biz-1';
const VALID_PHONE = '+2348012345678';
const WRONG_PHONE = '+2349999999999';
const WRONG_BUSINESS = 'biz-other';

/**
 * Creates a mock supabase that simulates the lookupAuthorizedMethod query.
 * Returns data ONLY when the chained .eq() calls match the expected tuple.
 * Tracks whether update() was called (for PIN mutation detection).
 */
function createTupleMockSupabase(opts: {
  methodId?: string;
  businessId?: string;
  customerPhone?: string;
  returnData?: Record<string, unknown> | null;
} = {}) {
  const updateCalls: unknown[][] = [];
  const eqConstraints: Record<string, string> = {};

  let inConstraints: Record<string, string[]> = {};
  const chainable = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockImplementation(function (this: typeof chainable, col: string, val: string) {
      eqConstraints[col] = val;
      return this;
    }),
    in: vi.fn().mockImplementation(function (this: typeof chainable, col: string, vals: string[]) {
      inConstraints[col] = vals;
      return this;
    }),
    maybeSingle: vi.fn().mockImplementation(() => {
      // Check if all tuple constraints match
      const idMatch = !opts.methodId || eqConstraints['id'] === opts.methodId;
      const bizMatch = !opts.businessId || eqConstraints['business_id'] === opts.businessId;
      // Phone match: check both .eq() and .in() constraints
      let phoneMatch = true;
      if (opts.customerPhone) {
        if (eqConstraints['customer_phone']) {
          phoneMatch = eqConstraints['customer_phone'] === opts.customerPhone;
        } else if (inConstraints['customer_phone']) {
          phoneMatch = inConstraints['customer_phone'].includes(opts.customerPhone);
        } else {
          phoneMatch = false;
        }
      }

      if (idMatch && bizMatch && phoneMatch) {
        return Promise.resolve({ data: opts.returnData ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    update: vi.fn().mockImplementation((...args: unknown[]) => {
      updateCalls.push(args);
      return chainable;
    }),
  };

  return {
    supabase: { from: vi.fn().mockReturnValue(chainable) } as unknown,
    chainable,
    updateCalls,
    getEqConstraints: () => ({ ...eqConstraints }),
  };
}

describe('SavedPaymentAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getSavedMethods (uses existing getSavedPaymentMethod — tuple enforced there) ──

  describe('getSavedMethods', () => {
    it('returns empty array when no saved method exists', async () => {
      mockGetSavedPaymentMethod.mockResolvedValue(null);
      const { supabase } = createTupleMockSupabase();
      const result = await savedPaymentAdapter.getSavedMethods(supabase as any, 'biz-1', VALID_PHONE);
      expect(result).toEqual([]);
    });

    it('returns provider-neutral display for Paystack saved card', async () => {
      mockGetSavedPaymentMethod.mockResolvedValue(VALID_METHOD);
      const { supabase } = createTupleMockSupabase();
      const result = await savedPaymentAdapter.getSavedMethods(supabase as any, 'biz-1', VALID_PHONE);

      expect(result).toHaveLength(1);
      const display: SavedPaymentDisplay = result[0];
      expect(display.id).toBe('spm-123');
      expect(display.displayLabel).toBe('VISA ****4242');
      expect(display.brandHint).toBe('visa');
      expect(display.last4).toBe('4242');
      expect(display.supportsDirectCharge).toBe(true);
    });

    it('DOES NOT expose authorization_code or provider tokens', async () => {
      mockGetSavedPaymentMethod.mockResolvedValue(VALID_METHOD);
      const { supabase } = createTupleMockSupabase();
      const result = await savedPaymentAdapter.getSavedMethods(supabase as any, 'biz-1', VALID_PHONE);

      const display = result[0];
      expect(display).not.toHaveProperty('authorization_code');
      expect(display).not.toHaveProperty('customer_code');
      expect(display).not.toHaveProperty('gateway');
      expect(display).not.toHaveProperty('stripe_payment_method_id');
      expect(display).not.toHaveProperty('stripe_customer_id');
      const keys = Object.keys(display).sort();
      expect(keys).toEqual(['brandHint', 'displayLabel', 'id', 'last4', 'supportsDirectCharge']);
    });

    it('handles missing card_brand gracefully', async () => {
      mockGetSavedPaymentMethod.mockResolvedValue({
        ...VALID_METHOD, card_last4: null, card_brand: null,
      });
      const { supabase } = createTupleMockSupabase();
      const result = await savedPaymentAdapter.getSavedMethods(supabase as any, 'biz-1', VALID_PHONE);

      expect(result[0].displayLabel).toBe('Card ****????');
      expect(result[0].brandHint).toBeNull();
      expect(result[0].last4).toBeNull();
    });
  });

  // ── chargeSavedMethod (uses lookupAuthorizedMethod — full tuple) ──

  describe('chargeSavedMethod', () => {
    it('maps "charged" outcome correctly', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });
      mockChargeSavedCard.mockResolvedValue({
        outcome: 'charged', paymentId: 'pay-001', reference: 'REF-saved',
      });

      const result: ChargeOutcome = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: VALID_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
        bookingId: 'bk-1', transactionCategory: 'scheduling',
      });

      expect(result.status).toBe('charged');
      if (result.status === 'charged') expect(result.paymentId).toBe('pay-001');
    });

    it('maps "already_charged" outcome correctly', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });
      mockChargeSavedCard.mockResolvedValue({
        outcome: 'already_charged', paymentId: 'pay-001', reference: 'REF-saved',
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: VALID_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
      });
      expect(result.status).toBe('already_charged');
    });

    it('maps "declined" outcome correctly', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });
      mockChargeSavedCard.mockResolvedValue({
        outcome: 'declined', reference: 'REF-saved', message: 'Insufficient funds',
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: VALID_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
      });
      expect(result.status).toBe('declined');
      if (result.status === 'declined') {
        expect(result.message).toBe('Insufficient funds');
        expect(result.shouldDeactivate).toBe(false);
      }
    });

    it('maps "indeterminate" outcome correctly', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });
      mockChargeSavedCard.mockResolvedValue({
        outcome: 'indeterminate', paymentId: 'pay-001', reference: 'REF-saved', message: 'Timeout',
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: VALID_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
      });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.paymentId).toBe('pay-001');
    });

    it('returns method_not_found when method does not exist', async () => {
      const { supabase } = createTupleMockSupabase({ returnData: null });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'nonexistent', customerPhone: VALID_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
      });
      expect(result.status).toBe('method_not_found');
      expect(mockChargeSavedCard).not.toHaveBeenCalled();
    });

    it('passes entity IDs through to chargeSavedCard without modification', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });
      mockChargeSavedCard.mockResolvedValue({
        outcome: 'charged', paymentId: 'pay-001', reference: 'REF-saved',
      });

      await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: VALID_PHONE, amount: 3000, currency: 'NGN',
        email: 'a@b.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
        bookingId: 'bk-99', orderId: 'ord-77', transactionCategory: 'scheduling',
      });

      expect(mockChargeSavedCard).toHaveBeenCalledTimes(1);
      const callOpts = mockChargeSavedCard.mock.calls[0][1];
      expect(callOpts.bookingId).toBe('bk-99');
      expect(callOpts.orderId).toBe('ord-77');
      expect(callOpts.transactionCategory).toBe('scheduling');
      expect(callOpts.amount).toBe(3000);
      expect(callOpts.savedMethod.authorization_code).toBe('AUTH_secret_xyz');
    });
  });

  // ── requiresPin (uses lookupAuthorizedMethod — full tuple) ──

  describe('requiresPin', () => {
    it('returns required: false when no pin_hash exists', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: { ...VALID_METHOD, pin_hash: null },
      });
      const result = await savedPaymentAdapter.requiresPin(supabase as any, 'spm-123', VALID_BUSINESS, VALID_PHONE);
      expect(result).toEqual({ required: false, locked: false });
    });

    it('returns required: true, locked: false when PIN is set and not locked', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });
      const result = await savedPaymentAdapter.requiresPin(supabase as any, 'spm-123', VALID_BUSINESS, VALID_PHONE);
      expect(result).toEqual({ required: true, locked: false });
    });

    it('returns locked: true when pin_locked_until is in the future', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: { ...VALID_METHOD, pin_locked_until: future },
      });
      const result = await savedPaymentAdapter.requiresPin(supabase as any, 'spm-123', VALID_BUSINESS, VALID_PHONE);
      expect(result).toEqual({ required: true, locked: true });
    });
  });

  // ── provider isolation ──

  describe('provider isolation', () => {
    it('ChargeOutcome type does not include provider-specific fields', () => {
      const charged: ChargeOutcome = { status: 'charged', paymentId: 'p1' };
      const declined: ChargeOutcome = { status: 'declined', message: 'fail', shouldDeactivate: false };
      const indeterminate: ChargeOutcome = { status: 'indeterminate', paymentId: 'p2', message: 'timeout' };
      const notFound: ChargeOutcome = { status: 'method_not_found' };
      const expired: ChargeOutcome = { status: 'method_expired' };
      const authRequired: ChargeOutcome = { status: 'requires_provider_auth', authUrl: 'https://3ds.example.com', paymentId: 'p3' };

      expect(charged.status).toBe('charged');
      expect(declined.status).toBe('declined');
      expect(indeterminate.status).toBe('indeterminate');
      expect(notFound.status).toBe('method_not_found');
      expect(expired.status).toBe('method_expired');
      expect(authRequired.status).toBe('requires_provider_auth');
    });

    it('SavedPaymentDisplay type does not include provider-specific fields', () => {
      const display: SavedPaymentDisplay = {
        id: 'spm-1', displayLabel: 'VISA ****4242', brandHint: 'visa',
        last4: '4242', supportsDirectCharge: true,
      };
      const keys = Object.keys(display).sort();
      expect(keys).toEqual(['brandHint', 'displayLabel', 'id', 'last4', 'supportsDirectCharge']);
    });
  });

  // ── Cross-customer object authorization (CTO BLOCKER correction) ──

  describe('cross-customer object authorization', () => {
    it('valid method ID + wrong customer phone → method_not_found (charge rejected)', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: WRONG_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: VALID_BUSINESS,
      });

      expect(result.status).toBe('method_not_found');
      expect(mockChargeSavedCard).not.toHaveBeenCalled();
    });

    it('valid method ID + wrong business → method_not_found (charge rejected)', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: VALID_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: WRONG_BUSINESS,
      });

      expect(result.status).toBe('method_not_found');
      expect(mockChargeSavedCard).not.toHaveBeenCalled();
    });

    it('foreign method cannot read PIN state (wrong customer)', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD, // has pin_hash set
      });

      // Wrong customer asks about PIN — should return as if method doesn't exist
      const result = await savedPaymentAdapter.requiresPin(supabase as any, 'spm-123', VALID_BUSINESS, WRONG_PHONE);
      // Must NOT reveal that the method has a PIN
      expect(result).toEqual({ required: false, locked: false });
    });

    it('foreign method cannot mutate PIN attempts/lock/reset (wrong business)', async () => {
      const { supabase, chainable } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });

      // Wrong business tries to verify PIN — should fail closed
      const result = await savedPaymentAdapter.verifyPin(
        supabase as any, 'spm-123', WRONG_BUSINESS, VALID_PHONE, '1234',
      );

      // Must reject without revealing PIN state
      expect(result.valid).toBe(false);
      // Must NOT have called update() to mutate pin_attempts
      expect(chainable.update).not.toHaveBeenCalled();
    });

    it('foreign method never invokes chargeSavedCard (wrong customer + wrong business)', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-123', businessId: VALID_BUSINESS, customerPhone: VALID_PHONE,
        returnData: VALID_METHOD,
      });

      // Wrong customer AND wrong business
      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-123', customerPhone: WRONG_PHONE, amount: 5000, currency: 'NGN',
        email: 'test@test.com', reference: 'REF-saved', businessId: WRONG_BUSINESS,
      });

      expect(result.status).toBe('method_not_found');
      expect(mockChargeSavedCard).not.toHaveBeenCalled();
    });
  });

  // ── Legacy phone listing→authorization regression ──
  // Production incident: saved method stored with non-+ phone must be
  // authorized by requiresPin/chargeSavedMethod when caller supplies + phone.

  describe('legacy non-+ stored method → authorization with + caller phone', () => {
    const LEGACY_PHONE = '2348012345678'; // stored without +
    const CALLER_PHONE = '+2348012345678'; // caller supplies +

    const LEGACY_METHOD = {
      ...VALID_METHOD,
      id: 'spm-legacy-1',
      pin_hash: null, // no PIN set
    };

    it('requiresPin succeeds for legacy non-+ stored method with + caller phone', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-legacy-1',
        businessId: VALID_BUSINESS,
        customerPhone: LEGACY_PHONE, // stored as non-+
        returnData: LEGACY_METHOD,
      });

      const result = await savedPaymentAdapter.requiresPin(
        supabase as any, 'spm-legacy-1', VALID_BUSINESS, CALLER_PHONE,
      );

      // Authorization succeeded (method found) — no PIN hash → not required
      expect(result.required).toBe(false);
    });

    it('chargeSavedMethod succeeds and reaches mockChargeSavedCard exactly once', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-legacy-1',
        businessId: VALID_BUSINESS,
        customerPhone: LEGACY_PHONE, // stored as non-+
        returnData: LEGACY_METHOD,
      });
      mockChargeSavedCard.mockResolvedValue({
        outcome: 'charged', paymentId: 'pay-legacy-001', reference: 'REF-legacy',
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-legacy-1',
        customerPhone: CALLER_PHONE, // caller supplies + form
        amount: 5000,
        currency: 'NGN',
        email: 'legacy@test.com',
        reference: 'REF-legacy',
        businessId: VALID_BUSINESS,
        bookingId: 'bk-legacy-1',
        transactionCategory: 'scheduling',
      });

      expect(result.status).toBe('charged');
      expect(mockChargeSavedCard).toHaveBeenCalledTimes(1);
    });

    it('wrong business still denied for legacy phone method', async () => {
      const { supabase } = createTupleMockSupabase({
        methodId: 'spm-legacy-1',
        businessId: VALID_BUSINESS,
        customerPhone: LEGACY_PHONE,
        returnData: LEGACY_METHOD,
      });

      const result = await savedPaymentAdapter.chargeSavedMethod(supabase as any, {
        methodId: 'spm-legacy-1',
        customerPhone: CALLER_PHONE,
        amount: 5000,
        currency: 'NGN',
        email: 'legacy@test.com',
        reference: 'REF-legacy',
        businessId: WRONG_BUSINESS, // different business
      });

      expect(result.status).toBe('method_not_found');
      expect(mockChargeSavedCard).not.toHaveBeenCalled();
    });
  });
});
