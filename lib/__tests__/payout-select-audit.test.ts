/**
 * SELECT-side audit: every route that computes payout or held totals from
 * platform_fees must include is_direct_transfer in its select list.
 *
 * If is_direct_transfer is absent from the select, the getPayableFeeRows
 * filter (=== false) or inline equivalent cannot operate — direct-transfer
 * fees (funds the platform never held) would silently inflate balances.
 *
 * This test reads each route as source text and asserts that the
 * platform_fees .select() call includes is_direct_transfer.
 * It fails immediately if the field is removed from any query.
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

describe('payout platform_fees SELECT-side audit', () => {
  for (const { file, desc } of PAYOUT_ROUTES) {
    it(`${desc}: platform_fees select includes is_direct_transfer`, () => {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      const selects = extractPlatformFeesSelects(src);
      expect(selects.length).toBeGreaterThan(0);
      const missing = selects.filter(s => !s.includes('is_direct_transfer'));
      expect(
        missing,
        `${file}: found platform_fees select(s) without is_direct_transfer: ${JSON.stringify(missing)}`,
      ).toHaveLength(0);
    });
  }
});
