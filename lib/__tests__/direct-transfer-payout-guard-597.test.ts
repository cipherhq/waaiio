/**
 * #597 PR-B R3: Platform-held payout eligibility guard.
 *
 * Tests the PRODUCTION isPlatformHeld() and computePlatformHeldTotals()
 * functions from lib/payments/payout-custody.ts — the canonical filter
 * used by auto-payout, manual generator, and approval balance check.
 *
 * Layer 1: Executable tests importing real production functions.
 * Layer 2: Source-contract tests verifying all three consumers use isPlatformHeld.
 * Layer 3: Approval route error handling verification.
 *
 * CTO 601-A: Strict === false, not negation (null = unknown = ineligible).
 * CTO 601-B: Approval rejects on query errors.
 * CTO 601-C: Tests execute production code, not copies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isPlatformHeld, computePlatformHeldTotals, type PlatformFeeRow } from '@/lib/payments/payout-custody';

const AUTO_PAYOUT_PATH = join(process.cwd(), 'app/api/cron/auto-payout/route.ts');
const MANUAL_GENERATOR_PATH = join(process.cwd(), 'app/api/admin/payouts/generate/route.ts');
const APPROVAL_PATH = join(process.cwd(), 'app/api/admin/payouts/[id]/approve/route.ts');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
// Layer 1: Executable tests of PRODUCTION isPlatformHeld function
// ═══════════════════════════════════════════════════════════════════

describe('#597 R3: isPlatformHeld (production function)', () => {
  it('returns true for is_direct_transfer === false (confirmed platform-held)', () => {
    expect(isPlatformHeld({ is_direct_transfer: false })).toBe(true);
  });

  it('returns false for is_direct_transfer === true (direct transfer)', () => {
    expect(isPlatformHeld({ is_direct_transfer: true })).toBe(false);
  });

  it('returns false for is_direct_transfer === null (unknown custody, fail-closed)', () => {
    expect(isPlatformHeld({ is_direct_transfer: null })).toBe(false);
  });

  it('CTO 601-A proof: !null === true but isPlatformHeld(null) === false', () => {
    expect(!null).toBe(true);
    expect(isPlatformHeld({ is_direct_transfer: null })).toBe(false);
  });
});

describe('#597 R3: computePlatformHeldTotals (production function)', () => {
  const mixedFees: PlatformFeeRow[] = [
    { transaction_amount: 10000, fee_total: 250, gateway_fee: 150, waived: false, is_direct_transfer: false },
    { transaction_amount: 5000,  fee_total: 125, gateway_fee: 75,  waived: false, is_direct_transfer: false },
    { transaction_amount: 8000,  fee_total: 0,   gateway_fee: 0,   waived: false, is_direct_transfer: true },
    { transaction_amount: 3000,  fee_total: 0,   gateway_fee: 0,   waived: false, is_direct_transfer: null },
    { transaction_amount: 2000,  fee_total: 50,  gateway_fee: 30,  waived: true,  is_direct_transfer: false },
  ];

  it('includes only platform-held fees in eligible', () => {
    const { eligible } = computePlatformHeldTotals(mixedFees);
    expect(eligible).toHaveLength(3);
    expect(eligible.every(f => f.is_direct_transfer === false)).toBe(true);
  });

  it('computes correct gross from platform-held fees only', () => {
    const { gross } = computePlatformHeldTotals(mixedFees);
    expect(gross).toBe(17000);
  });

  it('excludes waived fees from totalFees', () => {
    const { totalFees } = computePlatformHeldTotals(mixedFees);
    expect(totalFees).toBe(375);
  });

  it('includes all gateway fees from eligible rows', () => {
    const { totalGatewayFees } = computePlatformHeldTotals(mixedFees);
    expect(totalGatewayFees).toBe(255);
  });

  it('computes correct net payout', () => {
    const { gross, totalFees, totalGatewayFees } = computePlatformHeldTotals(mixedFees);
    expect(Math.max(0, gross - totalFees - totalGatewayFees)).toBe(16370);
  });

  it('handles all-null custody (zero eligible)', () => {
    const { eligible, gross } = computePlatformHeldTotals([
      { transaction_amount: 5000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: null },
    ]);
    expect(eligible).toHaveLength(0);
    expect(gross).toBe(0);
  });

  it('handles all-direct-transfer', () => {
    const { eligible } = computePlatformHeldTotals([
      { transaction_amount: 5000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: true },
    ]);
    expect(eligible).toHaveLength(0);
  });

  it('handles empty array', () => {
    const r = computePlatformHeldTotals([]);
    expect(r.eligible).toHaveLength(0);
    expect(r.gross).toBe(0);
    expect(r.totalFees).toBe(0);
    expect(r.totalGatewayFees).toBe(0);
  });

  it('handles all-platform-held', () => {
    const { eligible, gross } = computePlatformHeldTotals([
      { transaction_amount: 10000, fee_total: 250, gateway_fee: 150, waived: false, is_direct_transfer: false },
      { transaction_amount: 5000,  fee_total: 125, gateway_fee: 75,  waived: false, is_direct_transfer: false },
    ]);
    expect(eligible).toHaveLength(2);
    expect(gross).toBe(15000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Layer 2: Source-contract — all three consumers use isPlatformHeld
// ═══════════════════════════════════════════════════════════════════

describe('#597 R3: Source-contract — shared filter usage', () => {
  const autoSrc = readFile(AUTO_PAYOUT_PATH);
  const manualSrc = readFile(MANUAL_GENERATOR_PATH);
  const approvalSrc = readFile(APPROVAL_PATH);

  it('all three paths import isPlatformHeld from payout-custody', () => {
    for (const src of [autoSrc, manualSrc, approvalSrc]) {
      expect(src).toContain('isPlatformHeld');
      expect(src).toContain('payout-custody');
    }
  });

  it('all three paths call .filter(isPlatformHeld)', () => {
    for (const src of [autoSrc, manualSrc, approvalSrc]) {
      expect(src).toMatch(/\.filter\(isPlatformHeld\)/);
    }
  });

  it('none of the paths use inline is_direct_transfer checks', () => {
    for (const src of [autoSrc, manualSrc, approvalSrc]) {
      expect(src).not.toMatch(/filter\(\s*f\s*=>\s*.*is_direct_transfer/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Layer 3: Approval route error handling (601-B)
// ═══════════════════════════════════════════════════════════════════

describe('#597 R3: Approval route error handling', () => {
  const src = readFile(APPROVAL_PATH);

  it('destructures balanceError and returns 503', () => {
    expect(src).toContain('balanceError');
    expect(src).toMatch(/balanceError[\s\S]*?status:\s*503/);
  });

  it('destructures priorPayoutsError and returns 503', () => {
    expect(src).toContain('priorPayoutsError');
    expect(src).toMatch(/priorPayoutsError[\s\S]*?status:\s*503/);
  });
});
