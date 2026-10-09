/**
 * Finance UI Truth Tests (#595)
 *
 * Verifies the corrections from Phase B PR 1:
 * 1. Query error state — failures produce degraded state, not zeros
 * 2. No cross-currency summation for ranking or bar widths
 * 3. Payment volume labels (not "Revenue")
 * 4. Payout country filtering
 * 5. Dashboard category display gate works without cross-currency field
 * 6. Payout transfer method allowlist excludes flutterwave_transfer
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Source file readers ──
const rootDir = join(__dirname, '..', '..');
const financeSource = readFileSync(join(rootDir, 'admin', 'src', 'pages', 'Finance.tsx'), 'utf-8');
const dashboardSource = readFileSync(join(rootDir, 'admin', 'src', 'pages', 'Dashboard.tsx'), 'utf-8');
const payoutsSource = readFileSync(join(rootDir, 'admin', 'src', 'pages', 'Payouts.tsx'), 'utf-8');

describe('Finance.tsx — query error state (#595 F-003)', () => {
  it('tracks query errors in state', () => {
    expect(financeSource).toContain('queryErrors');
    expect(financeSource).toContain("setQueryErrors(errors)");
  });

  it('detects individual query failures', () => {
    expect(financeSource).toContain("if (paymentsRes.error) errors.push('payments')");
    expect(financeSource).toContain("if (feesRes.error) errors.push('platform fees')");
    expect(financeSource).toContain("if (payoutsRes.error) errors.push('payouts')");
    expect(financeSource).toContain("if (refundsRes.error) errors.push('refunds')");
    expect(financeSource).toContain("if (bizRes.error) errors.push('businesses')");
    expect(financeSource).toContain("if (subsRes.error) errors.push('subscriptions')");
  });

  it('shows degraded banner when queries fail', () => {
    expect(financeSource).toContain('Data incomplete');
    expect(financeSource).toContain('some queries failed');
    expect(financeSource).toContain('Do not use these figures for financial decisions');
  });

  it('disables CSV export when data is incomplete', () => {
    expect(financeSource).toContain('disabled={hasQueryErrors}');
    expect(financeSource).toContain('if (hasQueryErrors) return');
  });

  it('shows partial data notice', () => {
    expect(financeSource).toContain('Totals may be incomplete for large datasets');
  });
});

describe('Finance.tsx — no cross-currency summation (#595 F-001)', () => {
  it('does not sum amounts across currencies for category ranking', () => {
    // The old pattern: Object.values(amounts).reduce((s, a) => s + a, 0) used for sorting
    // Must NOT appear in the categoryVolume computation
    const categorySection = financeSource.slice(
      financeSource.indexOf('Category payment volume breakdown'),
      financeSource.indexOf('maxCatTxCount'),
    );
    expect(categorySection).not.toContain('.reduce((s, a) => s + a, 0)');
  });

  it('ranks categories by transaction count instead', () => {
    expect(financeSource).toContain('txCount');
    expect(financeSource).toContain('.sort((a, b) => b.txCount - a.txCount)');
  });

  it('uses transaction count for bar widths', () => {
    expect(financeSource).toContain('(txCount / maxCatTxCount)');
    // Must NOT use the old cross-currency total for bar widths
    expect(financeSource).not.toContain('(total / maxCatRevenue)');
  });
});

describe('Finance.tsx — correct labels (#595 F-002)', () => {
  it('labels category section as Payment Volume, not Revenue', () => {
    expect(financeSource).toContain('Payment Volume by Business Category');
    expect(financeSource).not.toContain('>Revenue by Business Category<');
  });

  it('explains ranking method in subtitle', () => {
    expect(financeSource).toContain('Ranked by transaction count');
  });
});

describe('Finance.tsx — payout country filtering (#595 F-006)', () => {
  it('selects business_id in payout query', () => {
    expect(financeSource).toContain("'net_amount, platform_fee, business_id, currency, status, created_at'");
  });

  it('applies matchesCountry to payout filter', () => {
    expect(financeSource).toContain('payouts.filter(p => inRange(p.created_at) && matchesCountry(p.business_id))');
  });

  it('includes business_id in BusinessPayout interface', () => {
    const interfaceSection = financeSource.slice(
      financeSource.indexOf('interface BusinessPayout'),
      financeSource.indexOf('interface Refund'),
    );
    expect(interfaceSection).toContain('business_id: string');
  });
});

describe('Dashboard.tsx — no cross-currency derived field (#595 D-001)', () => {
  it('does not compute cross-currency revenue total in category breakdown', () => {
    const breakdownSection = dashboardSource.slice(
      dashboardSource.indexOf('setCategoryBreakdown'),
      dashboardSource.indexOf('setCategoryBreakdown') + 500,
    );
    expect(breakdownSection).not.toContain("Object.values(data.revenueByCurrency).reduce");
  });

  it('does not have a revenue field in category state type', () => {
    const stateType = dashboardSource.slice(
      dashboardSource.indexOf('categoryBreakdown, setCategoryBreakdown'),
      dashboardSource.indexOf('categoryBreakdown, setCategoryBreakdown') + 200,
    );
    expect(stateType).not.toContain('revenue: number');
  });

  it('uses per-currency check for display gate', () => {
    expect(dashboardSource).toContain('Object.values(cat.revenueByCurrency).some(a => a > 0)');
    expect(dashboardSource).not.toContain('cat.revenue > 0');
  });

  it('still sorts by business count', () => {
    expect(dashboardSource).toContain('.sort((a, b) => b.count - a.count)');
  });
});

describe('Payouts.tsx — transfer method allowlist (#595 PO-001)', () => {
  it('does not offer flutterwave_transfer as an option', () => {
    expect(payoutsSource).not.toContain('flutterwave_transfer');
  });

  it('offers only the four supported transfer methods', () => {
    expect(payoutsSource).toContain('value="manual_bank"');
    expect(payoutsSource).toContain('value="manual_cash"');
    expect(payoutsSource).toContain('value="paystack_transfer"');
    expect(payoutsSource).toContain('value="stripe_transfer"');
  });
});

describe('Payout approve route — transfer method server allowlist', () => {
  it('server allowlist matches UI options (no flutterwave_transfer)', () => {
    const routeSource = readFileSync(
      join(rootDir, 'app', 'api', 'admin', 'payouts', '[id]', 'approve', 'route.ts'),
      'utf-8',
    );
    expect(routeSource).toContain("'paystack_transfer'");
    expect(routeSource).toContain("'stripe_transfer'");
    expect(routeSource).toContain("'manual_bank'");
    expect(routeSource).toContain("'manual_cash'");
    expect(routeSource).not.toContain("'flutterwave_transfer'");
  });
});
