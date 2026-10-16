/**
 * SELECT-side audit: every route that computes payout or held totals from
 * platform_fees must include all fields required by computePlatformHeldTotals.
 *
 * Required fields:
 *   - transaction_amount: basis for gross
 *   - fee_total: non-waived platform fee deduction
 *   - gateway_fee: gateway cost deduction
 *   - waived: controls whether fee_total is included
 *   - is_direct_transfer: custody classification (fail-closed === false)
 *
 * If any field is absent, computePlatformHeldTotals silently uses defaults
 * (0 / false / null) and produces incorrect payout amounts.
 *
 * This test reads each route as source text and fails immediately if a field
 * is removed from any platform_fees query.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

/**
 * For a given source file, find every `.from('platform_fees')` block and
 * return the content of the first `.select(...)` call that follows it.
 * Returns null if no such block is found.
 */
function extractPlatformFeesSelects(src: string): string[] {
  const results: string[] = [];
  // Match from('platform_fees') followed (possibly across newlines) by .select('...')
  const re = /\.from\('platform_fees'\)([\s\S]*?)\.select\('([^']+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    results.push(m[2]);
  }
  return results;
}

const PAYOUT_ROUTES: Array<{ file: string; desc: string }> = [
  {
    file: 'app/api/admin/payouts/generate/route.ts',
    desc: 'admin payout generate',
  },
  {
    file: 'app/api/cron/auto-payout/route.ts',
    desc: 'cron auto-payout',
  },
  {
    file: 'app/api/admin/payouts/[id]/approve/route.ts',
    desc: 'admin payout approve (balance verification)',
  },
  {
    file: 'app/api/payouts/balance/route.ts',
    desc: 'merchant payout balance',
  },
  {
    file: 'app/api/cron/payout-nudge/route.ts',
    desc: 'cron payout nudge',
  },
];

const REQUIRED_FIELDS = ['transaction_amount', 'fee_total', 'gateway_fee', 'waived', 'is_direct_transfer'];

describe('payout platform_fees SELECT-side audit', () => {
  for (const { file, desc } of PAYOUT_ROUTES) {
    it(`${desc}: platform_fees select includes all computePlatformHeldTotals fields`, () => {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      const selects = extractPlatformFeesSelects(src);
      expect(selects.length).toBeGreaterThan(0);

      for (const field of REQUIRED_FIELDS) {
        const missingField = selects.filter(s => !s.includes(field));
        expect(
          missingField,
          `${file}: found platform_fees select(s) without '${field}': ${JSON.stringify(missingField)}`,
        ).toHaveLength(0);
      }
    });
  }
});
