/**
 * Paystack Split Recurring Charges Tests
 *
 * Verifies that direct_split businesses get gateway-level splitting
 * on recurring/saved-card charges, matching one-time payment behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ── Source code structural tests ──

const chargeSavedCode = readFileSync('lib/payments/charge-saved.ts', 'utf-8');
const recurringCode = readFileSync('lib/payments/paystack-recurring.ts', 'utf-8');
const cronCode = readFileSync('app/api/cron/retry-failed-charges/route.ts', 'utf-8');

describe('charge-saved.ts split support', () => {
  it('exports resolvePaystackSplit function', () => {
    expect(chargeSavedCode).toContain('export async function resolvePaystackSplit');
  });

  it('resolves split from payout_accounts server-side', () => {
    expect(chargeSavedCode).toContain("from('payout_accounts')");
    expect(chargeSavedCode).toContain("eq('gateway', gateway)");
    expect(chargeSavedCode).toContain("eq('is_active', true)");
    expect(chargeSavedCode).toContain("'subaccount_code'");
  });

  it('checks payout_mode is direct_split before resolving', () => {
    expect(chargeSavedCode).toContain("payout_mode !== 'direct_split'");
  });

  it('calculates platform fee using getPlatformFees', () => {
    expect(chargeSavedCode).toContain('getPlatformFees');
    expect(chargeSavedCode).toContain('subscription_tier');
    expect(chargeSavedCode).toContain('custom_fee_percentage');
  });

  it('returns no_split for platform_managed businesses', () => {
    expect(chargeSavedCode).toContain("!== 'direct_split'");
    expect(chargeSavedCode).toContain("mode: 'no_split'");
  });

  it('returns split_required_but_missing when payout account is missing', () => {
    expect(chargeSavedCode).toContain("mode: 'split_required_but_missing'");
    expect(chargeSavedCode).toContain('payout account with subaccount code');
  });

  it('converts fee to kobo for transaction_charge', () => {
    expect(chargeSavedCode).toContain('feeTotal * 100');
  });

  it('passes split params to charge_authorization call', () => {
    expect(chargeSavedCode).toContain('...splitParams');
    expect(chargeSavedCode).toContain("subaccount: splitResult.subaccount");
    expect(chargeSavedCode).toContain("transaction_charge: splitResult.transactionChargeKobo");
  });

  it('does not pass split params for BYO charges', () => {
    expect(chargeSavedCode).toContain('if (!opts.byoSecretKey)');
  });

  it('blocks charge when direct_split config is missing (fail-closed)', () => {
    expect(chargeSavedCode).toContain("splitResult.mode === 'split_required_but_missing'");
    expect(chargeSavedCode).toContain('blocking charge');
    expect(chargeSavedCode).toContain('success: false');
    expect(chargeSavedCode).toContain('charge blocked for retry');
  });

  it('exports SplitResult type with three modes', () => {
    expect(chargeSavedCode).toContain("mode: 'no_split'");
    expect(chargeSavedCode).toContain("mode: 'split'");
    expect(chargeSavedCode).toContain("mode: 'split_required_but_missing'");
  });

  it('does not accept subaccount from client input', () => {
    // The opts interface for chargeSavedCard has no subaccount/split fields
    const fnSection = chargeSavedCode.substring(
      chargeSavedCode.indexOf('export async function chargeSavedCard'),
      chargeSavedCode.indexOf('): Promise<{ success'),
    );
    expect(fnSection).not.toContain('subaccount');
    expect(fnSection).not.toContain('split');
    expect(fnSection).not.toContain('transaction_charge');
  });
});

describe('paystack-recurring.ts split support', () => {
  it('chargeAuthorization accepts optional splitParams', () => {
    expect(recurringCode).toContain(
      'splitParams?: { subaccount: string; transaction_charge: number }',
    );
  });

  it('spreads splitParams into the charge body', () => {
    expect(recurringCode).toContain('...(splitParams || {})');
  });

  it('preserves existing behavior when splitParams is undefined', () => {
    // When undefined, ...(undefined || {}) = ...{} = no extra params
    expect(recurringCode).toContain('splitParams || {}');
  });
});

describe('retry-failed-charges cron split support', () => {
  it('imports resolvePaystackSplit', () => {
    expect(cronCode).toContain("resolvePaystackSplit");
  });

  it('resolves split before calling chargeAuthorization', () => {
    const chargeSection = cronCode.substring(
      cronCode.indexOf('sub.gateway === \'paystack\' && sub.authorization_code'),
      cronCode.indexOf('result.success'),
    );
    // resolvePaystackSplit must appear before chargeAuthorization
    const splitIdx = chargeSection.indexOf('resolvePaystackSplit');
    const chargeIdx = chargeSection.indexOf('chargeAuthorization');
    expect(splitIdx).toBeGreaterThan(-1);
    expect(chargeIdx).toBeGreaterThan(splitIdx);
  });

  it('passes splitParams to chargeAuthorization', () => {
    expect(cronCode).toContain('splitParams,');
  });

  it('skips charge when direct_split config is missing (fail-closed)', () => {
    expect(cronCode).toContain("splitResult.mode === 'split_required_but_missing'");
    expect(cronCode).toContain('skipping charge');
    expect(cronCode).toContain('skipped++');
    expect(cronCode).toContain('continue');
  });

  it('uses business_id from subscription record', () => {
    expect(cronCode).toContain('sub.business_id');
    expect(cronCode).toContain('resolvePaystackSplit(supabase, sub.business_id');
  });
});

// ── Behavioral tests using mocks ──

describe('resolvePaystackSplit behavior', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns split config for direct_split business with active Paystack account', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.5, feeFlat: 0, feeTotal: 250 }),
    }));

    const { resolvePaystackSplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { payout_mode: 'direct_split', subscription_tier: 'growth', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null },
              error: null,
            }),
          };
        }
        if (table === 'payout_accounts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { subaccount_code: 'ACCT_test123' },
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await resolvePaystackSplit(mockSupabase as never, 'biz-1', 10000);

    expect(result.mode).toBe('split');
    if (result.mode === 'split') {
      expect(result.subaccount).toBe('ACCT_test123');
      expect(result.transactionChargeKobo).toBe(25000); // 250 * 100
    }
  });

  it('returns no_split for platform_managed business', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));

    const { resolvePaystackSplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { payout_mode: 'platform_managed', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null },
          error: null,
        }),
      })),
    };

    const result = await resolvePaystackSplit(mockSupabase as never, 'biz-2', 5000);
    expect(result.mode).toBe('no_split');
  });

  it('returns split_required_but_missing when no active Paystack payout account', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));

    const { resolvePaystackSplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { payout_mode: 'direct_split', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null },
              error: null,
            }),
          };
        }
        if (table === 'payout_accounts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await resolvePaystackSplit(mockSupabase as never, 'biz-3', 5000);
    expect(result.mode).toBe('split_required_but_missing');
    if (result.mode === 'split_required_but_missing') {
      expect(result.reason).toContain('payout account with subaccount code');
      expect(result.businessId).toBe('biz-3');
    }
  });

  it('returns split_required_but_missing when business lookup fails', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));

    const { resolvePaystackSplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB connection error' } }),
      })),
    };

    const result = await resolvePaystackSplit(mockSupabase as never, 'biz-err', 5000);
    expect(result.mode).toBe('split_required_but_missing');
    if (result.mode === 'split_required_but_missing') {
      expect(result.reason).toContain('Business lookup failed');
      expect(result.businessId).toBe('biz-err');
    }
  });

  it('returns split_required_but_missing when business not found', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));

    const { resolvePaystackSplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    };

    const result = await resolvePaystackSplit(mockSupabase as never, 'nonexistent', 5000);
    expect(result.mode).toBe('split_required_but_missing');
    if (result.mode === 'split_required_but_missing') {
      expect(result.reason).toBe('Business not found');
    }
  });
});

describe('fail-closed: no payment record and no Paystack charge when direct_split config missing', () => {
  it('split resolution happens before payment insert and before fetch', () => {
    // resolvePaystackSplit must appear before .from('payments').insert AND before fetch
    const splitIdx = chargeSavedCode.indexOf('resolvePaystackSplit(supabase, opts.businessId');
    const insertIdx = chargeSavedCode.indexOf("from('payments').insert", splitIdx);
    const fetchIdx = chargeSavedCode.indexOf("fetch('https://api.paystack.co/transaction/charge_authorization'");
    expect(splitIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(splitIdx);
    expect(fetchIdx).toBeGreaterThan(insertIdx);
  });

  it('returns failure before creating payment record when split is required but missing', () => {
    const splitCheckIdx = chargeSavedCode.indexOf("splitResult.mode === 'split_required_but_missing'");
    const insertIdx = chargeSavedCode.indexOf("from('payments').insert");
    expect(splitCheckIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(splitCheckIdx);
    // The return { success: false } is between the check and the insert
    const betweenSection = chargeSavedCode.substring(splitCheckIdx, insertIdx);
    expect(betweenSection).toContain('return {');
    expect(betweenSection).toContain('success: false');
  });

  it('cron skips the charge entirely with continue when split is required but missing', () => {
    const splitCheckIdx = cronCode.indexOf("splitResult.mode === 'split_required_but_missing'");
    const chargeIdx = cronCode.indexOf('chargeAuthorization(');
    expect(splitCheckIdx).toBeGreaterThan(-1);
    expect(chargeIdx).toBeGreaterThan(splitCheckIdx);
    const betweenSection = cronCode.substring(splitCheckIdx, chargeIdx);
    expect(betweenSection).toContain('continue');
  });

  it('saved card failure message is suitable for retry', () => {
    expect(chargeSavedCode).toContain('charge blocked for retry');
  });

  it('logs businessId but not credentials or bank details', () => {
    const logSection = chargeSavedCode.substring(
      chargeSavedCode.indexOf('Direct split config missing, blocking charge'),
      chargeSavedCode.indexOf('Direct split config missing, blocking charge') + 200,
    );
    expect(logSection).toContain('businessId');
    expect(logSection).toContain('reason');
    expect(logSection).not.toContain('secret');
    expect(logSection).not.toContain('account_number');
    expect(logSection).not.toContain('authorization_code');
  });
});

describe('fail-closed behavioral: no payment row created on split failure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Set the secret key so tests reach split resolution (not the "gateway not configured" guard)
    process.env.PAYSTACK_SECRET_KEY = 'test_mock_key_for_unit_tests';
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  it('does not insert a payment row when direct_split config is missing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

    const { chargeSavedCard } = await import('@/lib/payments/charge-saved');

    const insertFn = vi.fn();
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { payout_mode: 'direct_split', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null },
              error: null,
            }),
          };
        }
        if (table === 'payout_accounts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === 'payments') {
          return { insert: insertFn };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await chargeSavedCard(mockSupabase as never, {
      savedMethod: { id: 'sm-1', gateway: 'paystack', authorization_code: 'AUTH_test', customer_code: null, stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '4242', card_brand: 'visa' },
      amount: 5000,
      currency: 'NGN',
      email: 'test@test.com',
      reference: 'ref-1',
      businessId: 'biz-split-missing',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('charge blocked for retry');
    // The payments insert must NOT have been called
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('does not insert a payment row when split resolution throws a DB error', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

    const { chargeSavedCard } = await import('@/lib/payments/charge-saved');

    const insertFn = vi.fn();
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'connection timeout' },
            }),
          };
        }
        if (table === 'payments') {
          return { insert: insertFn };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await chargeSavedCard(mockSupabase as never, {
      savedMethod: { id: 'sm-2', gateway: 'paystack', authorization_code: 'AUTH_test2', customer_code: null, stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '1234', card_brand: 'mastercard' },
      amount: 3000,
      currency: 'NGN',
      email: 'test2@test.com',
      reference: 'ref-2',
      businessId: 'biz-db-err',
    });

    expect(result.success).toBe(false);
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('creates a payment row for valid direct_split with active subaccount', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.5, feeFlat: 0, feeTotal: 125 }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

    const { chargeSavedCard } = await import('@/lib/payments/charge-saved');

    const insertFn = vi.fn().mockResolvedValue({ data: null });
    const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null }) });
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { payout_mode: 'direct_split', subscription_tier: 'growth', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null },
              error: null,
            }),
          };
        }
        if (table === 'payout_accounts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { subaccount_code: 'ACCT_valid' },
              error: null,
            }),
          };
        }
        if (table === 'payments') {
          return { insert: insertFn };
        }
        if (table === 'saved_payment_methods') {
          return { update: updateFn };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    // Mock fetch for the Paystack charge_authorization call
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: true, data: { status: 'success', reference: 'ref-3' } }),
    }));

    const result = await chargeSavedCard(mockSupabase as never, {
      savedMethod: { id: 'sm-3', gateway: 'paystack', authorization_code: 'AUTH_valid', customer_code: null, stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '5678', card_brand: 'visa' },
      amount: 5000,
      currency: 'NGN',
      email: 'valid@test.com',
      reference: 'ref-3',
      businessId: 'biz-valid-split',
    });

    expect(result.success).toBe(true);
    expect(insertFn).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('creates a payment row for platform_managed business (no split needed)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

    const { chargeSavedCard } = await import('@/lib/payments/charge-saved');

    const insertFn = vi.fn().mockResolvedValue({ data: null });
    const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null }) });
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { payout_mode: 'platform_managed', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null },
              error: null,
            }),
          };
        }
        if (table === 'payments') {
          return { insert: insertFn };
        }
        if (table === 'saved_payment_methods') {
          return { update: updateFn };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: true, data: { status: 'success', reference: 'ref-4' } }),
    }));

    const result = await chargeSavedCard(mockSupabase as never, {
      savedMethod: { id: 'sm-4', gateway: 'paystack', authorization_code: 'AUTH_pm', customer_code: null, stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '9999', card_brand: 'visa' },
      amount: 2000,
      currency: 'NGN',
      email: 'pm@test.com',
      reference: 'ref-4',
      businessId: 'biz-platform',
    });

    expect(result.success).toBe(true);
    expect(insertFn).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});

describe('payment_source preservation', () => {
  it('charge-saved.ts does not modify payment_source on bookings', () => {
    expect(chargeSavedCode).not.toContain("payment_source");
  });

  it('recurring charge webhook still uses process_recurring_charge RPC with payment_source=subscription', () => {
    // The RPC was updated in migration 244 to include payment_source='subscription'
    const migrationCode = readFileSync('supabase/migrations/244_payment_source_classification.sql', 'utf-8');
    expect(migrationCode).toContain("'subscription'");
    expect(migrationCode).toContain('payment_source');
  });
});
