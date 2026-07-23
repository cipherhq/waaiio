/**
 * Flutterwave Split Recurring Charges Tests
 *
 * Mirrors the Paystack split recurring tests (PR #23).
 * Verifies that direct_split businesses get gateway-level splitting
 * on Flutterwave tokenized charges, with fail-closed behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const recurringCode = readFileSync('lib/payments/flutterwave-recurring.ts', 'utf-8');
const cronCode = readFileSync('app/api/cron/retry-failed-charges/route.ts', 'utf-8');
const chargeSavedCode = readFileSync('lib/payments/charge-saved.ts', 'utf-8');

describe('flutterwave-recurring.ts split support', () => {
  it('chargeToken accepts optional splitParams with Flutterwave subaccounts format', () => {
    expect(recurringCode).toContain(
      'splitParams?: { subaccounts: Array<{ id: string; transaction_charge_type: string; transaction_charge: number }> }',
    );
  });

  it('gates split params behind FLUTTERWAVE_RECURRING_SPLIT_VERIFIED env var', () => {
    expect(recurringCode).toContain('FLUTTERWAVE_RECURRING_SPLIT_VERIFIED');
    expect(recurringCode).toContain("=== 'true'");
  });

  it('only includes verified split params in the charge body', () => {
    expect(recurringCode).toContain('...(verifiedSplit || {})');
  });

  it('preserves existing behavior when splitParams is undefined', () => {
    expect(recurringCode).toContain('verifiedSplit || {}');
  });

  it('documents the verification requirement', () => {
    expect(recurringCode).toContain('sandbox verification');
    expect(recurringCode).toContain('FLUTTERWAVE_RECURRING_SPLIT_VERIFIED');
  });

  it('does not log warnings at module load time', () => {
    // Warning should be in the cron (on first skip), not at module import
    expect(recurringCode).not.toContain('console.warn(');
  });
});

describe('retry-failed-charges cron Flutterwave support', () => {
  it('imports chargeFlutterwaveToken', () => {
    expect(cronCode).toContain("import { chargeToken as chargeFlutterwaveToken }");
  });

  it('imports resolveGatewaySplit', () => {
    expect(cronCode).toContain("import { resolvePaystackSplit, resolveGatewaySplit }");
  });

  it('handles flutterwave gateway in the retry loop', () => {
    expect(cronCode).toContain("sub.gateway === 'flutterwave'");
  });

  it('resolves split for Flutterwave before charging', () => {
    const flwSection = cronCode.substring(
      cronCode.indexOf("sub.gateway === 'flutterwave'"),
      cronCode.indexOf('chargeFlutterwaveToken('),
    );
    expect(flwSection).toContain("resolveGatewaySplit(supabase, sub.business_id");
    expect(flwSection).toContain("'flutterwave'");
  });

  it('uses Flutterwave subaccounts format (not Paystack format)', () => {
    expect(cronCode).toContain("transaction_charge_type: 'flat'");
    expect(cronCode).toContain('transactionChargeKobo / 100'); // FLW uses main currency units
  });

  it('skips Flutterwave charge when direct_split config is missing (fail-closed)', () => {
    const flwSection = cronCode.substring(
      cronCode.indexOf("sub.gateway === 'flutterwave'"),
      cronCode.indexOf('chargeFlutterwaveToken('),
    );
    expect(flwSection).toContain("flwSplitResult.mode === 'split_required_but_missing'");
    expect(flwSection).toContain('skipped++');
    expect(flwSection).toContain('continue');
  });

  it('skips Flutterwave charge when split is needed but verification gate is off', () => {
    const flwSection = cronCode.substring(
      cronCode.indexOf("sub.gateway === 'flutterwave'"),
      cronCode.indexOf('chargeFlutterwaveToken('),
    );
    expect(flwSection).toContain('FLUTTERWAVE_RECURRING_SPLIT_VERIFIED');
    expect(flwSection).toContain('not yet verified');
    expect(flwSection).toContain('skipped++');
  });

  it('cancels Flutterwave subscriptions after 3 failures', () => {
    expect(cronCode).toContain("sub.gateway === 'flutterwave' && sub.gateway_subscription_code");
    expect(cronCode).toContain("import('@/lib/payments/flutterwave-recurring')");
  });
});

describe('resolveGatewaySplit function', () => {
  it('exists and accepts a gateway parameter', () => {
    expect(chargeSavedCode).toContain('export async function resolveGatewaySplit');
    expect(chargeSavedCode).toContain("gateway: 'paystack' | 'flutterwave'");
  });

  it('resolvePaystackSplit delegates to resolveGatewaySplit', () => {
    expect(chargeSavedCode).toContain("return resolveGatewaySplit(supabase, businessId, amount, 'paystack')");
  });

  it('queries payout_accounts filtered by gateway parameter', () => {
    const fnSection = chargeSavedCode.substring(
      chargeSavedCode.indexOf('export async function resolveGatewaySplit'),
      chargeSavedCode.indexOf('export async function resolvePaystackSplit'),
    );
    expect(fnSection).toContain(".eq('gateway', gateway)");
  });
});

describe('resolveGatewaySplit behavior', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns split config for direct_split business with Flutterwave subaccount', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.5, feeFlat: 0, feeTotal: 125 }),
    }));

    const { resolveGatewaySplit } = await import('@/lib/payments/charge-saved');

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
              data: { subaccount_code: 'FLW_SUB_123' },
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await resolveGatewaySplit(mockSupabase as never, 'biz-flw', 5000, 'flutterwave');

    expect(result.mode).toBe('split');
    if (result.mode === 'split') {
      expect(result.subaccount).toBe('FLW_SUB_123');
      expect(result.transactionChargeKobo).toBe(12500);
    }
  });

  it('returns split_required_but_missing for Flutterwave direct_split with no subaccount', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn(),
    }));

    const { resolveGatewaySplit } = await import('@/lib/payments/charge-saved');

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

    const result = await resolveGatewaySplit(mockSupabase as never, 'biz-flw-missing', 5000, 'flutterwave');
    expect(result.mode).toBe('split_required_but_missing');
    if (result.mode === 'split_required_but_missing') {
      expect(result.reason).toContain('flutterwave');
    }
  });
});

describe('provider separation — no cross-contamination', () => {
  it('Flutterwave uses subaccounts array format, not Paystack subaccount field', () => {
    const flwGateway = readFileSync('lib/payments/flutterwave.ts', 'utf-8');
    expect(flwGateway).toContain('subaccounts: [{');
    expect(flwGateway).toContain('transaction_charge_type');
    const psGateway = readFileSync('lib/payments/paystack.ts', 'utf-8');
    expect(psGateway).toContain('subaccount:');
    expect(psGateway).not.toContain('subaccounts:');
  });

  it('Flutterwave chargeToken uses main currency units for split (not kobo)', () => {
    expect(cronCode).toContain('transactionChargeKobo / 100');
  });

  it('Paystack cron uses kobo directly (no division)', () => {
    // Paystack splitParams uses transactionChargeKobo without dividing
    const psSection = cronCode.substring(
      cronCode.indexOf("sub.gateway === 'paystack'"),
      cronCode.indexOf("sub.gateway === 'flutterwave'"),
    );
    expect(psSection).toContain('transaction_charge: splitResult.transactionChargeKobo');
    expect(psSection).not.toContain('/ 100');
  });

  it('Flutterwave cron cannot accidentally use Paystack subaccount field', () => {
    const flwSection = cronCode.substring(
      cronCode.indexOf("sub.gateway === 'flutterwave'"),
      cronCode.indexOf('chargeFlutterwaveToken('),
    );
    // Must use subaccounts array, not flat subaccount field
    expect(flwSection).toContain('subaccounts:');
    expect(flwSection).not.toMatch(/\bsubaccount:/);
  });

  it('Paystack cron cannot accidentally use Flutterwave subaccounts array', () => {
    const psSection = cronCode.substring(
      cronCode.indexOf("sub.gateway === 'paystack'"),
      cronCode.indexOf("sub.gateway === 'flutterwave'"),
    );
    expect(psSection).not.toContain('subaccounts:');
  });
});

describe('fee bounds validation', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects fee that exceeds transaction amount', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 100, feeFlat: 0, feeTotal: 5000 }),
    }));

    const { resolveGatewaySplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({
            data: { payout_mode: 'direct_split', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null }, error: null,
          }) };
        }
        if (table === 'payout_accounts') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({
            data: { subaccount_code: 'FLW_SUB' }, error: null,
          }) };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    // Fee (5000) equals amount (5000) — should be rejected
    const result = await resolveGatewaySplit(mockSupabase as never, 'biz-fee-exceed', 5000, 'flutterwave');
    expect(result.mode).toBe('split_required_but_missing');
    if (result.mode === 'split_required_but_missing') {
      expect(result.reason).toContain('exceeds');
    }
  });

  it('rejects negative fee', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: -5, feeFlat: 0, feeTotal: -250 }),
    }));

    const { resolveGatewaySplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({
            data: { payout_mode: 'direct_split', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null }, error: null,
          }) };
        }
        if (table === 'payout_accounts') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({
            data: { subaccount_code: 'FLW_SUB' }, error: null,
          }) };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await resolveGatewaySplit(mockSupabase as never, 'biz-neg-fee', 5000, 'flutterwave');
    expect(result.mode).toBe('split_required_but_missing');
    if (result.mode === 'split_required_but_missing') {
      expect(result.reason).toContain('Invalid');
    }
  });

  it('rejects NaN fee', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: NaN, feeFlat: 0, feeTotal: NaN }),
    }));

    const { resolveGatewaySplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({
            data: { payout_mode: 'direct_split', subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null }, error: null,
          }) };
        }
        if (table === 'payout_accounts') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({
            data: { subaccount_code: 'FLW_SUB' }, error: null,
          }) };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await resolveGatewaySplit(mockSupabase as never, 'biz-nan', 5000, 'flutterwave');
    expect(result.mode).toBe('split_required_but_missing');
  });

  it('accepts zero fee (trial businesses)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 0, feeFlat: 0, feeTotal: 0 }),
    }));

    const { resolveGatewaySplit } = await import('@/lib/payments/charge-saved');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({
            data: { payout_mode: 'direct_split', subscription_tier: 'free', trial_ends_at: '2099-01-01', custom_fee_percentage: null, custom_fee_flat: null }, error: null,
          }) };
        }
        if (table === 'payout_accounts') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({
            data: { subaccount_code: 'FLW_SUB_TRIAL' }, error: null,
          }) };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await resolveGatewaySplit(mockSupabase as never, 'biz-trial', 5000, 'flutterwave');
    expect(result.mode).toBe('split');
    if (result.mode === 'split') {
      expect(result.transactionChargeKobo).toBe(0);
    }
  });
});

describe('one-time checkout regression', () => {
  it('flutterwave.ts one-time split payload uses subaccounts array with flat charge type', () => {
    const flwCode = readFileSync('lib/payments/flutterwave.ts', 'utf-8');
    // Normal platform split
    expect(flwCode).toContain("transaction_charge_type: 'flat'");
    expect(flwCode).toContain("transaction_charge: opts.platformFeeAmount || 0");
    // BYO reversed split
    expect(flwCode).toContain("transaction_charge: businessKeeps");
  });
});

describe('webhook consistency', () => {
  it('Flutterwave webhook verifies gross amount, not post-split settlement', () => {
    const webhookCode = readFileSync('app/api/webhooks/flutterwave/route.ts', 'utf-8');
    // Verifies data.amount against payment.amount (gross, not net)
    expect(webhookCode).toContain('webhookAmount - payment.amount');
    // Does not reference subaccount or split in amount verification
    expect(webhookCode).not.toContain('settlement');
    expect(webhookCode).not.toContain('net_amount');
  });

  it('webhook does not alter payment_source classification', () => {
    const webhookCode = readFileSync('app/api/webhooks/flutterwave/route.ts', 'utf-8');
    expect(webhookCode).not.toContain('payment_source');
  });
});
