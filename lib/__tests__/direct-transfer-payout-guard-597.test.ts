/**
 * #597 PR-B: Platform-held payout eligibility guard.
 *
 * Validates that both auto-payout and manual approval exclude
 * is_direct_transfer rows from payout calculations. Direct transfer
 * rows represent funds that went directly to the business's bank account
 * — Waaiio never held them and must not pay them out.
 *
 * This is a defense-in-depth guard. Auto-payout already filters
 * payout_mode = 'platform_managed', and current production direct transfer
 * rows only exist on direct_split businesses. But the invariant must be
 * structurally enforced to prevent double-payout if a platform_managed
 * business ever receives a direct bank transfer.
 *
 * Source-level behavioral tests — read the code and verify structure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTO_PAYOUT_PATH = join(process.cwd(), 'app/api/cron/auto-payout/route.ts');
const MANUAL_GENERATOR_PATH = join(process.cwd(), 'app/api/admin/payouts/generate/route.ts');
const APPROVAL_PATH = join(process.cwd(), 'app/api/admin/payouts/[id]/approve/route.ts');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('#597 PR-B: Direct transfer payout exclusion guard', () => {
  describe('Auto-payout cron', () => {
    const src = readFile(AUTO_PAYOUT_PATH);

    it('selects is_direct_transfer from platform_fees', () => {
      // The SELECT must include is_direct_transfer to enable filtering
      const selectMatches = src.match(/\.select\(['"](.*?)['"]\)/g) || [];
      const feeSelects = selectMatches.filter(m =>
        m.includes('transaction_amount') && m.includes('fee_total'),
      );
      expect(feeSelects.length).toBeGreaterThan(0);
      expect(feeSelects.some(s => s.includes('is_direct_transfer'))).toBe(true);
    });

    it('filters out is_direct_transfer rows before gross calculation', () => {
      // Must filter before summing transaction_amount into gross
      expect(src).toMatch(/filter\([^)]*!f\.is_direct_transfer/);
    });

    it('uses filtered fees for gross, not all fees', () => {
      // The gross calculation must use the filtered array, not the raw query result
      // After filtering, the variable name should differ from the raw query result
      const grossLine = src.match(/const gross = (\w+)\.reduce/);
      expect(grossLine).toBeTruthy();
      const grossSource = grossLine![1];
      // The source variable for gross should be the filtered array (fees),
      // not the raw batch result (allFeeRows / allFees)
      expect(grossSource).toBe('fees');
    });
  });

  describe('Manual payout generator', () => {
    const src = readFile(MANUAL_GENERATOR_PATH);

    it('selects is_direct_transfer from platform_fees', () => {
      expect(src).toContain('is_direct_transfer');
      const selectMatches = src.match(/\.select\(['"](.*?)['"]\)/g) || [];
      const feeSelects = selectMatches.filter(m =>
        m.includes('transaction_amount') && m.includes('is_direct_transfer'),
      );
      expect(feeSelects.length).toBeGreaterThan(0);
    });

    it('filters out is_direct_transfer rows', () => {
      expect(src).toMatch(/filter\([^)]*!f\.is_direct_transfer/);
    });
  });

  describe('Payout approval balance check', () => {
    const src = readFile(APPROVAL_PATH);

    it('selects is_direct_transfer from platform_fees', () => {
      const selectMatches = src.match(/\.select\(['"](.*?)['"]\)/g) || [];
      const feeSelects = selectMatches.filter(m =>
        m.includes('transaction_amount') && m.includes('fee_total'),
      );
      expect(feeSelects.length).toBeGreaterThan(0);
      expect(feeSelects.some(s => s.includes('is_direct_transfer'))).toBe(true);
    });

    it('filters out is_direct_transfer rows before balance calculation', () => {
      expect(src).toMatch(/filter\([^)]*!f\.is_direct_transfer/);
    });

    it('uses filtered fees for totalEarned, not raw query result', () => {
      // totalEarned must be computed from the filtered array
      const earnedLine = src.match(/const totalEarned = (\w+)\.reduce/);
      expect(earnedLine).toBeTruthy();
      const earnedSource = earnedLine![1];
      // Must NOT be balancePayments (raw query), must be a filtered variable
      expect(earnedSource).not.toBe('balancePayments');
      // The filtered variable name should indicate platform-held only
      expect(earnedSource).toContain('platform');
    });
  });

  describe('Cross-path consistency', () => {
    const autoSrc = readFile(AUTO_PAYOUT_PATH);
    const manualSrc = readFile(MANUAL_GENERATOR_PATH);
    const approvalSrc = readFile(APPROVAL_PATH);

    it('all three paths filter is_direct_transfer', () => {
      for (const src of [autoSrc, manualSrc, approvalSrc]) {
        expect(src).toContain('is_direct_transfer');
        expect(src).toMatch(/filter\([^)]*!f\.is_direct_transfer|filter\([^)]*!.*is_direct_transfer/);
      }
    });

    it('none of the paths include direct transfer in gross/earned', () => {
      // Verify the invariant: direct transfer funds must never be in the payout pool
      // All three paths must have the filter BEFORE the reduce that computes gross/earned
      for (const src of [autoSrc, manualSrc, approvalSrc]) {
        const filterIdx = src.search(/filter\([^)]*is_direct_transfer/);
        const grossReduceIdx = src.search(/\.reduce\(\(s(um)?, f\) => s(um)? \+ \(f\.transaction_amount/);
        if (grossReduceIdx > -1) {
          expect(filterIdx).toBeLessThan(grossReduceIdx);
        }
      }
    });
  });
});
