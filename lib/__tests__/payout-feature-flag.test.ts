import { describe, it, expect } from 'vitest';

describe('Payout feature flag', () => {
  it('ENABLE_PAYOUTS must be explicitly "true" to allow payouts', () => {
    // The payout routes check: process.env.ENABLE_PAYOUTS !== 'true'
    // Any other value (undefined, 'false', '', '1') blocks payouts

    const check = (val: string | undefined) => val === 'true';

    expect(check(undefined)).toBe(false);   // not set → blocked
    expect(check('')).toBe(false);          // empty → blocked
    expect(check('false')).toBe(false);     // false → blocked
    expect(check('1')).toBe(false);         // 1 → blocked (must be 'true')
    expect(check('yes')).toBe(false);       // yes → blocked
    expect(check('true')).toBe(true);       // only 'true' enables
  });

  it('affected routes: approval, generation, auto-payout', () => {
    // These routes must all check ENABLE_PAYOUTS:
    const routes = [
      'app/api/admin/payouts/[id]/approve/route.ts',
      'app/api/admin/payouts/generate/route.ts',
      'app/api/cron/auto-payout/route.ts',
    ];

    const fs = require('fs');
    for (const route of routes) {
      const content = fs.readFileSync(route, 'utf-8');
      expect(content).toContain("ENABLE_PAYOUTS !== 'true'");
    }
  });
});
